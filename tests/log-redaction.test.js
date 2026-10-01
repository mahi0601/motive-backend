// Request logs go to Render's dashboard and Better Stack/Logtail, where more
// people and third parties can read them than can read the database. They must
// never contain anything that works as a credential:
//   • the refresh-token cookie in a Set-Cookie response header (30-day session),
//   • secret-bearing URLs — the public status-page token, invite tokens, the
//     Stripe checkout-session id, and query strings (?code=, ?state=, ?csrf=),
//   • request headers such as Authorization, Cookie, X-CSRF-Token.
// pino-http's default serializers log all of that, so the app uses
// createHttpLogger() from config/logger.js instead.
const express = require('express');
const pino = require('pino');
const pinoHttp = require('pino-http');
const request = require('supertest');
const { pinoOptions, scrubUrl, createHttpLogger } = require('../src/config/logger');

// An in-memory pino destination: every log line the instance writes.
function memoryLogger() {
  const lines = [];
  const stream = { write: (chunk) => lines.push(String(chunk)) };
  // Same redaction config as production, but always at info level and no transport.
  const instance = pino({ ...pinoOptions, level: 'info' }, stream);
  return { instance, text: () => lines.join('') };
}

const SECRETS = {
  refresh: 'SECRETREFRESHJWT.abc.def',
  csrf: 'SECRETCSRFNONCE',
  statusToken: 'SECRETSTATUSTOKEN0123456789abcdef',
  inviteToken: 'SECRETINVITETOKEN0123456789abcdef',
  checkoutSession: 'cs_test_SECRETCHECKOUTSESSION',
  oauthCode: 'SECRETOAUTHCODE',
  oauthState: 'SECRETOAUTHSTATE',
  bearer: 'SECRETBEARERACCESSTOKEN',
};

function buildApp(makeMiddleware) {
  const app = express();
  app.use(makeMiddleware());
  // A login-like route: hands back the refresh cookie and a csrf redirect, exactly what leaks today.
  app.post('/api/auth/login', (req, res) => {
    res.cookie('motive_rt', SECRETS.refresh, { httpOnly: true, path: '/api/auth' });
    res.set('X-Csrf-Token', SECRETS.csrf);
    res.json({ success: true });
  });
  app.get('/api/auth/google/callback', (req, res) => res.redirect(`http://localhost:5173/dashboard?csrf=${SECRETS.csrf}`));
  app.get('/api/status/:token', (req, res) => res.status(404).json({ success: false }));
  app.get('/api/invites/:token', (req, res) => res.status(404).json({ success: false }));
  app.post('/api/invites/:token/accept', (req, res) => res.json({ success: true }));
  app.get('/api/payments/session/:id', (req, res) => res.json({ success: true }));
  app.get('/api/tasks', (req, res) => res.json({ items: [] }));
  return app;
}

async function exercise(app) {
  await request(app).post('/api/auth/login').set('Authorization', `Bearer ${SECRETS.bearer}`).set('Cookie', `motive_rt=${SECRETS.refresh}`).set('X-CSRF-Token', SECRETS.csrf);
  await request(app).get(`/api/auth/google/callback?code=${SECRETS.oauthCode}&state=${SECRETS.oauthState}`);
  await request(app).get(`/api/status/${SECRETS.statusToken}`);
  await request(app).get(`/api/invites/${SECRETS.inviteToken}`);
  await request(app).post(`/api/invites/${SECRETS.inviteToken}/accept`);
  await request(app).get(`/api/payments/session/${SECRETS.checkoutSession}`);
  await request(app).get('/api/tasks?workspaceId=ws1&page=2');
}

describe('scrubUrl', () => {
  test.each([
    ['/api/status/SECRET', '/api/status/[redacted]'],
    ['/api/status/SECRET?x=1', '/api/status/[redacted]'],
    ['/api/invites/SECRET', '/api/invites/[redacted]'],
    ['/api/invites/SECRET/accept', '/api/invites/[redacted]/accept'],
    ['/api/invites/SECRET/decline?x=1#frag', '/api/invites/[redacted]/decline'],
    ['/api/payments/session/cs_test_123', '/api/payments/session/[redacted]'],
    ['/api/auth/google/callback?code=abc&state=def', '/api/auth/google/callback'],
    ['/api/tasks?page=2&limit=50', '/api/tasks'],
    ['/api/tasks/ckabc123', '/api/tasks/ckabc123'],
    ['/api/health', '/api/health'],
  ])('%s -> %s', (input, expected) => {
    expect(scrubUrl(input)).toBe(expected);
  });

  test('is case-insensitive about the token routes, and tolerates odd input', () => {
    expect(scrubUrl('/API/Status/SECRET')).toBe('/API/Status/[redacted]');
    expect(scrubUrl(undefined)).toBe('');
    expect(scrubUrl(null)).toBe('');
    expect(scrubUrl('')).toBe('');
  });
});

describe('request logging', () => {
  test('CONTROL: the previous setup (default pino-http + the old redact list) DOES leak — proves this harness can see leaks', async () => {
    // The redaction list as it was before this fix: authorization/cookie request headers only.
    const lines = [];
    const legacy = pino(
      { level: 'info', redact: { paths: ['req.headers.authorization', 'req.headers.cookie', '*.password', '*.token', '*.email', 'email'], censor: '[redacted]' } },
      { write: (chunk) => lines.push(String(chunk)) }
    );
    const text = () => lines.join('');
    await exercise(buildApp(() => pinoHttp({ logger: legacy })));
    const out = text();
    expect(out).toContain(SECRETS.refresh); // Set-Cookie response header
    expect(out).toContain(SECRETS.statusToken); // URL path
    expect(out).toContain(SECRETS.inviteToken); // URL path
    expect(out).toContain(SECRETS.oauthCode); // query string
    expect(out).toContain(SECRETS.csrf); // x-csrf-token header
  });

  test('createHttpLogger() output contains no credential of any kind', async () => {
    const { instance, text } = memoryLogger();
    await exercise(buildApp(() => createHttpLogger(instance)));
    const out = text();

    for (const [name, secret] of Object.entries(SECRETS)) {
      expect({ name, leaked: out.includes(secret) }).toEqual({ name, leaked: false });
    }
    expect(out).not.toMatch(/set-cookie/i);
    expect(out).not.toMatch(/motive_rt/);
    expect(out).not.toMatch(/"authorization"/i);
  });

  test('still records what is useful for operations and incident response', async () => {
    const { instance, text } = memoryLogger();
    await exercise(buildApp(() => createHttpLogger(instance)));
    const records = text().trim().split('\n').map((l) => JSON.parse(l));

    const status = records.find((r) => r.req.url.startsWith('/api/status/'));
    expect(status.req.method).toBe('GET');
    expect(status.req.url).toBe('/api/status/[redacted]');
    expect(status.res.statusCode).toBe(404);
    expect(typeof status.responseTime).toBe('number');
    expect(status.req.id).toBeDefined();

    const login = records.find((r) => r.req.url === '/api/auth/login');
    expect(login.res.statusCode).toBe(200);
    expect(records.find((r) => r.req.url === '/api/tasks')).toBeTruthy();
    expect(records).toHaveLength(7);
  });

  test('structured redaction covers token-shaped fields logged by hand', () => {
    const { instance, text } = memoryLogger();
    instance.info(
      {
        accessToken: 'SECRETACCESS',
        refreshToken: 'SECRETREFRESH2',
        csrfToken: 'SECRETCSRF2',
        user: { email: 'a@b.test', password: 'SECRETPW' },
        req: { headers: { 'x-csrf-token': 'SECRETHEADERCSRF', 'stripe-signature': 'SECRETSIG', authorization: 'SECRETAUTH', cookie: 'SECRETCOOKIE' } },
        res: { headers: { 'set-cookie': ['SECRETSETCOOKIE'], location: 'http://x/?csrf=SECRETLOC' } },
        err: { code: 'P2002' },
      },
      'manual log'
    );
    const out = text();
    for (const s of ['SECRETACCESS', 'SECRETREFRESH2', 'SECRETCSRF2', 'a@b.test', 'SECRETPW', 'SECRETHEADERCSRF', 'SECRETSIG', 'SECRETAUTH', 'SECRETCOOKIE', 'SECRETSETCOOKIE', 'SECRETLOC']) {
      expect({ s, leaked: out.includes(s) }).toEqual({ s, leaked: false });
    }
    // Error codes are diagnostic, not secret — must stay readable.
    expect(out).toContain('P2002');
  });

  test('the real app wires the safe logger (not the default one)', () => {
    // app.js must call createHttpLogger; guard against someone reverting to bare pinoHttp().
    const source = require('fs').readFileSync(require('path').join(__dirname, '../src/app.js'), 'utf8');
    expect(source).toMatch(/createHttpLogger/);
    expect(source).not.toMatch(/pinoHttp\s*\(/);
  });
});
