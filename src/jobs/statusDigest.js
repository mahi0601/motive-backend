// Hourly check for weekly client emails that are due. The send itself claims the week in the
// database first, so running on every instance, or after a restart, never sends twice.
const logger = require('../config/logger');
const digest = require('../services/statusDigest.service');

const HOUR = 60 * 60 * 1000;
let timer = null;

const runSafely = async () => {
  try {
    const sent = await digest.runDigests();
    if (sent) logger.info('weekly client emails sent', { sent });
  } catch (err) {
    logger.warn('weekly client emails failed', { err: err?.message });
  }
};

exports.start = ({ intervalMs = HOUR } = {}) => {
  if (timer) return timer;
  // First pass a minute after boot, not at boot, so a restart loop cannot hammer the database.
  setTimeout(runSafely, 60 * 1000).unref();
  timer = setInterval(runSafely, intervalMs);
  timer.unref();
  return timer;
};

exports.stop = () => {
  if (timer) clearInterval(timer);
  timer = null;
};
