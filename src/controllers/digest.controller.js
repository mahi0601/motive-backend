const digestService = require('../services/digest.service');
const prisma = require('../config/prisma');
const asyncHandler = require('../utils/asyncHandler');

exports.getDailyDigest = asyncHandler(async (req, res) => {
  // auth.middleware only decodes { id, type, iat, exp } — the timezone has to
  // be looked up, same as momentum.controller.js does.
  const user = await prisma.user.findUnique({ where: { id: req.user.id }, select: { timezone: true } });
  const digest = await digestService.getDailyDigest(req.user.id, { timezone: user?.timezone || 'UTC' });
  res.json({ success: true, digest });
});
