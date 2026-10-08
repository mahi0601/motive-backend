// Two kinds of credential open a client status page:
//   - the workspace share token: random, shown to the owner once, only its sha256 is stored;
//   - a subscriber token: derived from the subscriber's id with an HMAC, so the weekly email can
//     carry it every week although only its sha256 is stored. It is prefixed `c_` and carries the
//     same read and respond rights as the share link, for that one workspace, while the link is on.
// `shareWhere` turns either into a Workspace `where`, so every public endpoint resolves a token
// the same way and an unknown, rotated or disabled link stays indistinguishable.
const crypto = require('crypto');
const config = require('../config/env');

const SUBSCRIBER_PREFIX = 'c_';

const sha256 = (value) => crypto.createHash('sha256').update(String(value)).digest('hex');

const subscriberToken = (subscriberId) =>
  SUBSCRIBER_PREFIX +
  crypto.createHmac('sha256', config.jwt.secret).update(`status-subscriber:${subscriberId}`).digest('base64url');

const isSubscriberToken = (raw) => typeof raw === 'string' && raw.startsWith(SUBSCRIBER_PREFIX);

const shareWhere = (rawToken) => {
  const tokenHash = sha256(rawToken);
  if (isSubscriberToken(String(rawToken))) {
    return { shareEnabledAt: { not: null }, subscribers: { some: { tokenHash } } };
  }
  return { shareTokenHash: tokenHash };
};

module.exports = { sha256, subscriberToken, isSubscriberToken, shareWhere };
