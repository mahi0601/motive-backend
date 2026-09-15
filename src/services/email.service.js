// src/services/email.service.js
// Replaces the old Gmail-SMTP-via-nodemailer emailService.js (dead code —
// never imported) with Resend, which has real deliverability guarantees.
// Lazily constructed, same pattern as payment.service.js's Stripe client, so
// the app still boots without RESEND_API_KEY configured — email sending
// just no-ops with a console warning instead of crashing the process.
const config = require('../config/env');
const logger = require('../config/logger');

let resendClient;
function getClient() {
  if (!config.resend.apiKey) return null;
  if (!resendClient) {
    const { Resend } = require('resend');
    resendClient = new Resend(config.resend.apiKey);
  }
  return resendClient;
}

exports.sendEmail = async ({ to, subject, html }) => {
  const client = getClient();
  if (!client) {
    // Was interpolating the recipient's actual email address straight into
    // a console.warn message — a real PII leak into stdout (and, once
    // Logtail is configured, into a third-party log store). This is a
    // config-state warning ("email sending is disabled"), not something
    // that needs the specific address to be useful.
    logger.warn('RESEND_API_KEY not set — skipping email send', { subject });
    return;
  }
  try {
    await client.emails.send({ from: config.resend.fromEmail, to, subject, html });
  } catch (err) {
    // Reportable: a real send failure (bad API key, Resend outage, domain
    // not verified) is exactly the kind of thing that used to be
    // completely invisible to Sentry.
    logger.error('Email send error', err, { subject });
  }
};
