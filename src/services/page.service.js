const prisma = require('../config/prisma');
const AppError = require('../utils/AppError');
const workspaceService = require('./workspace.service');
const activityLog = require('./activityLog.service');

// All non-archived pages the user owns (optionally in a workspace).
exports.list = async (userId, { workspaceId } = {}) => {
  const where = { ownerId: userId, archived: false };
  if (workspaceId) where.workspaceId = workspaceId;
  return prisma.page.findMany({ where, orderBy: { position: 'asc' } });
};

// Read access is owner OR any workspace member — broadened for
// presence/cursors (previously strictly owner-only, so a workspace member
// could never even view a shared page, which made "collaborative editing"
// meaningless beyond a single user). Writes (update/remove below, and block
// mutations in block.service.js) stay owner-only for now; extending them to
// workspace members is a real authorization design question (which roles
// get write access?) that's out of scope here.
exports.getById = async (id, userId) => {
  const page = await prisma.page.findUnique({ where: { id } });
  if (!page) throw AppError.notFound('Page not found');
  if (page.ownerId !== userId && !(await workspaceService.canAccess(page.workspaceId, userId))) {
    throw AppError.notFound('Page not found');
  }
  return page;
};

exports.create = async (data, userId) => {
  let workspaceId = data.workspaceId;
  if (!workspaceId) {
    const ws = await workspaceService.getDefault(userId);
    workspaceId = ws.id;
  }
  // count+create wrapped in a Serializable transaction so two concurrent
  // creates under the same parent can't both read the same count and
  // collide on `position`.
  const page = await prisma.$transaction(
    async (tx) => {
      const count = await tx.page.count({
        where: { ownerId: userId, parentId: data.parentId || null },
      });
      return tx.page.create({
        data: {
          title: data.title || 'Untitled',
          icon: data.icon,
          parentId: data.parentId || null,
          workspaceId,
          ownerId: userId,
          position: count,
        },
      });
    },
    { isolationLevel: 'Serializable' }
  );
  activityLog.log('created', userId, { description: `Created page "${page.title}"` });
  return page;
};


exports.update = async (id, data, userId) => {
  const allowed = ['title', 'icon', 'cover', 'parentId', 'position', 'favorite', 'archived'];
  const patch = {};
  for (const key of allowed) if (key in data) patch[key] = data[key];

  const { count } = await prisma.page.updateMany({ where: { id, ownerId: userId }, data: patch });
  if (!count) throw AppError.notFound('Page not found');
  return prisma.page.findUnique({ where: { id } });
};

// Archive (soft-delete) a page and its descendants. Blocks are deliberately
// left intact — un-archiving (PATCH { archived: false }) is how the frontend
// implements "Undo", and that would restore an empty page if we purged
// content here. Archived pages are already excluded from list/search, so
// leftover blocks are simply inert until the page is restored (or a future
// "empty trash" feature actually purges them).
exports.remove = async (id, userId) => {
  const page = await prisma.page.findFirst({ where: { id, ownerId: userId } });
  if (!page) throw AppError.notFound('Page not found');

  const ids = await collectDescendantIds(id, userId);
  ids.push(id);
  await prisma.page.updateMany({ where: { id: { in: ids }, ownerId: userId }, data: { archived: true } });
  return { archived: ids.length };
};

// Single recursive query instead of one round-trip per tree level/node —
// a deep or wide page tree used to fan out into N+1 queries here.
async function collectDescendantIds(parentId, userId) {
  const rows = await prisma.$queryRaw`
    WITH RECURSIVE descendants AS (
      SELECT id FROM "Page" WHERE "parentId" = ${parentId} AND "ownerId" = ${userId}
      UNION ALL
      SELECT p.id FROM "Page" p
      INNER JOIN descendants d ON p."parentId" = d.id
      WHERE p."ownerId" = ${userId}
    )
    SELECT id FROM descendants;
  `;
  return rows.map((r) => r.id);
}

// Search across page titles and block text. Substring match (case-insensitive)
// rather than Mongo's $text index — fine at this scale; a Postgres tsvector
// column is the upgrade path if it ever isn't.
exports.search = async (term, userId) => {
  if (!term || !term.trim()) return [];

  const byTitle = await prisma.page.findMany({
    where: { ownerId: userId, archived: false, title: { contains: term, mode: 'insensitive' } },
    take: 20,
  });

  // Scoped to the caller's own pages in the query itself — previously this
  // scanned every tenant's blocks for a match before filtering by owner
  // afterward, which was both a full cross-tenant table scan and let other
  // users' matches crowd out the caller's own within the `take: 20` cap.
  const blockHits = await prisma.block.findMany({
    where: {
      content: { path: ['text'], string_contains: term },
      page: { ownerId: userId, archived: false },
    },
    take: 20,
    select: { pageId: true },
  });
  const pageIds = [...new Set(blockHits.map((b) => b.pageId))];
  const byContent = pageIds.length
    ? await prisma.page.findMany({
        where: { id: { in: pageIds }, ownerId: userId, archived: false },
      })
    : [];

  const map = new Map();
  [...byTitle, ...byContent].forEach((p) => map.set(p.id, p));
  return [...map.values()];
};
