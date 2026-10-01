// Retention job: prunes operational rows that have outlived their purpose, so
// the (free-tier) database stays small and personal data is not kept longer
// than it is useful. Runs once at boot and then every 6 hours. Safe to run on
// every instance — every delete is idempotent and bounded by a date.
const prisma = require('../config/prisma');
const logger = require('../config/logger');

const DAY = 24 * 60 * 60 * 1000;
const SIX_HOURS = 6 * 60 * 60 * 1000;

exports.runCleanup = async (now = new Date()) => {
  const ago = (days) => new Date(now.getTime() - days * DAY);
  const [nativeExchangeCodes, webhookEvents, notifications, activityLogs, invites, sessions, securityEvents, clientFeedback, productEvents] = await Promise.all([
    // Single-use hand-off codes expire in 60s; a day of slack is plenty.
    prisma.nativeExchangeCode.deleteMany({ where: { expiresAt: { lt: ago(1) } } }),
    // Stripe retries for at most ~3 days, so the idempotency ledger needs far less than 30.
    prisma.webhookEvent.deleteMany({ where: { createdAt: { lt: ago(30) } } }),
    // Only notifications the user has already read; unread ones are never dropped.
    prisma.notification.deleteMany({ where: { read: true, createdAt: { lt: ago(90) } } }),
    prisma.activityLog.deleteMany({ where: { timestamp: { lt: ago(365) } } }),
    // Finished invites (accepted/declined/revoked); a pending one is live state.
    prisma.workspaceInvite.deleteMany({ where: { status: { not: 'pending' }, updatedAt: { lt: ago(30) } } }),
    // Expired sessions, and revoked ones once any reuse-detection value is long gone.
    prisma.session.deleteMany({ where: { OR: [{ expiresAt: { lt: now } }, { revokedAt: { lt: ago(7) } }] } }),
    prisma.securityEvent.deleteMany({ where: { createdAt: { lt: ago(180) } } }),
    // Client feedback is kept for a year.
    prisma.clientFeedback.deleteMany({ where: { createdAt: { lt: ago(365) } } }),
    // Product analytics events are kept for 400 days (a full year plus slack).
    prisma.productEvent.deleteMany({ where: { createdAt: { lt: ago(400) } } }),
  ]);
  return {
    nativeExchangeCodes: nativeExchangeCodes.count,
    webhookEvents: webhookEvents.count,
    notifications: notifications.count,
    activityLogs: activityLogs.count,
    invites: invites.count,
    sessions: sessions.count,
    securityEvents: securityEvents.count,
    clientFeedback: clientFeedback.count,
    productEvents: productEvents.count,
  };
};

let timer = null;

const runSafely = async () => {
  try {
    const counts = await exports.runCleanup();
    const total = Object.values(counts).reduce((a, b) => a + b, 0);
    if (total) logger.info('retention cleanup', counts);
  } catch (err) {
    // A failed pass just waits for the next one; it must never take the server down.
    logger.warn('retention cleanup failed', { err: err?.message });
  }
};

exports.start = ({ intervalMs = SIX_HOURS } = {}) => {
  if (timer) return timer;
  runSafely();
  timer = setInterval(runSafely, intervalMs);
  timer.unref(); // never keeps the process (or a test run) alive
  return timer;
};

exports.stop = () => {
  if (timer) clearInterval(timer);
  timer = null;
};
