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
const oauthStateCookieOptions = () => ({
  httpOnly: true,
  secure: config.cookie.secure,
  sameSite: config.cookie.sameSite,
  domain: config.cookie.domain,
  path: '/api/auth/google',
  maxAge: 5 * 60 * 1000, // just long enough for the Google consent round-trip
});

// Matches capacitor.config.json's `appId` — the custom scheme the Android
// app registers an intent-filter for (see AndroidManifest.xml).
const NATIVE_CALLBACK_URL = 'com.motive.app://oauth-callback';

// Set the refresh cookie and return { user, accessToken }. The access token is
// kept in memory by the client; the refresh token lives only in the httpOnly cookie.
const sendAuth = (res, status, { user, accessToken, refreshToken }) => {
  tokenService.setRefreshCookie(res, refreshToken);
  res.status(status).json({ success: true, user, accessToken });
};

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
  const data = await AuthService.refresh(token);
  sendAuth(res, 200, data);
});

// Revoke all refresh tokens for the user, then clear the cookie.
exports.logout = asyncHandler(async (req, res) => {
  const token = tokenService.readRefreshCookie(req);
  await AuthService.logout(token);
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
  res.cookie(OAUTH_STATE_COOKIE, nonce, oauthStateCookieOptions());

  const params = new URLSearchParams({
    client_id: config.google.clientId,
    redirect_uri: config.google.redirectUri,
    response_type: 'code',
    scope: 'openid email profile',
    prompt: 'select_account',
    state: `${nonce}.${mode}`,
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
  const expectedNonce = req.cookies?.[OAUTH_STATE_COOKIE];
  res.clearCookie(OAUTH_STATE_COOKIE, oauthStateCookieOptions());
  const [nonce, mode] = typeof state === 'string' ? state.split('.') : [];
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
      const exchangeCode = await AuthService.createNativeExchangeCode(data.user.id);
      return res.redirect(`${NATIVE_CALLBACK_URL}?code=${exchangeCode}`);
    }
    tokenService.setRefreshCookie(res, data.refreshToken);
    res.redirect(`${config.frontendUrl}/dashboard`);
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
  const { code } = req.body;
  if (!code) throw AppError.badRequest('Missing code');
  const data = await AuthService.exchangeNativeCode(code);
  sendAuth(res, 200, data);
});
