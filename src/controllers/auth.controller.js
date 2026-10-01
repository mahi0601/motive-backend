const crypto = require('crypto');
const AuthService = require('../services/auth.service');
const tokenService = require('../services/token.service');
const asyncHandler = require('../utils/asyncHandler');
const AppError = require('../utils/AppError');
const config = require('../config/env');
const logger = require('../config/logger');

// Short-lived, single-use cookie used only to verify that the `state` coming
// back on /google/callback was actually issued by OUR /google redirect, not
// crafted by an attacker (see googleRedirect/googleCallback below).
const OAUTH_STATE_COOKIE = 'motive_oauth_state';
const OAUTH_STATE_PATH = '/api/auth/google';
const OAUTH_STATE_MAX_AGE_MS = 5 * 60 * 1000; // just long enough for the Google consent round-trip
// Options for CLEARING the cookie: the same path/domain/flags it was set with,
// but deliberately WITHOUT maxAge — Express turns maxAge into a future expiry,
// so passing it to clearCookie() re-sets the cookie (blank, for another five
// minutes) instead of deleting it. Setting the cookie is written out inline in
// googleRedirect, not through a helper, so its httpOnly / secure flags are
// visible right at the res.cookie() call (static analysis can't see through a
// helper and reports them as missing).
const oauthStateClearOptions = () => ({
  httpOnly: true,
  secure: config.cookie.secure,
  sameSite: config.cookie.sameSite,
  domain: config.cookie.domain,
  path: OAUTH_STATE_PATH,
});

// Matches capacitor.config.json's `appId` — the custom scheme the Android
// app registers an intent-filter for (see AndroidManifest.xml).
const NATIVE_CALLBACK_URL = 'com.motive.app://oauth-callback';

// RFC 7636 code_challenge / code_verifier alphabet and length bounds.
const PKCE_PATTERN = /^[A-Za-z0-9_-]{43,128}$/;

// Set the refresh cookie and return { user, accessToken, csrfToken }. The
// access token and csrfToken are both kept in memory by the client; the
// refresh token lives only in the httpOnly cookie. csrfToken must come back
// as the X-CSRF-Token header on the next /refresh or /logout call — see
// jwt.util.js#signRefreshToken for why.
const sendAuth = (res, status, { user, accessToken, refreshToken, csrfToken }) => {
  tokenService.setRefreshCookie(res, refreshToken);
  res.status(status).json({ success: true, user, accessToken, csrfToken });
};

const readCsrfHeader = (req) => req.get('X-CSRF-Token');

exports.register = asyncHandler(async (req, res) => {
  const { name, email, password } = req.body;
  const data = await AuthService.register({ name, email, password });
  sendAuth(res, 201, data);
});

exports.login = asyncHandler(async (req, res) => {
  const { email, password } = req.body;
  const data = await AuthService.login({ email, password });
  sendAuth(res, 200, data);
});

// Silent refresh: read the cookie, rotate the pair, return a new access token.
exports.refresh = asyncHandler(async (req, res) => {
  const token = tokenService.readRefreshCookie(req);
  const data = await AuthService.refresh(token, readCsrfHeader(req));
  sendAuth(res, 200, data);
});

// Revoke all refresh tokens for the user, then clear the cookie.
exports.logout = asyncHandler(async (req, res) => {
  const token = tokenService.readRefreshCookie(req);
  await AuthService.logout(token, readCsrfHeader(req));
  tokenService.clearRefreshCookie(res);
  res.status(200).json({ success: true, message: 'Logged out' });
});

// Always the same generic response, whether or not the email is registered —
// otherwise this endpoint would let anyone enumerate which emails have accounts.
exports.forgotPassword = asyncHandler(async (req, res) => {
  await AuthService.forgotPassword(req.body.email);
  res.status(200).json({ success: true, message: 'If that email is registered, a reset link has been sent.' });
});

exports.resetPassword = asyncHandler(async (req, res) => {
  const { token, password } = req.body;
  await AuthService.resetPassword(token, password);
  res.status(200).json({ success: true, message: 'Password updated — you can now log in.' });
});

// Full top-level browser redirect to Google's consent screen — this can't be
// an AJAX call, the OAuth flow needs the actual address bar to navigate.
// `?native=1` (set by GoogleSignInButton.jsx when running inside the
// Capacitor app) is round-tripped through Google's opaque `state` param so
// googleCallback below knows which hand-off to use on the way back.
//
// `state` also carries a random nonce (not just the native/web flag), mirrored
// in a short-lived cookie set on THIS response. Without that nonce, `state`
// would be pure attacker-controlled input: an attacker can complete their own
// Google consent to get a legitimate `code` for THEIR OWN account, then send
// a victim a link straight to /google/callback?code=<their code>&state=web —
// the victim's browser would exchange it and get logged into the attacker's
// account (classic OAuth "login CSRF", RFC 6749 §10.12). Requiring the state
// to match a cookie only this server could have set on this browser blocks
// that, since the attacker can't plant that cookie in the victim's browser.
exports.googleRedirect = asyncHandler(async (req, res) => {
  if (!config.google.clientId) throw AppError.badRequest('Google sign-in is not configured.');
  const mode = req.query.native === '1' ? 'native' : 'web';
  const nonce = crypto.randomBytes(16).toString('hex');

  // Native flow only: the app's PKCE challenge rides in the server-set state
  // cookie (not the `state` param), so it can't be swapped by anyone who can
  // merely craft a callback URL. base64url(sha256) is always 43 characters;
  // the range allows other valid S256 encodings without accepting junk.
  let cookieValue = nonce;
  if (mode === 'native') {
    const challenge = req.query.code_challenge;
    if (typeof challenge !== 'string' || !PKCE_PATTERN.test(challenge)) {
      throw AppError.badRequest('Missing or invalid code_challenge.');
    }
    cookieValue = `${nonce}.${challenge}`;
  }
  res.cookie(OAUTH_STATE_COOKIE, cookieValue, {
    httpOnly: true,
    secure: config.cookie.secure,
    sameSite: config.cookie.sameSite,
    domain: config.cookie.domain,
    path: OAUTH_STATE_PATH,
    maxAge: OAUTH_STATE_MAX_AGE_MS,
  });

  // An invite token riding along on `?invite=` (see GoogleSignInButton.jsx —
  // Login/Register pass it through when the page itself was reached via an
  // invite link) so choosing "Continue with Google" doesn't silently drop
  // the invite the way it used to. It's inert extra data, not part of the
  // CSRF defense: the nonce+mode check below is what actually verifies this
  // state came from us. Raw invite tokens are hex (see
  // workspace.service.js#newInviteToken) — no dots, safe to append.
  const inviteToken = typeof req.query.invite === 'string' ? req.query.invite : '';
  const state = inviteToken ? `${nonce}.${mode}.${inviteToken}` : `${nonce}.${mode}`;

  const params = new URLSearchParams({
    client_id: config.google.clientId,
    redirect_uri: config.google.redirectUri,
    response_type: 'code',
    scope: 'openid email profile',
    prompt: 'select_account',
    state,
  });
  res.redirect(`https://accounts.google.com/o/oauth2/v2/auth?${params}`);
});

// Google redirects the browser back here with `?code=...&state=...`.
//
// Web flow: sets the same refresh cookie the normal login flow sets, then
// redirects to the frontend — AuthContext's own bootstrap-on-load effect
// (see context/AuthContext.jsx) picks the session up from that cookie via
// the existing silent-refresh call, exactly like reloading an already
// logged-in tab. No separate frontend "callback page" needed.
//
// Native flow (state=native): this response is still running inside the
// SYSTEM BROWSER (Custom Tabs), not the app's WebView — those are separate
// cookie jars, so setting the refresh cookie here would be invisible to the
// app. Instead, mint a short-lived one-time exchange code and hand it back
// via a custom-scheme deep link; the app's own appUrlOpen listener catches
// it and POSTs it to /api/auth/native-exchange, and THAT request (made by
// the WebView itself) is where the cookie actually lands correctly.
exports.googleCallback = asyncHandler(async (req, res) => {
  const { code, error, state } = req.query;

  // Verify `state` matches the nonce we set on THIS browser during
  // googleRedirect — see the comment there. Single-use: clear it regardless
  // of outcome so a captured callback URL can't be replayed either.
  const [expectedNonce, codeChallenge] = (req.cookies?.[OAUTH_STATE_COOKIE] || '').split('.');
  res.clearCookie(OAUTH_STATE_COOKIE, oauthStateClearOptions());
  const [nonce, mode, inviteToken] = typeof state === 'string' ? state.split('.') : [];
  const stateValid = !!expectedNonce && nonce === expectedNonce;
  const isNative = mode === 'native';
  // Default to the web failure page when state can't be trusted at all —
  // there's no verified signal yet for which flow this even was.
  const failureRedirect = stateValid && isNative
    ? `${NATIVE_CALLBACK_URL}?error=google`
    : `${config.frontendUrl}/login?error=google`;

  if (error || !code || !stateValid) return res.redirect(failureRedirect);

  try {
    const data = await AuthService.loginWithGoogle(code);
    if (isNative) {
      // A native callback with no stored challenge means the flow didn't start
      // through googleRedirect's native branch — refuse rather than mint a
      // code that nothing could ever verify.
      if (!codeChallenge) return res.redirect(failureRedirect);
      const exchangeCode = await AuthService.createNativeExchangeCode(data.user.id, codeChallenge);
      const nativeUrl = inviteToken
        ? `${NATIVE_CALLBACK_URL}?code=${exchangeCode}&invite=${inviteToken}`
        : `${NATIVE_CALLBACK_URL}?code=${exchangeCode}`;
      return res.redirect(nativeUrl);
    }
    tokenService.setRefreshCookie(res, data.refreshToken);
    // Same hand-off Login.jsx/Register.jsx already use for the email/password
    // path — land on the invite page (which now sees an authenticated user)
    // instead of /dashboard when this sign-in was reached via an invite link.
    //
    // `csrf` rides the redirect URL, the one channel that actually reaches
    // the frontend here — this is a top-level navigation, not an AJAX
    // response, so there's no JSON body to put it in the way sendAuth()
    // does for every other login path. AuthContext.jsx reads it once on
    // load and strips it from the address bar immediately. It's inert on
    // its own (the httpOnly refresh cookie is what actually authenticates
    // anything), and it's replaced by a fresh one from the very next
    // /refresh response either way — see jwt.util.js#signRefreshToken.
    const target = inviteToken ? `${config.frontendUrl}/invite/${inviteToken}` : `${config.frontendUrl}/dashboard`;
    res.redirect(`${target}${target.includes('?') ? '&' : '?'}csrf=${data.csrfToken}`);
  } catch (err) {
    // logger.error only reports to Sentry when err isn't an operational
    // AppError (see config/logger.js) — loginWithGoogle already throws
    // AppError.unauthorized for the routine "user denied consent"/"exchange
    // failed" cases, so this won't spam Sentry with those, only genuinely
    // unexpected failures.
    logger.error('Google sign-in failed', err);
    res.redirect(failureRedirect);
  }
});

// The app's appUrlOpen listener calls this with the code from the deep
// link — made from the WebView itself, so setRefreshCookie (inside
// sendAuth) actually persists in the app's own cookie storage this time.
exports.nativeExchange = asyncHandler(async (req, res) => {
  const { code, code_verifier: codeVerifier } = req.body;
  if (!code) throw AppError.badRequest('Missing code');
  if (typeof codeVerifier !== 'string' || !PKCE_PATTERN.test(codeVerifier)) {
    throw AppError.badRequest('Missing or invalid code_verifier');
  }
  const data = await AuthService.exchangeNativeCode(code, codeVerifier);
  sendAuth(res, 200, data);
});
