// Prints the product funnel: node scripts/funnel.js [--days 30]
// Reads DATABASE_URL like the app does. Run it against production from a Render
// shell, or locally against a copy.
require('dotenv').config({ quiet: true });
const analytics = require('../src/services/analytics.service');
const prisma = require('../src/config/prisma');

const i = process.argv.indexOf('--days');
const days = i > -1 ? Math.max(1, parseInt(process.argv[i + 1], 10) || 30) : 30;

(async () => {
  const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000);
  console.log(analytics.formatFunnel(await analytics.funnel({ since }), days));
})()
  .catch((err) => {
    console.error('Could not read the funnel:', err.message);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
