// Escapes LIKE/ILIKE wildcards so a user's search term is matched literally.
// Prisma's `contains` does NOT escape them — a search for "%" or "_" would
// otherwise match every row. Postgres's default LIKE escape character is the
// backslash, which is what this emits.
exports.escapeLike = (term) => term.replace(/[\\%_]/g, (c) => `\\${c}`);
