// The per-IP limit on sign-in, sign-up and password reset is 20 attempts per 15
// minutes. A real browser test suite signs in and registers about that many times
// from one address, so CREDENTIAL_RATE_MAX can raise it, the same way
// FEEDBACK_RATE_MAX does for the feedback form. It must only ever be a positive
// number: anything else (zero, negative, text) keeps the default rather than
// switching the brute-force protection off.
const request = require('supertest');

// Each call builds the app fresh, so it reads the environment as it is right now.
const appWith = (value) => {
  if (value === undefined) delete process.env.CREDENTIAL_RATE_MAX;
  else process.env.CREDENTIAL_RATE_MAX = value;
  let app;
  jest.isolateModules(() => {
    app = require('../src/app');
  });
  return app;
};
// An invalid body is refused with 422 before any work is done, so these are cheap;
// the limiter sits in front of that and counts every request.
const hit = (app, n) => Promise.all(Array.from({ length: n }, () => request(app).post('/api/auth/login').send({}))).then((rs) => rs.map((r) => r.status));
const countOf = (statuses, code) => statuses.filter((s) => s === code).length;

describe('CREDENTIAL_RATE_MAX', () => {
  afterAll(() => {
    delete process.env.CREDENTIAL_RATE_MAX;
  });

  test('the default is 20 per window', async () => {
    const statuses = await hit(appWith(undefined), 25);
    expect(countOf(statuses, 429)).toBe(5);
    expect(countOf(statuses, 422)).toBe(20);
  });

  test('a positive value replaces it', async () => {
    const statuses = await hit(appWith('3'), 6);
    expect(countOf(statuses, 422)).toBe(3);
    expect(countOf(statuses, 429)).toBe(3);
  });

  test.each(['0', '-5', 'abc', ''])('%j keeps the default instead of switching the limit off', async (bad) => {
    const statuses = await hit(appWith(bad), 25);
    expect(countOf(statuses, 422)).toBe(20);
    expect(countOf(statuses, 429)).toBe(5);
  });
});
