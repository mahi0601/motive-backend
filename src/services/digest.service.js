const prisma = require('../config/prisma');
const { getZonedParts, zonedMidnightToUtc, addDays } = require('../utils/timezone.util');

const PICK = { id: true, title: true, dueDate: true, priority: true, category: true };
const priorityRank = { High: 0, Medium: 1, Low: 2 };

// Rules-based (not LLM-generated): a templated summary assembled from plain
// SQL queries — overdue, due today, and a single "focus" suggestion. Cheap,
// instant, and reliable for something this mechanical; an LLM-generated
// version is a natural upgrade path (see Clientglass's Phase 2 roadmap) once
// there's a reason to spend on it.
//
// "Today" is the user's local day (their saved `timezone`, like Momentum), not
// the server's — a server in UTC would otherwise call a task due at 8:30am in
// Kolkata "overdue" for the first half of the user's own day, or miss a task
// due this evening. `now` is injectable so the boundary is testable.
exports.getDailyDigest = async (userId, { timezone = 'UTC', now = new Date() } = {}) => {
  const today = getZonedParts(now, timezone);
  const startOfToday = zonedMidnightToUtc(today, timezone);
  const endOfToday = zonedMidnightToUtc(addDays(today, 1), timezone);

  const [overdue, dueToday] = await Promise.all([
    prisma.task.findMany({
      where: { userId, status: { not: 'done' }, dueDate: { lt: startOfToday } },
      orderBy: { dueDate: 'asc' },
      take: 50, // the digest is a short summary; a ceiling keeps it that way
      select: PICK,
    }),
    prisma.task.findMany({
      where: { userId, status: { not: 'done' }, dueDate: { gte: startOfToday, lt: endOfToday } },
      orderBy: { priority: 'asc' }, // enum order isn't alphabetical-useful; re-sorted below anyway
      take: 50,
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
