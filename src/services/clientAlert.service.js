// Emails the workspace owner when a client responds on the status page. The in-app notice is
// already created by the caller; this adds the email. An approval is the sign-off record, so it is
// always sent. Comments, change requests and new requests are batched: if the owner was already
// told about this client in the last 12 hours (the earlier in-app notice marks it), no second email.
const prisma = require('../config/prisma');
const config = require('../config/env');
const logger = require('../config/logger');
const escapeHtml = require('../utils/escapeHtml');
const emailService = require('./email.service');

const QUIET_MS = 12 * 60 * 60 * 1000;

exports.emailOwner = async ({ ws, notification, kind, immediate = false }) => {
  try {
    const owner = await prisma.user.findUnique({ where: { id: ws.ownerId }, select: { email: true, notifyClientResponsesByEmail: true } });
    if (!owner?.notifyClientResponsesByEmail) return;
    if (!immediate) {
      const earlier = await prisma.notification.count({
        where: {
          userId: ws.ownerId,
          title: notification.title,
          type: notification.type,
          id: { not: notification.id },
          createdAt: { gt: new Date(Date.now() - QUIET_MS), lt: notification.createdAt },
        },
      });
      if (earlier) return;
    }
    const url = `${config.frontendUrl}/settings`;
    await emailService.sendEmail({
      to: owner.email,
      subject: `${notification.title}`.slice(0, 120),
      html: `<div style="background:#F6F8F9;padding:32px 16px;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Helvetica,Arial,sans-serif;">
  <div style="max-width:480px;margin:0 auto;background:#FFFFFF;border-radius:12px;border:1px solid #DDE4E7;padding:32px;">
    <h1 style="margin:0 0 12px;font-size:18px;color:#0F1A20;">${escapeHtml(notification.title)}</h1>
    <p style="margin:0 0 20px;font-size:15px;line-height:1.6;color:#2B3A42;">${escapeHtml(notification.message)}</p>
    <a href="${url}" style="display:inline-block;background:#1B7A8C;color:#FFFFFF;text-decoration:none;font-size:15px;font-weight:600;padding:12px 24px;border-radius:8px;">Open Clientglass</a>
    <p style="margin:24px 0 0;font-size:12px;color:#5E6E77;">You can turn these emails off in Settings, Notifications.${immediate ? '' : ' We send at most one of these per client every 12 hours.'}</p>
  </div>
</div>`,
      text: `${notification.title}\n\n${notification.message}\n\nOpen Clientglass: ${url}`,
    });
  } catch (err) {
    // Never fails the client's submission.
    logger.warn('Could not email the owner about a client response', { err: err?.message, kind });
  }
};
