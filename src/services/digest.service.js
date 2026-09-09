const prisma = require('../config/prisma');

const PICK = { id: true, title: true, dueDate: true, priority: true, category: true };
const priorityRank = { High: 0, Medium: 1, Low: 2 };

// Rules-based (not LLM-generated): a templated summary assembled from plain
// SQL queries — overdue, due today, and a single "focus" suggestion. Cheap,
// instant, and reliable for something this mechanical; an LLM-generated
// version is a natural upgrade path (see Motive's Phase 2 roadmap) once
// there's a reason to spend on it.
exports.getDailyDigest = async (userId) => {
  const startOfToday = new Date();
  startOfToday.setHours(0, 0, 0, 0);
  const endOfToday = new Date(startOfToday);
  endOfToday.setDate(endOfToday.getDate() + 1);

  const [overdue, dueToday] = await Promise.all([
    prisma.task.findMany({
      where: { userId, status: { not: 'done' }, dueDate: { lt: startOfToday } },
      orderBy: { dueDate: 'asc' },
      select: PICK,
    }),
    prisma.task.findMany({
      where: { userId, status: { not: 'done' }, dueDate: { gte: startOfToday, lt: endOfToday } },
      orderBy: { priority: 'asc' }, // enum order isn't alphabetical-useful; re-sorted below anyway
      select: PICK,
    }),
  ]);
  dueToday.sort((a, b) => priorityRank[a.priority] - priorityRank[b.priority]);

  const parts = [];
  if (overdue.length) parts.push(`${overdue.length} overdue`);
  if (dueToday.length) parts.push(`${dueToday.length} due today`);
  const headline = parts.length
    ? `You have ${parts.join(' and ')}.`
    : "You're all caught up — nothing overdue or due today.";

  // What to tackle first: an overdue task beats a due-today one; among
  // either group, highest priority first (already the query/sort order).
  const focusTask = overdue[0] || dueToday[0] || null;

  return {
    headline,
    focusTask,
    overdue: overdue.slice(0, 5),
    dueToday: dueToday.slice(0, 5),
  };
};
