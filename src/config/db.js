const prisma = require('./prisma');
const logger = require('./logger');

// Verifies the DB is actually reachable at boot (Prisma otherwise connects
// lazily on first query), so a bad DATABASE_URL fails fast here instead of on
// the first request. Mirrors the old Mongoose connectDB()'s fail-fast intent.
const connectDB = async () => {
  await prisma.$connect();
  logger.info('Postgres (Neon) connected');
  return prisma;
};

module.exports = connectDB;
