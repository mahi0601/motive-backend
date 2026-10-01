// Server-side sessions behind the JWTs. See `model Session` in schema.prisma
// for the generation/rotation rules; this file enforces them.
const crypto = require('crypto');
const prisma = require('../config/prisma');
const config = require('../config/env');
const AppError = require('../utils/AppError');
const logger = require('../config/logger');

// How long the PREVIOUS refresh token keeps working after a rotation. Covers
// two tabs (or a retry after a dropped response) presenting the same cookie;
// short enough that a token stolen and replayed later is treated as theft.
const GRACE_MS = 20 * 1000;

const revoked = () => AppError.unauthorized('Refresh token revoked');

exports.create = async (userId, userAgent) =>
  prisma.session.create({
    data: {
      userId,
      expiresAt: new Date(Date.now() + config.cookie.maxAgeMs),
      uaHash: userAgent ? crypto.createHash('sha256').update(String(userAgent)).digest('hex').slice(0, 16) : null,
    },
  });

exports.revoke = (sid) => prisma.session.updateMany({ where: { id: sid, revokedAt: null }, data: { revokedAt: new Date() } });

exports.revokeAllForUser = (userId) =>
  prisma.session.updateMany({ where: { userId, revokedAt: null }, data: { revokedAt: new Date() } });

const reuseOrGrace = async (session, gen) => {
  const now = new Date();
  const stillValid = !session.revokedAt && session.expiresAt > now;
  if (stillValid && gen === session.gen - 1 && session.prevGenValidUntil && session.prevGenValidUntil > now) {
    // The previous token, replayed inside the grace window: answer with the
    // CURRENT generation without rotating again.
    return { user: session.user, sid: session.id, gen: session.gen };
  }
  // An older or out-of-window token: whoever holds it is either a thief or a
  // stale client. Cutting the session is safe either way — the owner signs in again.
  await exports.revoke(session.id);
  logger.warn('Refresh token reuse detected — session revoked', { userId: session.userId, sid: session.id, event: 'refresh_reuse' });
  throw revoked();
};

// Validates a refresh token's claims against its session and advances it.
// Returns { user, sid, gen } — the generation to put in the NEW refresh token.
exports.rotate = async ({ sid, gen, ver }) => {
  if (typeof sid !== 'string' || !Number.isInteger(gen)) throw AppError.unauthorized('Invalid refresh token');
  const now = new Date();
  const session = await prisma.session.findUnique({ where: { id: sid }, include: { user: true } });
  if (!session || session.revokedAt || session.expiresAt <= now) throw revoked();
  if (session.user.tokenVersion !== ver) throw revoked();

  if (gen === session.gen) {
    // Atomic compare-and-swap: of two requests presenting the same generation,
    // exactly one rotates; the other falls through to the grace path below.
    const won = await prisma.session.updateMany({
      where: { id: sid, gen, revokedAt: null },
      data: { gen: { increment: 1 }, prevGenValidUntil: new Date(now.getTime() + GRACE_MS), lastUsedAt: now },
    });
    if (won.count === 1) return { user: session.user, sid, gen: gen + 1 };
    const fresh = await prisma.session.findUnique({ where: { id: sid }, include: { user: true } });
    if (!fresh) throw revoked();
    return reuseOrGrace(fresh, gen);
  }
  return reuseOrGrace(session, gen);
};

// Does this access-token payload belong to a live session of the right
// version? Run on every authenticated request and every socket handshake.
exports.assertAccessPayload = async (payload) => {
  if (payload?.type !== 'access') throw AppError.unauthorized('Invalid token type');
  if (typeof payload.sid !== 'string' || typeof payload.ver !== 'number') throw AppError.unauthorized('Session expired');
  const session = await prisma.session.findUnique({
    where: { id: payload.sid },
    select: { userId: true, revokedAt: true, expiresAt: true, user: { select: { tokenVersion: true } } },
  });
  if (
    !session ||
    session.userId !== payload.id ||
    session.revokedAt ||
    session.expiresAt <= new Date() ||
    session.user.tokenVersion !== payload.ver
  ) {
    throw AppError.unauthorized('Session expired');
  }
};
