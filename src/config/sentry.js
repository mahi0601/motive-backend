// src/config/sentry.js — the actual `Sentry.init()` call lives in
// src/instrument.js (required first thing in index.js, before express/http,
// so its auto-instrumentation can hook into them). This just re-exports the
// SDK, guarded the same way, for server.js's error-handler wiring.
const enabled = !!process.env.SENTRY_DSN;
module.exports = { enabled, Sentry: enabled ? require('@sentry/node') : null };
