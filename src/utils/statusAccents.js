// The accent colours an owner may choose for their public status page. Keys
// only: the actual colours live in the web app (config/statusAccents.js), which
// checks each one for contrast. A fixed list, rather than a free colour, means
// nothing user-supplied ever reaches CSS and every choice is readable.
const ACCENTS = ['teal', 'blue', 'violet', 'rose', 'amber', 'slate'];

module.exports = { ACCENTS, DEFAULT_ACCENT: 'teal' };
