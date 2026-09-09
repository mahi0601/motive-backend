// controllers/statistics.controller.js
const {
  getTaskCompletionStats,
  getPriorityStats,
  getTaskCounts,
} = require('../services/statistics.service');
const asyncHandler = require('../utils/asyncHandler');

const VALID_RANGES = ['week', 'month', 'year'];

exports.getStatistics = asyncHandler(async (req, res) => {
  const userId = req.user.id;
  const range = VALID_RANGES.includes(req.query.range) ? req.query.range : 'week';

  const [taskStats, priorityStats, taskCounts] = await Promise.all([
    getTaskCompletionStats(userId, range),
    getPriorityStats(userId),
    getTaskCounts(userId),
  ]);

  res.status(200).json({ success: true, range, taskStats, priorityStats, taskCounts });
});
