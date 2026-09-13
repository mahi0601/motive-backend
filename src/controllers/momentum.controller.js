const momentumService = require('../services/momentum.service');
const prisma = require('../config/prisma');
const asyncHandler = require('../utils/asyncHandler');

exports.getMomentum = asyncHandler(async (req, res) => {
  const userId = req.user.id;
  const requestedPeriod = momentumService.VALID_PERIODS.includes(req.query.period) ? req.query.period : 'week';

  // `req.query.scope`/`workspaceId` are not read yet — Task has no
  // workspaceId/assigneeId column, so there is nothing to scope a "team"
  // view by. The response always says `scope: 'me'` (see momentum.service.js)
  // so a client can tell it got the personal view rather than silently
  // assuming its request was honored. Reading/validating those params lands
  // with the Phase 2 schema addition.
  const { timezone, isPro } = await prisma.user.findUnique({ where: { id: userId }, select: { timezone: true, isPro: true } });

  // Motive Pro gate: This week is free; Month/Quarter (and the deeper
  // insight history that comes with a longer window) are Pro-only. Silently
  // downgrading to 'week' rather than erroring — a stale/bookmarked
  // ?period=month link for a since-downgraded account should degrade
  // gracefully, not break. `periodLocked` tells the frontend *why* it got
  // 'week' back instead of what was asked for, so it can show the right
  // upsell instead of silently looking like the click did nothing.
  const periodLocked = momentumService.PRO_ONLY_PERIODS.includes(requestedPeriod) && !isPro;
  const period = periodLocked ? 'week' : requestedPeriod;

  const data = await momentumService.getMomentum(userId, { period, timezone: timezone || 'UTC' });
  res.status(200).json({ success: true, periodLocked, ...data });
});
