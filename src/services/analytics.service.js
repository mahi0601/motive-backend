// First-party product analytics: a few server-side events that answer "is anyone
// getting to the point of the product?" (sign up -> first task -> a client status
// link -> someone opens it -> pays). No tracking script, no cookies, no third
// party. Events hold a name and ids only; the one thing derived from a visitor is
// a hash that rotates daily, enough to count unique viewers and not enough to
// identify or follow anyone. Recording an event can never fail the operation it
// describes. Read the numbers with `npm run funnel`.
const crypto = require('crypto');
const prisma = require('../config/prisma');
const config = require('../config/env');
const logger = require('../config/logger');
const { truncateIp } = require('./audit.service');

const EVENTS = ['signup', 'first_task_created', 'status_link_created', 'status_page_viewed', 'feedback_received', 'upgraded'];

exports.track = async (name, { userId = null, workspaceId = null, visitor = null } = {}) => {
  if (!EVENTS.includes(name)) {
    logger.warn('analytics: unknown event ignored', { name });
    return;
  }
  try {
    await prisma.productEvent.create({ data: { name, userId, workspaceId, visitor } });
  } catch (err) {
    logger.warn('analytics write failed', { name, err: err?.message });
  }
};

// Salted with the server secret and the calendar day, over the visitor's network
// (/24) and browser string. Same visitor, same day -> same key; a different day
// gives an unrelated one. The ip and user agent themselves are never stored.
exports.visitorKey = ({ ip, userAgent, now = new Date() }) => {
  const day = now.toISOString().slice(0, 10);
  const material = `${config.jwt.secret}|${day}|${truncateIp(ip) || 'unknown'}|${userAgent || ''}`;
  return crypto.createHash('sha256').update(material).digest('hex').slice(0, 16);
};

const distinct = async (name, field, where) => {
  const rows = await prisma.productEvent.groupBy({ by: [field], where: { name, [field]: { not: null }, ...where } });
  return rows.length;
};

// `scope` (tests only) limits counting to ids that start with it.
exports.funnel = async ({ since, scope } = {}) => {
  const base = { createdAt: { gte: since } };
  const u = scope ? { ...base, userId: { startsWith: scope } } : base;
  const w = scope ? { ...base, workspaceId: { startsWith: scope } } : base;
  const viewerRows = await prisma.productEvent.groupBy({
    by: ['workspaceId', 'visitor'],
    where: { name: 'status_page_viewed', visitor: { not: null }, ...w },
  });
  return {
    signups: await distinct('signup', 'userId', u),
    activated: await distinct('first_task_created', 'userId', u),
    linksCreated: await distinct('status_link_created', 'workspaceId', w),
    linksViewed: await distinct('status_page_viewed', 'workspaceId', w),
    viewers: viewerRows.length,
    feedbackReceived: await distinct('feedback_received', 'workspaceId', w),
    upgraded: await distinct('upgraded', 'userId', u),
  };
};

const pct = (part, whole) => (whole > 0 ? ` (${Math.round((part / whole) * 100)}%)` : '');

exports.formatFunnel = (f, days) => {
  const row = (label, n, of) => `  ${label.padEnd(34)}${String(n).padStart(5)}${of === undefined ? '' : pct(n, of)}`;
  return [
    `Clientglass funnel, last ${days} days`,
    '',
    row('Signed up', f.signups),
    row('Added a first task', f.activated, f.signups),
    row('Created a client status link', f.linksCreated, f.activated),
    row('Link opened (workspaces)', f.linksViewed, f.linksCreated),
    row('  unique viewers (incl. owner)', f.viewers),
    row('A client responded (workspaces)', f.feedbackReceived, f.linksViewed),
    row('Upgraded to Pro', f.upgraded, f.signups),
    '',
    'Notes: stages count distinct people or workspaces, not events. Percentages are of the stage above',
    '(upgrades: of signups). "Link opened" includes the owner previewing their own link.',
  ].join('\n');
};
