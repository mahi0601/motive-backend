const prisma = require('../config/prisma');
const logger = require('../config/logger');

// Fire-and-forget-ish activity log write. Never blocks or fails the caller's
// real operation — an activity feed entry going missing is much better than
// a task create/update/delete failing because logging hiccuped.
exports.log = async (action, userId, { taskId = null, description = '' } = {}) => {
  try {
    await prisma.activityLog.create({ data: { action, userId, taskId, description } });
  } catch (err) {
    logger.error('Activity log write failed', err, { action, userId, taskId });
  }
};

// A user's own recent activity, paginated with the same helpers list/task
// endpoints use.
exports.getForUser = async (userId, { skip, limit }) => {
  const [items, total] = await Promise.all([
    prisma.activityLog.findMany({
      where: { userId },
      orderBy: { timestamp: 'desc' },
      skip,
      take: limit,
    }),
    prisma.activityLog.count({ where: { userId } }),
  ]);
  return { items, total };
};
