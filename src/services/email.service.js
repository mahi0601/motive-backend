// src/services/email.service.js
// Replaces the old Gmail-SMTP-via-nodemailer emailService.js (dead code —
// never imported) with Resend, which has real deliverability guarantees.
// Lazily constructed, same pattern as payment.service.js's Stripe client, so
// the app still boots without RESEND_API_KEY configured — email sending
// just no-ops with a console warning instead of crashing the process.
const config = require('../config/env');

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
    console.warn(`📧 RESEND_API_KEY not set — skipping email to ${to}: "${subject}"`);
    return;
  }
  try {
    await client.emails.send({ from: config.resend.fromEmail, to, subject, html });
  } catch (err) {
    console.error('📧 Email send error:', err.message);
  }
};
