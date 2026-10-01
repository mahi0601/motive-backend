const { scrubUrl, scrubEvent, scrubBreadcrumb } = require('../src/utils/sentryScrub');

const T = 'SECRETTOKEN0123456789';

describe('sentry scrubbing', () => {
  test.each([
    [`https://api.test/api/status/${T}`, 'https://api.test/api/status/[redacted]'],
    [`/api/invites/${T}/accept`, '/api/invites/[redacted]/accept'],
    [`/api/payments/session/cs_test_${T}`, '/api/payments/session/[redacted]'],
    [`/api/auth/google/callback?code=${T}&state=${T}&x=1`, '/api/auth/google/callback?code=%5Bredacted%5D&state=%5Bredacted%5D&x=1'],
    [`/api/tasks?page=2#frag`, '/api/tasks?page=2'],
  ])('scrubUrl %s', (input, expected) => expect(scrubUrl(input)).toBe(expected));

  test('an event carries no token, cookie or credential header after scrubbing', () => {
    const out = JSON.stringify(
      scrubEvent({
        request: {
          url: `https://api.test/api/status/${T}?code=${T}`,
          query_string: `code=${T}`,
          headers: { cookie: `motive_rt=${T}`, authorization: `Bearer ${T}`, 'x-csrf-token': T, 'user-agent': 'jest' },
          cookies: { motive_rt: T },
        },
        transaction: `GET /api/invites/${T}`,
        breadcrumbs: [{ category: 'http', data: { url: `/api/invites/${T}/accept` } }],
      })
    );
    expect(out).not.toContain(T);
    expect(out).toContain('jest');
  });

  test('breadcrumbs without data pass through', () => {
    expect(scrubBreadcrumb({ message: 'x' })).toEqual({ message: 'x' });
  });
});
