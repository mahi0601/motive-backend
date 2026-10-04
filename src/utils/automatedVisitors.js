// Link previews (Slack, WhatsApp, iMessage), search crawlers, uptime monitors and scripts open
// a status link with no person behind it. They still get the page, but they must not count as a
// client looking, or the view numbers and the "someone opened your page" notice would be wrong.
//
// Deliberately conservative: only names that clearly belong to automated tools match. A header
// that is missing, or that we cannot place, counts as a person: under-counting a real client is
// worse than counting a stray script. The input is capped so a huge header costs nothing.
const AUTOMATED =
  /bot\b|bot[/ ;)_]|crawl|spider|slurp|preview|facebookexternalhit|whatsapp|telegram|discord|slack|embedly|pingdom|uptime|monitor|headless|lighthouse|curl\/|wget|python-requests|go-http-client|postman|scrapy/i;

exports.isAutomated = (userAgent) => typeof userAgent === 'string' && AUTOMATED.test(userAgent.slice(0, 512));
