// The weekly "what moved" email to a client's subscribers, and the preview the owner can send
// to themselves. It carries what the public status page already shows (task titles and dates,
// the next milestone) and nothing else: no comments, files, people or requests.
const prisma = require('../config/prisma');
const config = require('../config/env');
const logger = require('../config/logger');
const escapeHtml = require('../utils/escapeHtml');
const { subscriberToken } = require('../utils/shareToken');
const emailService = require('./email.service');
const analytics = require('./analytics.service');
const workspaceService = require('./workspace.service');
const AppError = require('../utils/AppError');

const DAY = 24 * 60 * 60 * 1000;
const WINDOW_DAYS = 7;
const MIN_GAP_MS = 6 * DAY;
const SEND_HOUR = 9;
const MAX_ITEMS = 8;

const fmtDate = (d) => new Date(d).toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' });

// Weekday (0 = Sunday) and hour in the owner's timezone. A bad zone falls back to UTC.
exports.localParts = (date, timeZone) => {
  const parts = (tz) =>
    new Intl.DateTimeFormat('en-US', { timeZone: tz, weekday: 'short', hour: 'numeric', hourCycle: 'h23' }).formatToParts(date);
  let p;
  try { p = parts(timeZone || 'UTC'); } catch { p = parts('UTC'); }
  const weekday = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].indexOf(p.find((x) => x.type === 'weekday').value);
  return { weekday, hour: Number(p.find((x) => x.type === 'hour').value) };
};

// True when this workspace's update is due now.
exports.isDue = (ws, now = new Date()) => {
  if (!ws.statusDigestEnabled || !ws.shareEnabledAt) return false;
  if (ws.statusDigestLastSentAt && now - ws.statusDigestLastSentAt < MIN_GAP_MS) return false;
  const { weekday, hour } = exports.localParts(now, ws.owner?.timezone);
  return weekday === ws.statusDigestDay && hour >= SEND_HOUR;
};

exports.collect = async (workspaceId, now = new Date()) => {
  const since = new Date(now.getTime() - WINDOW_DAYS * DAY);
  const [shipped, shippedCount, inProgress, upcoming, milestone] = await Promise.all([
    prisma.task.findMany({ where: { workspaceId, status: 'done', completedAt: { gte: since } }, orderBy: { completedAt: 'desc' }, take: MAX_ITEMS, select: { title: true } }),
    prisma.task.count({ where: { workspaceId, status: 'done', completedAt: { gte: since } } }),
    prisma.task.findMany({ where: { workspaceId, status: 'in_progress' }, orderBy: { dueDate: { sort: 'asc', nulls: 'last' } }, take: MAX_ITEMS, select: { title: true } }),
    prisma.task.findMany({ where: { workspaceId, status: 'todo', dueDate: { gte: now, lte: new Date(now.getTime() + 14 * DAY) } }, orderBy: { dueDate: 'asc' }, take: MAX_ITEMS, select: { title: true, dueDate: true } }),
    prisma.milestone.findFirst({ where: { workspaceId, date: { gte: now } }, orderBy: { date: 'asc' }, select: { title: true, date: true } }),
  ]);
  return { shipped, shippedCount, inProgress, upcoming, milestone };
};

// Nothing shipped and nothing under way: not worth an email.
exports.isEmpty = (d) => d.shippedCount === 0 && d.inProgress.length === 0;

exports.render = ({ workspaceName, data, token, showBranding, headline }) => {
  const pageUrl = `${config.frontendUrl}/s/${token}?ref=digest`;
  const unsubUrl = `${config.frontendUrl}/unsubscribe/${token}`;
  const section = (title, items, fmt = (i) => i.title) =>
    items.length
      ? `<h2 style="margin:24px 0 8px;font-size:15px;color:#0F1A20;">${escapeHtml(title)}</h2><ul style="margin:0;padding-left:20px;font-size:15px;line-height:1.6;color:#2B3A42;">${items.map((i) => `<li>${escapeHtml(fmt(i))}</li>`).join('')}</ul>`
      : '';
  const more = data.shippedCount > data.shipped.length ? `<p style="margin:8px 0 0;font-size:13px;color:#5E6E77;">and ${data.shippedCount - data.shipped.length} more</p>` : '';
  const html = `<div style="background:#F6F8F9;padding:32px 16px;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Helvetica,Arial,sans-serif;">
  <div style="max-width:520px;margin:0 auto;background:#FFFFFF;border-radius:12px;border:1px solid #DDE4E7;padding:32px;">
    <h1 style="margin:0 0 4px;font-size:20px;color:#0F1A20;">What moved on ${escapeHtml(workspaceName)}</h1>
    <p style="margin:0 0 8px;font-size:14px;color:#5E6E77;">Your weekly update${headline ? `: ${escapeHtml(headline)}` : ''}</p>
    ${section('Finished this week', data.shipped)}${more}
    ${section('In progress', data.inProgress)}
    ${section('Coming up', data.upcoming, (i) => `${i.title} (due ${fmtDate(i.dueDate)})`)}
    ${data.milestone ? `<p style="margin:24px 0 0;font-size:15px;color:#2B3A42;">Next milestone: <strong>${escapeHtml(data.milestone.title)}</strong>${data.milestone.date ? `, ${fmtDate(data.milestone.date)}` : ''}</p>` : ''}
    <a href="${pageUrl}" style="display:inline-block;margin-top:28px;background:#1B7A8C;color:#FFFFFF;text-decoration:none;font-size:15px;font-weight:600;padding:12px 24px;border-radius:8px;">See the live status page</a>
    <p style="margin:28px 0 0;font-size:12px;line-height:1.5;color:#5E6E77;">You get this because the team running this project added you. <a href="${unsubUrl}" style="color:#5E6E77;">Unsubscribe</a>${showBranding ? ' · Powered by <a href="' + config.frontendUrl + '/?ref=email" style="color:#5E6E77;">Clientglass</a>' : ''}</p>
  </div>
</div>`;
  const list = (title, items, fmt = (i) => i.title) => (items.length ? `\n${title}\n${items.map((i) => `- ${fmt(i)}`).join('\n')}\n` : '');
  const text = `What moved on ${workspaceName}\n${list('Finished this week', data.shipped)}${list('In progress', data.inProgress)}${list('Coming up', data.upcoming, (i) => `${i.title} (due ${fmtDate(i.dueDate)})`)}${data.milestone ? `\nNext milestone: ${data.milestone.title}${data.milestone.date ? `, ${fmtDate(data.milestone.date)}` : ''}\n` : ''}\nSee the live status page: ${pageUrl}\n\nUnsubscribe: ${unsubUrl}`;
  return { html, text, unsubUrl };
};

const sendTo = async ({ to, token, ws, data, preview = false }) => {
  const showBranding = !(ws.statusHideBranding && ws.owner?.isPro);
  const { html, text, unsubUrl } = exports.render({ workspaceName: ws.name, data, token, showBranding, headline: ws.statusHeadline });
  await emailService.sendEmail({
    to,
    subject: `${preview ? '[Preview] ' : ''}What moved this week: ${ws.name}`.slice(0, 120),
    html,
    text,
    headers: { 'List-Unsubscribe': `<${unsubUrl}>` },
  });
};

const dueSelect = {
  id: true, name: true, ownerId: true, shareEnabledAt: true, statusHeadline: true, statusHideBranding: true,
  statusDigestEnabled: true, statusDigestDay: true, statusDigestLastSentAt: true,
  owner: { select: { timezone: true, isPro: true } },
};

// One workspace: claim the week first (so two instances or a restart cannot double send), then mail
// every active subscriber their own link.
exports.sendForWorkspace = async (ws, now = new Date()) => {
  const data = await exports.collect(ws.id, now);
  if (exports.isEmpty(data)) return 0;
  const cutoff = new Date(now.getTime() - MIN_GAP_MS);
  const claimed = await prisma.workspace.updateMany({
    where: { id: ws.id, statusDigestEnabled: true, shareEnabledAt: { not: null }, OR: [{ statusDigestLastSentAt: null }, { statusDigestLastSentAt: { lt: cutoff } }] },
    data: { statusDigestLastSentAt: now },
  });
  if (!claimed.count) return 0;
  const subs = await prisma.statusSubscriber.findMany({ where: { workspaceId: ws.id, unsubscribedAt: null }, select: { id: true, email: true } });
  for (const s of subs) await sendTo({ to: s.email, token: subscriberToken(s.id), ws, data });
  if (subs.length) await analytics.track('digest_sent', { workspaceId: ws.id });
  return subs.length;
};

exports.runDigests = async (now = new Date()) => {
  const candidates = await prisma.workspace.findMany({
    where: { statusDigestEnabled: true, shareEnabledAt: { not: null }, subscribers: { some: { unsubscribedAt: null } } },
    select: dueSelect,
  });
  let sent = 0;
  for (const ws of candidates) {
    try {
      if (exports.isDue(ws, now)) sent += await exports.sendForWorkspace(ws, now);
    } catch (err) {
      logger.warn('weekly update failed for a workspace', { workspaceId: ws.id, err: err?.message });
    }
  }
  return sent;
};

// Owner-only: the real email, to the owner's own address, with a sample link. Does not touch the
// last-sent date or reach any subscriber.
exports.sendPreview = async (workspaceId, requesterId) => {
  await workspaceService.assertOwner(workspaceId, requesterId);
  const [ws, owner] = await Promise.all([
    prisma.workspace.findUnique({ where: { id: workspaceId }, select: dueSelect }),
    prisma.user.findUnique({ where: { id: requesterId }, select: { email: true } }),
  ]);
  const data = await exports.collect(workspaceId);
  if (exports.isEmpty(data)) throw new AppError('Nothing finished or in progress yet, so there is nothing to send.', 422);
  await sendTo({ to: owner.email, token: 'c_preview', ws, data, preview: true });
  return { sentTo: owner.email };
};
