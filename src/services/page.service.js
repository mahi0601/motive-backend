const prisma = require('../config/prisma');
const AppError = require('../utils/AppError');
const workspaceService = require('./workspace.service');
const activityLog = require('./activityLog.service');
const { escapeLike } = require('../utils/like');

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
    // The caller's own default workspace also owns any of their pages that
    // predate workspaces (workspaceId is nullable) — otherwise switching to
    // "My Workspace" would hide them. Only their own, only for that workspace.
    const defaultWs = await workspaceService.getDefault(userId);
    const scope =
      defaultWs.id === workspaceId ? { OR: [{ workspaceId }, { ownerId: userId, workspaceId: null }] } : { workspaceId };
    return prisma.page.findMany({ where: { ...scope, archived: false }, orderBy: { position: 'asc' } });
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
  await workspaceService.assertResourceAccess(page, userId, need, 'Page not found');
  return page;
}

// A page can only be nested under a parent the caller can write to, and only
// within the same workspace — otherwise a caller could attach their page to
// (or move it into) a page tree they have no access to, surfacing it there.
async function assertParentUsable(parentId, workspaceId, userId) {
  const parent = await assertAccess(parentId, userId, 'write');
  if (parent.workspaceId !== workspaceId) {
    throw AppError.badRequest('Parent page must be in the same workspace');
  }
}

// Read access is owner OR any workspace member with at least `viewer` —
// broadened for presence/cursors and now the client-portal read view.
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
  if (data.parentId) await assertParentUsable(data.parentId, workspaceId, userId);
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
  const current = await assertAccess(id, userId, 'write');
  const allowed = ['title', 'icon', 'cover', 'parentId', 'position', 'favorite', 'archived'];
  const patch = {};
  for (const key of allowed) if (key in data) patch[key] = data[key];

  // Re-parenting onto the page itself or one of its own descendants would
  // create a cycle in the parentId chain. `collectDescendantIds`'s recursive
  // CTE has no cycle detection (see its own comment below), so a cycle here
  // isn't just a display bug — the next remove()/search() walk down this
  // tree recurses forever and pins the DB connection. Checked here, not in
  // the DB, since Prisma/Postgres won't enforce a "no cycles" constraint for
  // us on a self-referencing FK.
  if ('parentId' in patch && patch.parentId) {
    if (patch.parentId === id) throw AppError.badRequest('A page cannot be its own parent');
    await assertParentUsable(patch.parentId, current.workspaceId, userId);
    const descendantIds = await collectDescendantIds(id);
    if (descendantIds.includes(patch.parentId)) {
      throw AppError.badRequest('Cannot move a page into its own subtree');
    }
  }

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
  // `depth` + the WHERE guard below is defense in depth, not the primary
  // cycle guard — update()/create() reject a cycle-forming parentId before
  // it's ever written. This just caps the blast radius (a runaway query
  // pinning the DB connection) if a cycle ever reaches the table some other
  // way (a direct DB edit, a future write path that forgets the check).
  const rows = await prisma.$queryRaw`
    WITH RECURSIVE descendants AS (
      SELECT id, "parentId", 1 AS depth FROM "Page" WHERE "parentId" = ${parentId}
      UNION ALL
      SELECT p.id, p."parentId", d.depth + 1 FROM "Page" p
      INNER JOIN descendants d ON p."parentId" = d.id
      WHERE d.depth < 1000
    )
    SELECT id FROM descendants;
  `;
  return rows.map((r) => r.id);
}

// Search across page titles and block text. Substring match (case-insensitive)
// rather than Mongo's $text index — fine at this scale; a Postgres tsvector
// column is the upgrade path if it ever isn't.
//
// Covers the caller's own pages plus every page in any workspace they belong
// to (owner or member), so a teammate's or client's page is as findable as
// your own. Every query below is scoped to that set in SQL itself — never a
// cross-tenant scan filtered afterward.
exports.search = async (term, userId) => {
  if (!term || !term.trim()) return [];
  const query = term.trim();

  const accessible = {
    OR: [{ ownerId: userId }, { workspace: { OR: [{ ownerId: userId }, { members: { some: { userId } } }] } }],
  };

  const byTitle = await prisma.page.findMany({
    where: { AND: [accessible, { archived: false, title: { contains: escapeLike(query), mode: 'insensitive' } }] },
    take: 20,
  });

  // Prisma's JSON string filters are case-sensitive and can't look inside
  // both `content.text` (legacy plain blocks) and `content.html` (rich-text
  // blocks), so this is raw SQL — parameterized, with LIKE wildcards in the
  // user's term escaped. Tags are stripped from `html` first so searching
  // "b" doesn't match every <b> tag.
  const pattern = `%${escapeLike(query)}%`;
  const hits = await prisma.$queryRaw`
    SELECT DISTINCT b."pageId"
    FROM "Block" b
    JOIN "Page" p ON p.id = b."pageId"
    LEFT JOIN "Workspace" w ON w.id = p."workspaceId"
    WHERE p.archived = false
      AND (
        p."ownerId" = ${userId}
        OR w."ownerId" = ${userId}
        OR EXISTS (
          SELECT 1 FROM "WorkspaceMember" m
          WHERE m."workspaceId" = p."workspaceId" AND m."userId" = ${userId}
        )
      )
      AND (
        b.content->>'text' ILIKE ${pattern}
        OR regexp_replace(b.content->>'html', '<[^>]*>', '', 'g') ILIKE ${pattern}
      )
    LIMIT 20
  `;
  const pageIds = hits.map((r) => r.pageId);
  const byContent = pageIds.length
    ? await prisma.page.findMany({
        where: { AND: [accessible, { id: { in: pageIds }, archived: false }] },
      })
    : [];

  const map = new Map();
  [...byTitle, ...byContent].forEach((p) => map.set(p.id, p));
  return [...map.values()];
};
