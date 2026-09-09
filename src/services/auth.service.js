const crypto = require('crypto');
const prisma = require('../config/prisma');
const AppError = require('../utils/AppError');
const config = require('../config/env');
const { verifyToken, signResetToken } = require('../utils/jwt.util');
const { hashPassword, comparePassword } = require('../utils/password.util');
const tokenService = require('./token.service');
const emailService = require('./email.service');

// Password is globally omitted by the Prisma client (see config/prisma.js),
// so any `user` object here is already safe to send to the client as-is.
const result = (user) => ({
  user,
  ...tokenService.issueTokens(user),
});

exports.register = async ({ name, email, password }) => {
  const existing = await prisma.user.findUnique({ where: { email } });
  if (existing) throw AppError.conflict('Email already in use');

  const user = await prisma.user.create({
    data: { name, email, password: await hashPassword(password) },
  });
  return result(user);
};

exports.login = async ({ email, password }) => {
  // Password is globally omitted — opt back in just for this check.
  const user = await prisma.user.findUnique({ where: { email }, omit: { password: false } });
  // No password set → a Google-only account; there's nothing to compare
  // against (and bcrypt.compare would throw on a null hash, not just fail).
  if (!user || !user.password) throw AppError.unauthorized('Invalid credentials');
  const valid = await comparePassword(password, user.password);
  if (!valid) throw AppError.unauthorized('Invalid credentials');

  delete user.password;
  return result(user);
};

// Exchanges a Google OAuth `code` (from the /api/auth/google/callback
// redirect) for the user's Google profile, then finds-or-creates the
// matching local User by email — the same account-linking rule the rest of
// the app already uses for "who can be @mentioned"/workspace membership:
// email is the identity, not the login method. An existing password-based
// account signing in with Google for the first time just gets `googleId`
// attached; no separate "Google account" is created for the same email.
exports.loginWithGoogle = async (code) => {
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

  let user = await prisma.user.findUnique({ where: { email: profile.email } });
  if (!user) {
    user = await prisma.user.create({
      data: {
        name: profile.name || profile.email.split('@')[0],
        email: profile.email,
        googleId: profile.id,
        avatar: profile.picture || '',
      },
    });
  } else if (!user.googleId) {
    user = await prisma.user.update({ where: { id: user.id }, data: { googleId: profile.id } });
  }

  return result(user);
};

// Native (Capacitor Android) OAuth hand-off — see the NativeExchangeCode
// model comment in schema.prisma for why this exists instead of just
// setting the refresh cookie: the system browser and the app's WebView are
// separate cookie jars, so that cookie never reaches the WebView.
exports.createNativeExchangeCode = async (userId) => {
  const code = crypto.randomBytes(32).toString('hex');
  await prisma.nativeExchangeCode.create({
    data: { code, userId, expiresAt: new Date(Date.now() + 60_000) },
  });
  return code;
};

// `delete` on the unique `code` key is the atomicity: exactly one caller can
// ever successfully delete a given row, so a code can't be exchanged twice
// even under a concurrent retry/replay — no separate "mark as used" step to
// race against.
exports.exchangeNativeCode = async (code) => {
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

  const user = await prisma.user.findUnique({ where: { id: record.userId } });
  if (!user) throw AppError.unauthorized('User no longer exists');
  return result(user);
};

// Validate a refresh token and rotate it (issue a fresh pair).
exports.refresh = async (refreshToken) => {
  if (!refreshToken) throw AppError.unauthorized('No refresh token');

  let payload;
  try {
    payload = verifyToken(refreshToken);
  } catch {
    throw AppError.unauthorized('Invalid refresh token');
  }
  if (payload.type !== 'refresh') throw AppError.unauthorized('Invalid token type');

  const user = await prisma.user.findUnique({ where: { id: payload.id } });
  if (!user) throw AppError.unauthorized('User no longer exists');

  // tokenVersion mismatch → token was revoked (logout / password change elsewhere).
  if (payload.ver !== user.tokenVersion) throw AppError.unauthorized('Refresh token revoked');

  return result(user);
};

// Revoke ALL refresh tokens for the user by bumping their version.
exports.revokeAll = async (userId) => {
  if (!userId) return;
  await prisma.user.update({ where: { id: userId }, data: { tokenVersion: { increment: 1 } } });
};

// Decode the refresh cookie (if any) just enough to revoke that user's
// sessions — an expired/invalid/missing cookie is fine, logout still
// succeeds either way, it just has nothing to revoke.
exports.logout = async (refreshToken) => {
  if (!refreshToken) return;
  try {
    const { id } = verifyToken(refreshToken);
    await exports.revokeAll(id);
  } catch {
    /* expired/invalid cookie — nothing to revoke */
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
    subject: 'Reset your Motive password',
    html: `<p>Someone requested a password reset for your Motive account.</p>
<p><a href="${resetUrl}">Click here to set a new password</a>. This link expires in 30 minutes.</p>
<p>If you didn't request this, you can safely ignore this email.</p>`,
  });
};

exports.resetPassword = async (token, newPassword) => {
  let payload;
  try {
    payload = verifyToken(token);
  } catch {
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
    data: { password: await hashPassword(newPassword), tokenVersion: { increment: 1 } },
  });
};
