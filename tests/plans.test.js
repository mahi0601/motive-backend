// The plan rules in one place. `isPro` stays the single "is this account paid
// right now" flag every old gate reads; `plan` only says WHICH paid tier, and is
// never trusted unless the account is actually paid.
const { PLAN_LIMITS, effectivePlan, limitsFor } = require('../src/utils/plans');

describe('plan limits', () => {
  test('the numbers the pricing page promises', () => {
    expect(PLAN_LIMITS.free).toEqual({ clients: 1, members: 2, subscribers: 1 });
    expect(PLAN_LIMITS.studio).toEqual({ clients: 10, members: 5, subscribers: 10 });
    expect(PLAN_LIMITS.agency).toEqual({ clients: Infinity, members: 15, subscribers: 10 });
  });
});

describe('effectivePlan', () => {
  test.each([
    ['a free account', { isPro: false, proLifetime: false, plan: 'free' }, 'free'],
    ['a Studio subscriber', { isPro: true, proLifetime: false, plan: 'studio' }, 'studio'],
    ['an Agency subscriber', { isPro: true, proLifetime: false, plan: 'agency' }, 'agency'],
    ['a lifetime-Pro user, whatever the column says', { isPro: true, proLifetime: true, plan: 'free' }, 'agency'],
    ['a lifetime-Pro user marked studio', { isPro: true, proLifetime: true, plan: 'studio' }, 'agency'],
    ['a Pro user from before tiers existed (column still "free")', { isPro: true, proLifetime: false, plan: 'free' }, 'agency'],
    ['a Pro user with no plan value at all', { isPro: true, proLifetime: false }, 'agency'],
    ['a lapsed subscriber (isPro off) whose column still says agency', { isPro: false, proLifetime: false, plan: 'agency' }, 'free'],
    ['a lapsed subscriber whose column says studio', { isPro: false, proLifetime: false, plan: 'studio' }, 'free'],
    ['an unknown plan value on a paid account', { isPro: true, proLifetime: false, plan: 'platinum' }, 'agency'],
  ])('%s', (_label, user, expected) => {
    expect(effectivePlan(user)).toBe(expected);
  });

  test('a missing user is free', () => {
    expect(effectivePlan(null)).toBe('free');
    expect(effectivePlan(undefined)).toBe('free');
  });

  test('limitsFor returns the limits of the effective plan', () => {
    expect(limitsFor({ isPro: true, plan: 'studio' })).toEqual(PLAN_LIMITS.studio);
    expect(limitsFor({ isPro: false, plan: 'agency' })).toEqual(PLAN_LIMITS.free);
  });
});
