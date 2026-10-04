// PayPal and Cashfree stop billing the moment a subscriber cancels, so the app keeps access to the paid-until
// date and this sweep ends it. It must end ONLY that: cancelled, non-lifetime PayPal/Cashfree subscribers whose
// date has passed. Everyone else (Stripe and Razorpay end themselves by event; lifetime buyers never lose Pro;
// a future date is still paid for) must be left alone.
const prisma = require('../src/config/prisma');
const { expireCancelledSubscriptions, runCleanup } = require('../src/jobs/cleanup');
const { makeUser, cleanupUsers } = require('./helpers/fixtures');

describe('ending access at the paid-until date', () => {
  const users = [];
  afterAll(async () => {
    await cleanupUsers(...users);
    await prisma.$disconnect();
  });
  const day = 86400000;
  const make = async (label, data) => {
    const u = await makeUser(label);
    users.push(u);
    await prisma.user.update({
      where: { id: u.id },
      data: { isPro: true, plan: 'studio', subscriptionStatus: 'active', subscriptionCancelAtPeriodEnd: true, proPeriodEnd: new Date(Date.now() - day), paymentProvider: 'paypal', ...data },
    });
    return u;
  };
  const get = (u) => prisma.user.findUnique({ where: { id: u.id } });

  test('ends a cancelled PayPal or Cashfree subscriber whose date has passed, and records it', async () => {
    const pp = await make('swPp', {});
    const cf = await make('swCf', { paymentProvider: 'cashfree' });
    const count = await expireCancelledSubscriptions();
    expect(count).toBeGreaterThanOrEqual(2);
    for (const u of [pp, cf]) {
      expect(await get(u)).toMatchObject({ isPro: false, plan: 'free', subscriptionStatus: 'canceled', subscriptionCancelAtPeriodEnd: false });
    }
    const events = await prisma.securityEvent.findMany({ where: { type: 'plan_changed', targetUserId: pp.id } });
    expect(JSON.stringify(events)).toMatch(/paid period ended/);
  });

  test.each([
    ['a date still in the future', { proPeriodEnd: new Date(Date.now() + 3 * day) }],
    ['a subscriber who did not cancel', { subscriptionCancelAtPeriodEnd: false }],
    ['a lifetime buyer', { proLifetime: true, plan: 'agency' }],
    ['a Stripe subscriber (Stripe ends itself by event)', { paymentProvider: 'stripe' }],
    ['a Razorpay subscriber (cancels at the cycle end itself)', { paymentProvider: 'razorpay' }],
    ['someone with no provider recorded', { paymentProvider: null }],
    ['someone with no period end recorded', { proPeriodEnd: null }],
  ])('leaves %s alone', async (label, data) => {
    const u = await make(`swKeep${label.length}`, data);
    await expireCancelledSubscriptions();
    expect((await get(u)).isPro).toBe(true);
  });

  test('is part of the regular cleanup run and reported in its counts', async () => {
    const u = await make('swRun', {});
    const counts = await runCleanup();
    expect(counts.expiredSubscriptions).toBeGreaterThanOrEqual(1);
    expect((await get(u)).isPro).toBe(false);
  });

  test('running it again changes nothing', async () => {
    await make('swTwice', {});
    await expireCancelledSubscriptions();
    expect(await expireCancelledSubscriptions()).toBe(0);
  });
});
