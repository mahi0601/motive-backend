const { PrismaClient } = require('@prisma/client');

// Global omit: password/stripeCustomerId are never returned unless a query
// explicitly opts back in with `omit: { password: false }` — the Prisma
// equivalent of Mongoose's `select: false`, enforced at the client instead of
// relying on every call site to remember a `.toJSON()`/select list.
const prisma = new PrismaClient({
  omit: {
    user: {
      password: true,
      stripeCustomerId: true,
    },
  },
});

module.exports = prisma;
