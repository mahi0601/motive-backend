// Append-only security event trail (see `model SecurityEvent`). Written from the
// service layer at the moment something security-relevant happens. It must never
// get in the way of the thing it records, never store a credential, and never
// hold more personal data than incident response needs: ids rather than emails,
// and an ip cut down to its network.
const prisma = require('../config/prisma');
const logger = require('../config/logger');
const { currentIp } = require('../utils/requestContext');

// IPv4 -> /24, IPv6 -> /48. Enough to see "same network" without being a precise address.
exports.truncateIp = (ip) => {
  if (typeof ip !== 'string') return null;
  const v4 = ip.replace(/^::ffff:/i, '');
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.\d{1,3}$/.exec(v4);
  if (m) return `${m[1]}.${m[2]}.${m[3]}.0/24`;
  if (ip.includes(':')) {
    const groups = ip.split(':').filter(Boolean).slice(0, 3);
    if (groups.length === 3 && groups.every((g) => /^[0-9a-f]{1,4}$/i.test(g))) return `${groups.join(':')}::/48`;
  }
  return null;
};

const SECRET_KEY = /email|token|password|secret|cookie|authorization|code/i;
const EMAIL_VALUE = /[^\s@]+@[^\s@]+\.[^\s@]+/;
const cleanMeta = (meta) => {
  if (!meta || typeof meta !== 'object') return undefined;
  const out = {};
  for (const [k, v] of Object.entries(meta)) {
    if (SECRET_KEY.test(k)) continue;
    if (typeof v === 'string' && EMAIL_VALUE.test(v)) continue;
    if (v !== null && typeof v === 'object') continue; // flat, small facts only
    out[k] = v;
  }
  return Object.keys(out).length ? out : undefined;
};

exports.record = async ({ type, actorId = null, targetUserId = null, workspaceId = null, meta } = {}) => {
  try {
    const ip = exports.truncateIp(currentIp());
    const cleaned = cleanMeta(meta);
    // Same event on stdout, so Better Stack/Render logs carry it too.
    logger.info('security event', { security: true, type, actorId, targetUserId, workspaceId, ip, meta: cleaned });
    await prisma.securityEvent.create({
      data: { type, actorId, targetUserId, workspaceId, ip, ...(cleaned ? { meta: cleaned } : {}) },
    });
  } catch (err) {
    logger.warn('security event write failed', { type, err: err?.message });
  }
};
