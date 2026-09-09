const digestService = require('../services/digest.service');
const asyncHandler = require('../utils/asyncHandler');

exports.getDailyDigest = asyncHandler(async (req, res) => {
  const digest = await digestService.getDailyDigest(req.user.id);
  res.json({ success: true, digest });
});
