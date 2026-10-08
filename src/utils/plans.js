// Plans are priced by ACTIVE CLIENT (a workspace with a live status link) and cap
// team size per workspace. Everything that asks "how much may this account do?"
// goes through here, so the numbers live in one place.
//
// `isPro` stays the one flag that says "this account is paid right now" (every
// older gate still reads it). `plan` only says WHICH paid tier, and is ignored
// unless the account is actually paid:
//   - not paid                                  -> free, whatever the column says
//   - lifetime Pro (the old one-time upgrade)   -> agency, forever
//   - paid, column says studio or agency        -> that tier
//   - paid, anything else (a subscriber from before tiers existed, whose column
//     is still 'free') -> agency, so nobody who already pays loses anything
const PAID_PLANS = ['studio', 'agency'];

const PLAN_LIMITS = {
  // `subscribers`: people per client who get the weekly update email.
  free: { clients: 1, members: 2, subscribers: 1 },
  studio: { clients: 10, members: 5, subscribers: 10 },
  agency: { clients: Infinity, members: 15, subscribers: 10 },
};

const PLAN_NAMES = { free: 'Free', studio: 'Studio', agency: 'Agency' };

const effectivePlan = (user) => {
  if (!user || !user.isPro) return 'free';
  if (user.proLifetime) return 'agency';
  return PAID_PLANS.includes(user.plan) ? user.plan : 'agency';
};

const limitsFor = (user) => PLAN_LIMITS[effectivePlan(user)];

// The next tier up, for "upgrade to X" messages. null at the top.
const NEXT_PLAN = { free: 'studio', studio: 'agency', agency: null };

module.exports = { PAID_PLANS, PLAN_LIMITS, PLAN_NAMES, NEXT_PLAN, effectivePlan, limitsFor };
