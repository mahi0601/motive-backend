// src/instrument.js — Sentry must be initialized before any other module
// (express, http, etc.) is required, so its auto-instrumentation can hook
// into them. This is why index.js requires this file first, ahead of even
// ./config/env. See https://docs.sentry.io/platforms/node/
require('dotenv').config();

if (process.env.SENTRY_DSN) {
  const Sentry = require('@sentry/node');
  Sentry.init({
    dsn: process.env.SENTRY_DSN,
    environment: process.env.NODE_ENV || 'development',
    // Low sample rate — this is a small app; full tracing isn't needed to
    // get value out of error tracking, just cheap enough to leave always on.
    tracesSampleRate: 0.1,
  });
}
