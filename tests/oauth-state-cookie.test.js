// The short-lived cookie that ties a Google sign-in callback to the browser
// that started it (and, for the Android flow, carries the PKCE challenge). Its
// flags are security-relevant, and the code that sets it was restructured so
// they are visible at the call site — this pins the exact attributes.
jest.mock('../src/config/env', () => {
  const actual = jest.requireActual('../src/config/env');
  return {
    ...actual,
    google: { ...actual.google, clientId: 'test-client-id.apps.googleusercontent.com', redirectUri: 'http://localhost:8080/api/auth/google/callback' },
    cookie: { ...actual.cookie, secure: true, sameSite: 'none' },
  };
});

const request = require('supertest');
const app = require('../src/app');

const CHALLENGE = 'E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM'; // RFC 7636 appendix B example, 43 chars
const stateCookie = (res) => (res.headers['set-cookie'] || []).find((c) => c.startsWith('motive_oauth_state='));

describe('Google sign-in state cookie', () => {
  test('web flow: sets a short-lived, HttpOnly, Secure cookie scoped to the Google routes, holding only a nonce', async () => {
    const res = await request(app).get('/api/auth/google');

    expect(res.status).toBe(302);
    expect(res.headers.location).toMatch(/^https:\/\/accounts\.google\.com\//);

    const cookie = stateCookie(res);
    expect(cookie).toBeTruthy();
    expect(cookie).toMatch(/;\s*HttpOnly/i);
    expect(cookie).toMatch(/;\s*Secure/i);
    expect(cookie).toMatch(/;\s*SameSite=None/i);
    expect(cookie).toMatch(/;\s*Path=\/api\/auth\/google(;|$)/);
    expect(cookie).toMatch(/;\s*Max-Age=300(;|$)/);
    // A bare 32-hex nonce — no PKCE challenge in the web flow.
    expect(cookie.split(';')[0]).toMatch(/^motive_oauth_state=[0-9a-f]{32}$/);
  });

  test('native flow: the cookie also carries the PKCE challenge, after the nonce', async () => {
    const res = await request(app).get(`/api/auth/google?native=1&code_challenge=${CHALLENGE}`);

    expect(res.status).toBe(302);
    const cookie = stateCookie(res);
    expect(cookie).toMatch(/;\s*HttpOnly/i);
    expect(cookie).toMatch(/;\s*Secure/i);
    expect(cookie.split(';')[0]).toBe(`motive_oauth_state=${cookie.split(';')[0].split('=')[1].split('.')[0]}.${CHALLENGE}`);
  });

  test.each([
    ['missing', '/api/auth/google?native=1'],
    ['too short', '/api/auth/google?native=1&code_challenge=abc'],
    ['illegal characters', `/api/auth/google?native=1&code_challenge=${'!'.repeat(43)}`],
  ])('native flow with a %s code_challenge is rejected and sets no cookie', async (_label, url) => {
    const res = await request(app).get(url);
    expect(res.status).toBe(400);
    expect(stateCookie(res)).toBeUndefined();
  });

  test('the callback clears the cookie with the same path it was set with, even when it fails', async () => {
    const res = await request(app).get('/api/auth/google/callback?error=access_denied').set('Cookie', 'motive_oauth_state=abc');
    const cleared = (res.headers['set-cookie'] || []).find((c) => c.startsWith('motive_oauth_state='));
    expect(cleared).toBeTruthy();
    expect(cleared).toMatch(/Path=\/api\/auth\/google/);
    expect(cleared).toMatch(/Expires=Thu, 01 Jan 1970/);
  });
});
