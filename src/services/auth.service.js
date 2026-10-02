const crypto = require('crypto');
const validator = require('validator');
const prisma = require('../config/prisma');
const AppError = require('../utils/AppError');
const config = require('../config/env');
const { verifyToken, signResetToken, signVerifyToken } = require('../utils/jwt.util');
const { hashPassword, comparePassword } = require('../utils/password.util');
const tokenService = require('./token.service');
const sessionService = require('./session.service');
const audit = require('./audit.service');
const analytics = require('./analytics.service');
const emailService = require('./email.service');
const logger = require('../config/logger');

// A plain expired token is routine — every returning user's access token
// naturally expires and gets refreshed, so logging that at `warn` would be
// noisy, low-signal noise on nearly every page load. A token that's invalid
// for any *other* reason (bad signature, malformed, wrong secret) is a
// different, more interesting signal — possible tampering or a client bug —
// so that's what actually gets a `warn`; routine expiry stays `debug`.
function logTokenFailure(event, err, context) {
  if (err.name === 'TokenExpiredError') {
    logger.debug(`${event} (expired)`, context);
  } else {
    logger.warn(`${event} (invalid)`, { ...context, reason: err.message });
  }
}

// Password is globally omitted by the Prisma client (see config/prisma.js),
// so any `user` object here is already safe to send to the client as-is.
const result = async (user, ctx) => ({
  user,
  ...(await tokenService.issueTokens(user, ctx)),
});

// Proof that an account controls its address. Sent best-effort: a mail outage
// must not stop someone registering (they can ask for another link).
const sendVerificationEmail = async (user) => {
  const url = `${config.frontendUrl}/verify-email?token=${signVerifyToken(user.id, user.email)}`;
  await emailService.sendEmail({
    to: user.email,
    subject: 'Confirm your email for Clientglass',
    html: `<p>Confirm this is your email address so you can invite teammates to Clientglass.</p>
<p><a href="${url}">Confirm my email</a>. This link expires in 24 hours.</p>
<p>If you didn't create a Clientglass account, you can safely ignore this email.</p>`,
  });
};

exports.verifyEmail = async (token) => {
  let payload;
  try {
    payload = verifyToken(token);
  } catch (err) {
    logTokenFailure('Email verification token rejected', err);
    throw AppError.badRequest('This confirmation link is invalid or has expired.');
  }
  if (payload.type !== 'verify') throw AppError.badRequest('This confirmation link is invalid or has expired.');

  const user = await prisma.user.findUnique({ where: { id: payload.id } });
  if (!user || user.email.toLowerCase() !== payload.email) {
    throw AppError.badRequest('This confirmation link is invalid or has expired.');
  }
  if (!user.emailVerifiedAt) {
    await prisma.user.update({ where: { id: user.id }, data: { emailVerifiedAt: new Date() } });
    await audit.record({ type: 'email_verified', actorId: user.id, meta: { method: 'link' } });
  }
};

exports.resendVerification = async (userId) => {
  const user = await prisma.user.findUnique({ where: { id: userId } });
  if (!user || user.emailVerifiedAt) return;
  await sendVerificationEmail(user);
};

exports.register = async ({ name, email, password }, ctx) => {
  const existing = await prisma.user.findUnique({ where: { email } });
  if (existing) throw AppError.conflict('Email already in use');

  const user = await prisma.user.create({
    data: { name, email, password: await hashPassword(password) },
  });
  await sendVerificationEmail(user);
  await analytics.track('signup', { userId: user.id });
  return result(user, ctx);
};

// A real bcrypt hash of a random string nobody knows. When there is no real hash
// to compare against (unknown email, or a Google-only account), the comparison is
// run against this anyway, so those requests take as long as a wrong password on
// a real account and the response time does not reveal which emails are
// registered. Its result is ignored.
let dummyHashPromise;
const dummyHash = () => (dummyHashPromise ||= hashPassword(crypto.randomBytes(24).toString('hex')));

exports.login = async ({ email, password }, ctx) => {
  // Password is globally omitted — opt back in just for this check.
  const user = await prisma.user.findUnique({ where: { email }, omit: { password: false } });
  // No password set → a Google-only account; there's nothing real to compare
  // against (and bcrypt.compare would throw on a null hash, not just fail).
  if (!user || !user.password) {
    await comparePassword(typeof password === 'string' ? password : '', await dummyHash());
    // Unknown address or a Google-only account: recorded without the address.
    await audit.record({ type: 'login_failed', targetUserId: user?.id });
    throw AppError.unauthorized('Invalid credentials');
  }
  const valid = await comparePassword(password, user.password);
  if (!valid) {
    await audit.record({ type: 'login_failed', targetUserId: user.id });
    throw AppError.unauthorized('Invalid credentials');
  }

  delete user.password;
  await audit.record({ type: 'login_success', actorId: user.id, meta: { method: 'password' } });
  return result(user, ctx);
};

// Exchanges a Google OAuth `code` (from the /api/auth/google/callback
// redirect) for the user's Google profile, then finds-or-creates the
// matching local User by email — the same account-linking rule the rest of
// the app already uses for "who can be @mentioned"/workspace membership:
// email is the identity, not the login method. An existing password-based
// account signing in with Google for the first time just gets `googleId`
// attached; no separate "Google account" is created for the same email.
exports.loginWithGoogle = async (code, ctx) => {
  const tokenRes = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      code,
      client_id: config.google.clientId,
      client_secret: config.google.clientSecret,
      redirect_uri: config.google.redirectUri,
      grant_type: 'authorization_code',
    }),
  });
  if (!tokenRes.ok) throw AppError.unauthorized('Google sign-in failed');
  const { access_token: googleAccessToken } = await tokenRes.json();

  const profileRes = await fetch('https://www.googleapis.com/oauth2/v2/userinfo', {
    headers: { Authorization: `Bearer ${googleAccessToken}` },
  });
  if (!profileRes.ok) throw AppError.unauthorized('Google sign-in failed');
  const profile = await profileRes.json(); // { id, email, name, picture, verified_email }
  if (!profile.email) throw AppError.unauthorized('Your Google account has no email to sign in with.');
  // `verified_email` was named in this destructuring comment but never
  // actually checked — an account-linking flow (the `else if (!user.googleId)`
  // branch below) that trusts an *unverified* email is exactly how someone
  // registers `alice@x.com` at Google without owning it and gets silently
  // logged into the existing Clientglass account with that email.
  if (!profile.verified_email) {
    throw AppError.unauthorized('Your Google email address is not verified.');
  }

  // 1. Already linked → that account, whatever its email is now.
  let user = await prisma.user.findUnique({ where: { googleId: profile.id } });
  if (!user) {
    // 2. Same address as an existing account. Registration stores the
    //    validator-normalized email (Gmail dots/plus-tags folded), so look that
    //    form up too — otherwise `Dot.ty@gmail.com` creates a second account
    //    next to `dotty@gmail.com`. The raw form catches rows from before.
    const normalized = validator.normalizeEmail(profile.email) || profile.email;
    user = await prisma.user.findFirst({ where: { email: { in: [...new Set([normalized, profile.email])] } } });
  }

  if (!user) {
    // Google only returns addresses it has verified (checked above), so this
    // account has proven its email from the start.
    user = await prisma.user.create({
      data: {
        name: profile.name || profile.email.split('@')[0],
        email: validator.normalizeEmail(profile.email) || profile.email,
        googleId: profile.id,
        avatar: profile.picture || '',
        emailVerifiedAt: new Date(),
      },
    });
    await analytics.track('signup', { userId: user.id });
  } else if (!user.googleId) {
    // Linking to an account that already existed. If that account had already
    // proven its address, whoever set its password is its owner, and nothing
    // changes but the link. If it had NOT, anyone could have registered an
    // address they do not own with a password they chose, and the real owner is
    // only now proving ownership through Google — so that password is removed
    // (the owner can set a new one with "forgot password") and tokenVersion is
    // bumped to kill any session or refresh token already issued for it.
    const wasVerified = !!user.emailVerifiedAt;
    user = await prisma.user.update({
      where: { id: user.id },
      data: {
        googleId: profile.id,
        emailVerifiedAt: user.emailVerifiedAt || new Date(),
        ...(wasVerified ? {} : { password: null, tokenVersion: { increment: 1 } }),
      },
    });
    if (!wasVerified) {
      await sessionService.revokeAllForUser(user.id);
      require('../sockets/revoke').disconnectUser(user.id);
    }
    await audit.record({ type: 'google_linked', actorId: user.id, meta: { passwordRemoved: !wasVerified } });
  } else if (!user.emailVerifiedAt) {
    user = await prisma.user.update({ where: { id: user.id }, data: { emailVerifiedAt: new Date() } });
  }

  await audit.record({ type: 'login_success', actorId: user.id, meta: { method: 'google' } });
  return result(user, ctx);
};

// Native (Capacitor Android) OAuth hand-off — see the NativeExchangeCode
// model comment in schema.prisma for why this exists instead of just
// setting the refresh cookie: the system browser and the app's WebView are
// separate cookie jars, so that cookie never reaches the WebView.
// `codeChallenge` is the app's PKCE challenge (RFC 7636, S256) — see
// verifyPkce below. Without it the code alone would be a bearer credential
// sitting in a custom-scheme URL that any other installed app can also claim.
exports.createNativeExchangeCode = async (userId, codeChallenge) => {
  const code = crypto.randomBytes(32).toString('hex');
  await prisma.nativeExchangeCode.create({
    data: { code, userId, codeChallenge, expiresAt: new Date(Date.now() + 60_000) },
  });
  return code;
};

// base64url(sha256(verifier)) must equal the challenge stored at sign-in
// start. Constant-time comparison; both sides are fixed-length digests.
const verifyPkce = (verifier, challenge) => {
  if (typeof verifier !== 'string' || typeof challenge !== 'string') return false;
  const computed = Buffer.from(crypto.createHash('sha256').update(verifier).digest('base64url'));
  const expected = Buffer.from(challenge);
  return computed.length === expected.length && crypto.timingSafeEqual(computed, expected);
};

// `delete` on the unique `code` key is the atomicity: exactly one caller can
// ever successfully delete a given row, so a code can't be exchanged twice
// even under a concurrent retry/replay — no separate "mark as used" step to
// race against.
//
// The PKCE check runs AFTER that delete on purpose: a wrong verifier burns
// the code, so an interceptor gets exactly one guess and the legitimate app's
// own (correct) attempt then fails closed rather than racing the attacker.
exports.exchangeNativeCode = async (code, codeVerifier, ctx) => {
  let record;
  try {
    record = await prisma.nativeExchangeCode.delete({ where: { code } });
  } catch (err) {
    if (err.code === 'P2025') throw AppError.unauthorized('This sign-in link has expired — please try again.');
    throw err;
  }
  if (record.expiresAt < new Date()) {
    throw AppError.unauthorized('This sign-in link has expired — please try again.');
  }
  if (!verifyPkce(codeVerifier, record.codeChallenge)) {
    logger.warn('Native exchange rejected — PKCE verifier mismatch', { userId: record.userId });
    throw AppError.unauthorized('This sign-in link is not valid — please try again.');
  }

  const user = await prisma.user.findUnique({ where: { id: record.userId } });
  if (!user) throw AppError.unauthorized('User no longer exists');
  return result(user, ctx);
};

// Validate a refresh token and rotate it (new refresh token, new access
// token). Everything that decides validity lives in session.service.rotate:
// the session must exist, be unexpired and unrevoked, match the user's
// tokenVersion, and the token must be the current (or just-previous)
// generation. There is no per-request nonce — the cross-site defence for this
// endpoint is sameSite.middleware.js (custom header + Origin allowlist).
exports.refresh = async (refreshToken) => {
  if (!refreshToken) throw AppError.unauthorized('No refresh token');

  let payload;
  try {
    payload = verifyToken(refreshToken, 'refresh');
  } catch (err) {
    logTokenFailure('Refresh token rejected', err);
    throw AppError.unauthorized('Invalid refresh token');
  }
  if (payload.type !== 'refresh') throw AppError.unauthorized('Invalid token type');

  const { user, sid, gen } = await sessionService.rotate(payload);
  return {
    user,
    ...(await tokenService.issueTokens(user, { session: { id: sid }, gen })),
  };
};

// Revoke ALL refresh tokens for the user by bumping their version.
exports.revokeAll = async (userId) => {
  if (!userId) return;
  await prisma.user.update({ where: { id: userId }, data: { tokenVersion: { increment: 1 } } });
  await sessionService.revokeAllForUser(userId);
  require('../sockets/revoke').disconnectUser(userId);
  await audit.record({ type: 'logout_all', actorId: userId });
};

// Ends the session named by the refresh cookie (this browser/device only) —
// an expired/invalid/missing cookie is fine, logout still succeeds either way,
// it just has nothing to revoke. Cross-site forged calls are stopped before
// this runs, by sameSite.middleware.js.
exports.logout = async (refreshToken) => {
  if (!refreshToken) return;
  try {
    const payload = verifyToken(refreshToken, 'refresh');
    // An access token or password-reset token planted in the cookie slot must
    // not be able to end sessions.
    if (payload.type !== 'refresh') {
      logger.warn('Logout called with a non-refresh token', { type: payload.type });
      return;
    }
    // Only this browser's session ends; other devices stay signed in.
    if (typeof payload.sid === 'string') {
      await sessionService.revoke(payload.sid);
      await require('../sockets/revoke').disconnectSession(payload.id, payload.sid);
    }
  } catch (err) {
    // Nothing to revoke either way — logout still succeeds. Logged only for
    // the audit trail this had zero trace of before.
    logTokenFailure('Logout with an unusable refresh cookie', err);
  }
};

// Deliberately never reveals whether the email exists — the controller
// always returns the same generic response either way, so this only ever
// sends an email and never throws for "not found".
exports.forgotPassword = async (email) => {
  const user = await prisma.user.findUnique({ where: { email } });
  if (!user) return;

  const token = signResetToken(user.id, user.tokenVersion);
  const resetUrl = `${config.frontendUrl}/reset-password?token=${token}`;
  await emailService.sendEmail({
    to: user.email,
    subject: 'Reset your Clientglass password',
    html: `<p>Someone requested a password reset for your Clientglass account.</p>
<p><a href="${resetUrl}">Click here to set a new password</a>. This link expires in 30 minutes.</p>
<p>If you didn't request this, you can safely ignore this email.</p>`,
  });
};

exports.resetPassword = async (token, newPassword) => {
  let payload;
  try {
    payload = verifyToken(token);
  } catch (err) {
    logTokenFailure('Password reset token rejected', err);
    throw AppError.badRequest('This reset link is invalid or has expired.');
  }
  if (payload.type !== 'reset') throw AppError.badRequest('This reset link is invalid or has expired.');

  const user = await prisma.user.findUnique({ where: { id: payload.id } });
  // ver mismatch → link already used, or a session/logout since it was sent.
  if (!user || payload.ver !== user.tokenVersion) {
    throw AppError.badRequest('This reset link is invalid or has expired.');
  }

  // Bumps tokenVersion as part of the same write — the link (and every other
  // outstanding session) is invalidated the moment the password changes.
  await prisma.user.update({
    where: { id: user.id },
    // Completing a reset proves the address: the link only went to that inbox.
    data: { password: await hashPassword(newPassword), tokenVersion: { increment: 1 }, emailVerifiedAt: user.emailVerifiedAt || new Date() },
  });
  await sessionService.revokeAllForUser(user.id);
  require('../sockets/revoke').disconnectUser(user.id);
  await audit.record({ type: 'password_reset', actorId: user.id });
};
