// Single source of truth for "which file types can be uploaded, and what
// MIME type does each one get stored as." Previously upload.middleware.js
// validated the extension and storage.service.js separately stored
// `file.mimetype` — a header the client sets and fully controls. Uploading
// `x.png` with `Content-Type: text/html` got stored (and served back, from
// the R2/CDN domain) as HTML: a stored-XSS vector. The MIME type used for
// storage now always comes from this map, keyed by the *validated*
// extension — the client-declared mimetype is never trusted past the
// upload middleware's own sniff-free extension check.
const MIME_BY_EXTENSION = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.pdf': 'application/pdf',
  '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
};

// Extensions whose MIME type still renders as a webpage-adjacent document if
// a browser is allowed to display it inline — served with
// Content-Disposition: attachment instead of letting it open in-tab.
const DOWNLOAD_ONLY_EXTENSIONS = new Set(['.pdf', '.docx']);

module.exports = {
  ALLOWED_EXTENSIONS: Object.keys(MIME_BY_EXTENSION),
  MIME_BY_EXTENSION,
  DOWNLOAD_ONLY_EXTENSIONS,
};
