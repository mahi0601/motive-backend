const prisma = require('../config/prisma');
const AppError = require('../utils/AppError');
const workspaceService = require('./workspace.service');
const activityLog = require('./activityLog.service');

// All non-archived pages the user owns, *plus* — when `workspaceId` is
// given — every non-archived page in that workspace the user can at least
// read as a member. Without `workspaceId`, behavior is unchanged from
// before (owned pages only), which is what every existing solo caller does
// today — this only broadens the *opt-in*, explicitly-workspace-scoped case,
// so a client/teammate's page-tree listing actually shows the shared
// workspace's docs instead of just the ones they happen to own themselves.
exports.list = async (userId, { workspaceId } = {}) => {
  if (workspaceId) {
    if (!(await workspaceService.canAccess(workspaceId, userId, 'read'))) return [];
    return prisma.page.findMany({ where: { workspaceId, archived: false }, orderBy: { position: 'asc' } });
  }
  return prisma.page.findMany({ where: { ownerId: userId, archived: false }, orderBy: { position: 'asc' } });
};

// Role-aware access check, shared by getById/update/remove below. Returns
// the page (already fetched) so callers don't re-query. 404s rather than
// 403s on insufficient access — a non-member shouldn't learn a page exists
// at all.
async function assertAccess(id, userId, need = 'read') {
  const page = await prisma.page.findUnique({ where: { id } });
  if (!page) throw AppError.notFound('Page not found');
  const isOwner = page.ownerId === userId;
  if (!isOwner && !(await workspaceService.canAccess(page.workspaceId, userId, need))) {
    throw AppError.notFound('Page not found');
  }
  return page;
}

// Read access is owner OR any workspace member with at least `viewer` —
// broadened for presence/cursors and now the client-portal read view (see
// PLAN "Total scope" §A/C).
exports.getById = async (id, userId) => assertAccess(id, userId, 'read');

exports.create = async (data, userId) => {
  let workspaceId = data.workspaceId;
  if (workspaceId) {
    // An explicit workspaceId (an editor creating a page directly into a
    // shared client/team workspace) needs the same write check as any other
    // mutation — without this, any authenticated caller could pass an
    // arbitrary workspaceId and create a page into a workspace they aren't
    // even a member of.
    if (!(await workspaceService.canAccess(workspaceId, userId, 'write'))) {
      throw AppError.forbidden('You do not have write access to that workspace');
    }
  } else {
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


// Owner, or a workspace editor — a viewer can't reach this at all (assertAccess
// throws first).
exports.update = async (id, data, userId) => {
  await assertAccess(id, userId, 'write');
  const allowed = ['title', 'icon', 'cover', 'parentId', 'position', 'favorite', 'archived'];
  const patch = {};
  for (const key of allowed) if (key in data) patch[key] = data[key];
  return prisma.page.update({ where: { id }, data: patch });
};

// Archive (soft-delete) a page and its descendants. Blocks are deliberately
// left intact — un-archiving (PATCH { archived: false }) is how the frontend
// implements "Undo", and that would restore an empty page if we purged
// content here. Archived pages are already excluded from list/search, so
// leftover blocks are simply inert until the page is restored (or a future
// "empty trash" feature actually purges them).
exports.remove = async (id, userId) => {
  await assertAccess(id, userId, 'write');

  const ids = await collectDescendantIds(id);
  ids.push(id);
  await prisma.page.updateMany({ where: { id: { in: ids } }, data: { archived: true } });
  return { archived: ids.length };
};

// Single recursive query instead of one round-trip per tree level/node —
// a deep or wide page tree used to fan out into N+1 queries here. Scoped by
// the parentId chain alone, not by owner: the root `id` was already
// access-checked by the caller (assertAccess, above), and in a shared
// workspace a descendant page can have a *different* owner than its parent
// (whoever created it) — filtering by a single ownerId here would silently
// skip a teammate's nested pages instead of archiving the whole subtree.
async function collectDescendantIds(parentId) {
  const rows = await prisma.$queryRaw`
    WITH RECURSIVE descendants AS (
      SELECT id FROM "Page" WHERE "parentId" = ${parentId}
      UNION ALL
      SELECT p.id FROM "Page" p
      INNER JOIN descendants d ON p."parentId" = d.id
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
