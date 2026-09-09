const prisma = require('../config/prisma');

const DOW_NAMES = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const MONTH_NAMES = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

// Tasks actually completed (status='done', `completedAt` set), aggregated in
// SQL and bucketed to match the selected range — 'week' by day-of-week,
// 'month' by week-of-month, 'year' by month. Previously this loaded every
// task created this week into JS and tallied by hand, and used `createdAt`
// while the UI labeled it "completed" — bucketed by `completedAt` now so the
// chart actually reflects what it claims to.
const getTaskCompletionStats = async (userId, range = 'week') => {
  if (range === 'month') {
    const rows = await prisma.$queryRaw`
      SELECT ((EXTRACT(DAY FROM "completedAt")::int - 1) / 7) AS bucket, COUNT(*)::int AS count
      FROM "Task"
      WHERE "userId" = ${userId} AND "status" = 'done' AND "completedAt" IS NOT NULL
        AND "completedAt" >= date_trunc('month', now())
        AND "completedAt" < date_trunc('month', now()) + interval '1 month'
      GROUP BY bucket
      ORDER BY bucket;
    `;
    const buckets = [0, 1, 2, 3, 4].map((i) => ({ name: `Week ${i + 1}`, completed: 0 }));
    rows.forEach((r) => { if (buckets[r.bucket]) buckets[r.bucket].completed = r.count; });
    return buckets;
  }

  if (range === 'year') {
    const rows = await prisma.$queryRaw`
      SELECT EXTRACT(MONTH FROM "completedAt")::int AS month, COUNT(*)::int AS count
      FROM "Task"
      WHERE "userId" = ${userId} AND "status" = 'done' AND "completedAt" IS NOT NULL
        AND "completedAt" >= date_trunc('year', now())
        AND "completedAt" < date_trunc('year', now()) + interval '1 year'
      GROUP BY month
      ORDER BY month;
    `;
    const buckets = MONTH_NAMES.map((name) => ({ name, completed: 0 }));
    rows.forEach((r) => { buckets[r.month - 1].completed = r.count; });
    return buckets;
  }

  // 'week' (default)
  const rows = await prisma.$queryRaw`
    SELECT EXTRACT(DOW FROM "completedAt")::int AS dow, COUNT(*)::int AS count
    FROM "Task"
    WHERE "userId" = ${userId} AND "status" = 'done' AND "completedAt" IS NOT NULL
      AND "completedAt" >= date_trunc('week', now())
      AND "completedAt" < date_trunc('week', now()) + interval '1 week'
    GROUP BY dow
    ORDER BY dow;
  `;
  const buckets = DOW_NAMES.map((name) => ({ name, completed: 0 }));
  rows.forEach((r) => { buckets[r.dow].completed = r.count; });
  return buckets;
};

// Task priority distribution — SQL-side aggregation (`groupBy`) instead of
// pulling every row into JS and tallying by hand.
const getPriorityStats = async (userId) => {
  const rows = await prisma.task.groupBy({
    by: ['priority'],
    where: { userId },
    _count: { _all: true },
  });
  const byPriority = Object.fromEntries(rows.map((r) => [r.priority, r._count._all]));
  return ['High', 'Medium', 'Low'].map((name) => ({ name, value: byPriority[name] || 0 }));
};

// Total + completed counts over the user's *entire* task set (not the
// capped page the frontend loads for display) — the single source of truth
// for completion rate, so it can't disagree with `getPriorityStats`'s total
// or exceed 100%.
const getTaskCounts = async (userId) => {
  const [total, completed] = await Promise.all([
    prisma.task.count({ where: { userId } }),
    prisma.task.count({ where: { userId, status: 'done' } }),
  ]);
  return { total, completed };
};

module.exports = { getTaskCompletionStats, getPriorityStats, getTaskCounts };
