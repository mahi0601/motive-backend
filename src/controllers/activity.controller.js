const activityLogService = require('../services/activityLog.service');
const asyncHandler = require('../utils/asyncHandler');
const { getPagination, paginated } = require('../utils/pagination');

exports.getActivity = asyncHandler(async (req, res) => {
  const { page, limit, skip } = getPagination(req.query, { defaultLimit: 20, maxLimit: 50 });
  const { items, total } = await activityLogService.getForUser(req.user.id, { skip, limit });
  res.json({ success: true, ...paginated(items, total, { page, limit }) });
});
