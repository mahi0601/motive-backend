const prisma = require('../config/prisma');

// Runs `fn(tx)` in a transaction that first takes a Postgres advisory lock on `key`, so two
// requests doing "count, then create" for the same key run one after the other instead of both
// counting before either creates (which would let a plan limit be exceeded). The lock is released
// when the transaction ends. Different keys never wait for each other.
module.exports = (key, fn) =>
  prisma.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${key}))`;
    return fn(tx);
  });
