// The Clients overview: every client the user OWNS (a workspace they merely belong to is
// somebody else's client), with the few numbers that say who needs attention, most in need
// first. Numbers, dates and flags only: no task titles, people or visitor data.
//
// A fixed number of queries however many clients there are (grouped by workspace, never one
// query per client), so a screen of 50 clients costs the same as a screen of 2. It reads the
// same facts as the rest of the app: a "view" is a real client opening the page (previews,
// bots and the owner's own looks are never recorded), and "done" work has a completion date.
const prisma = require('../config/prisma');
const requestService = require('./request.service');

const DAY = 24 * 60 * 60 * 1000;
const MAX_CLIENTS = 50;
const FETCH_LIMIT = 200; // look at more than we show, so the 50 shown are the 50 most in need
const NOT_OPENED_AFTER_DAYS = 3;
const QUIET_AFTER_DAYS = 14;
const SHIPPED_DAYS = 7;

const countsBy = (rows) => new Map(rows.map((r) => [r.workspaceId, r._count._all]));

exports.overview = async (userId) => {
  const workspaces = await prisma.workspace.findMany({
    where: { ownerId: userId },
    orderBy: { createdAt: 'asc' },
    take: FETCH_LIMIT,
    select: { id: true, name: true, icon: true, shareEnabledAt: true },
  });
  if (!workspaces.length) return [];

  const ids = workspaces.map((w) => w.id);
  const now = new Date();
  const startOfToday = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  const shippedSince = new Date(now.getTime() - SHIPPED_DAYS * DAY);
  const inClients = { workspaceId: { in: ids } };

  const [milestones, open, overdue, shipped, views, unread, requestsBy] = await Promise.all([
    prisma.milestone.findMany({ where: { ...inClients, date: { gte: startOfToday } }, orderBy: { date: 'asc' }, select: { workspaceId: true, title: true, date: true } }),
    prisma.task.groupBy({ by: ['workspaceId'], where: { ...inClients, status: { not: 'done' } }, _count: { _all: true } }),
    prisma.task.groupBy({ by: ['workspaceId'], where: { ...inClients, status: { not: 'done' }, dueDate: { lt: now } }, _count: { _all: true } }),
    prisma.task.groupBy({ by: ['workspaceId'], where: { ...inClients, status: 'done', completedAt: { gte: shippedSince } }, _count: { _all: true } }),
    prisma.productEvent.groupBy({ by: ['workspaceId'], where: { name: 'status_page_viewed', ...inClients }, _max: { createdAt: true } }),
    prisma.clientFeedback.groupBy({ by: ['workspaceId'], where: { ...inClients, readAt: null }, _count: { _all: true } }),
    requestService.unreadCounts(ids),
  ]);

  const openBy = countsBy(open);
  const overdueBy = countsBy(overdue);
  const shippedBy = countsBy(shipped);
  const unreadBy = countsBy(unread);
  const lastViewBy = new Map(views.map((v) => [v.workspaceId, v._max.createdAt]));
  const nextMilestoneBy = new Map();
  for (const m of milestones) if (!nextMilestoneBy.has(m.workspaceId)) nextMilestoneBy.set(m.workspaceId, { title: m.title, date: m.date });

  const clients = workspaces.map((w) => {
    const lastViewedAt = lastViewBy.get(w.id) ?? null;
    const linkLive = !!w.shareEnabledAt;
    const overdueCount = overdueBy.get(w.id) ?? 0;
    const unreadCount = unreadBy.get(w.id) ?? 0;
    const requestCount = requestsBy.get(w.id) ?? 0;

    // Why this client needs a look, in a fixed order (it is also what the order of the list rests on).
    const attention = [];
    if (overdueCount > 0) attention.push('overdue');
    if (unreadCount > 0) attention.push('responses');
    if (requestCount > 0) attention.push('requests');
    if (linkLive && !lastViewedAt && now - w.shareEnabledAt >= NOT_OPENED_AFTER_DAYS * DAY) attention.push('not_opened');
    if (linkLive && lastViewedAt && now - lastViewedAt > QUIET_AFTER_DAYS * DAY) attention.push('quiet');

    return {
      id: w.id,
      name: w.name,
      icon: w.icon,
      linkLive,
      lastViewedAt,
      open: openBy.get(w.id) ?? 0,
      overdue: overdueCount,
      shippedThisWeek: shippedBy.get(w.id) ?? 0,
      unreadResponses: unreadCount,
      unreadRequests: requestCount,
      nextMilestone: nextMilestoneBy.get(w.id) ?? null,
      attention,
    };
  });

  // Most in need first: more reasons, then more overdue work, then by name.
  clients.sort((a, b) => b.attention.length - a.attention.length || b.overdue - a.overdue || a.name.localeCompare(b.name));
  return clients.slice(0, MAX_CLIENTS);
};
