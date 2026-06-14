/**
 * Parse ?page & ?limit query params into safe skip/limit values.
 * Bounds the limit so a client can't request a million docs and exhaust memory.
 */
exports.getPagination = (query = {}, { defaultLimit = 20, maxLimit = 100 } = {}) => {
  const page = Math.max(1, parseInt(query.page, 10) || 1);
  const limit = Math.min(maxLimit, Math.max(1, parseInt(query.limit, 10) || defaultLimit));
  return { page, limit, skip: (page - 1) * limit };
};

// Shape a paginated payload consistently across all list endpoints.
exports.paginated = (items, total, { page, limit }) => ({
  items,
  pagination: {
    page,
    limit,
    total,
    totalPages: Math.ceil(total / limit) || 1,
    hasMore: page * limit < total,
  },
});
