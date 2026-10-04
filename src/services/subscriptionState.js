// What every payment gateway reduces to. Stripe, Razorpay, PayPal and Cashfree each have their own
// statuses and events; each one maps what it was told into the same small `state`, and this
// applies it to the user's flags, so a rule (nobody gets access before paying; a charge being
// retried keeps access; an ended subscription revokes it; a lifetime buyer never loses Pro) is
// written once and every gate in the app reads the same columns whichever gateway took the money.
//
// state = {
//   status:   what to store in `subscriptionStatus` ('active' | 'past_due' | 'unpaid' | 'canceled' | the gateway's own while waiting)
//   paid:     the buyer has paid and the subscription is live (access ON)
//   inFlight: not paid yet but may become paid (mandate authorised, first charge pending): used only to
//             spot a second subscription for the same buyer
//   ended:    the subscription is over (cancelled, expired, completed, halted)
//   periodEnd: Date | null, the end of the period paid for
//   plan:     'studio' | 'agency'
// }
const prisma = require('../config/prisma');
const logger = require('../config/logger');
const audit = require('./audit.service');
const analytics = require('./analytics.service');

// The `subscriptionStatus` values that mean "paying": active, or a failed charge still being retried.
const PAYING = ['active', 'past_due'];
exports.PAYING = PAYING;

// Applies `state` to the user who owns subscription `id` on `provider`.
//  - `idColumn`: the user column holding this gateway's subscription id.
//  - `userHint`: the user id we put in the subscription's notes / custom id / tags when we made it.
//  - `cancelDuplicate`: how to cancel a second live subscription for someone already paying.
//  - `honourPaidUntil`: for gateways that end billing the moment we cancel (PayPal, Cashfree): a
//    subscription the buyer cancelled keeps access until the end of the period they paid for;
//    jobs/cleanup.js ends it then. Razorpay cancels at the cycle end itself, so it does not need it.
// Returns the user's id, or null when the subscription is not one of ours.
exports.applyGatewayState = async ({ provider, idColumn, id, userHint, state, cancelDuplicate, honourPaidUntil = false }) => {
  if (!id) return null;
  const user = await prisma.user.findFirst({
    where: { OR: [{ [idColumn]: id }, ...(userHint ? [{ id: userHint }] : [])] },
    omit: { [idColumn]: false },
  });
  if (!user) return null; // not one of ours, or the account is gone

  // Matched only by the hint, and the buyer already pays through a different live subscription:
  // this is a second one (a double-click that both got paid). Cancel it rather than bill twice.
  if (user[idColumn] && user[idColumn] !== id && PAYING.includes(user.subscriptionStatus)) {
    if ((state.paid || state.inFlight) && cancelDuplicate) {
      try {
        await cancelDuplicate(id);
        await audit.record({ type: 'duplicate_subscription_cancelled', targetUserId: user.id, meta: { provider } });
      } catch {
        logger.error('Could not cancel a duplicate subscription', { userId: user.id, provider });
      }
    }
    return user.id;
  }

  const now = new Date();
  // They cancelled and this gateway stopped billing at once, but the period they paid for has not
  // ended: they keep access until it does.
  const paidUntilStillRunning =
    honourPaidUntil && state.ended && user.subscriptionCancelAtPeriodEnd && user.proPeriodEnd && user.proPeriodEnd > now;
  const paid = state.paid || paidUntilStillRunning;
  const ended = state.ended && !paidUntilStillRunning;
  const status = paidUntilStillRunning ? 'active' : state.status;
  const nextIsPro = user.proLifetime || paid;

  if (nextIsPro !== user.isPro) {
    await audit.record({ type: 'plan_changed', targetUserId: user.id, meta: { isPro: nextIsPro, status, provider } });
    if (nextIsPro) await analytics.track('upgraded', { userId: user.id });
  }
  await prisma.user.update({
    where: { id: user.id },
    data: {
      [idColumn]: id,
      paymentProvider: provider,
      subscriptionStatus: status,
      proPeriodEnd: state.periodEnd ?? user.proPeriodEnd,
      // Set when the buyer cancels (each gateway's cancel call); cleared once it has really ended.
      subscriptionCancelAtPeriodEnd: !ended && paid ? user.subscriptionCancelAtPeriodEnd : false,
      isPro: nextIsPro,
      // A gateway that cannot say which plan it was (state.plan null) keeps the plan the user has.
      plan: user.proLifetime ? 'agency' : nextIsPro ? state.plan || (['studio', 'agency'].includes(user.plan) ? user.plan : 'studio') : 'free',
    },
  });
  return user.id;
};
