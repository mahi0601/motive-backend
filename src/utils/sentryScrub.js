// Keeps credentials that travel in URLs out of Sentry. Same secrets as
// scrubUrl in config/logger.js (status-page token, invite tokens, Stripe
// checkout session id, query-string values), but works on full URLs and on the
// shapes a Sentry event/breadcrumb carries them in. No dependencies, so it can
// be loaded from instrument.js before anything else.
const TOKEN_PATH = /(\/api\/(?:status|invites|payments\/session)\/)[^/?#\s]+/gi;
const SENSITIVE_PARAMS = new Set(['token', 'csrf', 'code', 'state', 'invite', 'session_id']);
const MASK = '[redacted]';

function scrubUrl(url) {
  if (typeof url !== 'string' || !url) return url;
  const hash = url.indexOf('#');
  const noHash = hash === -1 ? url : url.slice(0, hash);
  const q = noHash.indexOf('?');
  const path = (q === -1 ? noHash : noHash.slice(0, q)).replace(TOKEN_PATH, `$1${MASK}`);
  if (q === -1) return path;
  // Keep the keys (useful for debugging), drop every value that could be secret.
  const params = new URLSearchParams(noHash.slice(q + 1));
  for (const key of params.keys()) if (SENSITIVE_PARAMS.has(key)) params.set(key, MASK);
  return `${path}?${params.toString()}`;
}

function scrubBreadcrumb(crumb) {
  if (!crumb || !crumb.data) return crumb;
  const data = { ...crumb.data };
  for (const k of ['url', 'from', 'to']) if (typeof data[k] === 'string') data[k] = scrubUrl(data[k]);
  return { ...crumb, data };
}

function scrubEvent(event) {
  if (!event) return event;
  const out = { ...event };
  if (out.request) {
    const req = { ...out.request };
    if (req.url) req.url = scrubUrl(req.url);
    if (req.query_string) req.query_string = MASK;
    if (req.headers) {
      req.headers = { ...req.headers };
      for (const h of ['cookie', 'Cookie', 'authorization', 'Authorization', 'x-csrf-token', 'X-CSRF-Token', 'stripe-signature']) delete req.headers[h];
    }
    delete req.cookies;
    out.request = req;
  }
  if (typeof out.transaction === 'string') out.transaction = scrubUrl(out.transaction);
  if (Array.isArray(out.breadcrumbs)) out.breadcrumbs = out.breadcrumbs.map(scrubBreadcrumb);
  return out;
}

module.exports = { scrubUrl, scrubEvent, scrubBreadcrumb };
