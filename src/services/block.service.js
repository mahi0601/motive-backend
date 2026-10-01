const prisma = require('../config/prisma');
const AppError = require('../utils/AppError');
const workspaceService = require('./workspace.service');

// Role-aware access check on the block's *page* — a block has no owner or
// workspace of its own, it inherits both from `Page`, so every Block mutation
// routes through the same owner-or-role check as Page writes. 404s rather
// than 403s, matching
// page.service.js#assertAccess — a non-member shouldn't learn the page
// exists at all.
async function assertPageAccess(pageId, userId, need = 'read') {
  const page = await prisma.page.findUnique({ where: { id: pageId }, select: { ownerId: true, workspaceId: true } });
  if (!page) throw AppError.notFound('Page not found');
  await workspaceService.assertResourceAccess(page, userId, need, 'Page not found');
}
// Exported so socket.handler.js can gate `page:join` with the exact same
// check block mutations already go through, instead of a room anyone
// holding a pageId could join unchecked.
exports.assertPageAccess = assertPageAccess;

// A toggle's child must live on the same page as the toggle. Without this a
// caller with write access to page A could set `parentBlockId` to a block on
// page B they can't access, attaching (and exposing the existence of) content
// across pages. `blockId` is passed on update so a block can't parent itself.
async function assertParentBlockOnPage(pageId, parentBlockId, blockId) {
  if (!parentBlockId) return;
  if (parentBlockId === blockId) throw AppError.badRequest('A block cannot be its own parent');
  const parent = await prisma.block.findUnique({ where: { id: parentBlockId }, select: { pageId: true } });
  if (!parent || parent.pageId !== pageId) {
    throw AppError.badRequest('Parent block must be on the same page');
  }
}

exports.listByPage = async (pageId, userId) => {
  await assertPageAccess(pageId, userId, 'read');
  return prisma.block.findMany({ where: { pageId }, orderBy: { position: 'asc' } });
};

exports.create = async (pageId, data, userId) => {
  await assertPageAccess(pageId, userId, 'write');
  const parentBlockId = data.parentBlockId || null;
  await assertParentBlockOnPage(pageId, parentBlockId);

  if (data.position !== undefined && data.position !== null) {
    return prisma.block.create({
      data: { pageId, type: data.type || 'paragraph', content: data.content || {}, position: data.position, parentBlockId },
    });
  }

  // count+create wrapped in a Serializable transaction so two concurrent
  // creates among the same siblings can't collide on `position`. Scoped to
  // siblings — a child's position sequence is independent of its parent
  // toggle's top-level position, so reordering one never touches the other.
  return prisma.$transaction(
    async (tx) => {
      const position = await tx.block.count({ where: { pageId, parentBlockId } });
      return tx.block.create({
        data: { pageId, type: data.type || 'paragraph', content: data.content || {}, position, parentBlockId },
      });
    },
    { isolationLevel: 'Serializable' }
  );
};

exports.update = async (id, data, userId) => {
  const block = await prisma.block.findUnique({ where: { id } });
  if (!block) throw AppError.notFound('Block not found');
  await assertPageAccess(block.pageId, userId, 'write');

  const patch = {};
  if ('type' in data) patch.type = data.type;
  if ('content' in data) patch.content = data.content;
  if ('position' in data) patch.position = data.position;
  // Indent/outdent under a toggle — the frontend computes both the new
  // parent and the resulting position (e.g. "last among the new siblings"),
  // since it already has the full block list loaded.
  if ('parentBlockId' in data) {
    await assertParentBlockOnPage(block.pageId, data.parentBlockId, id);
    patch.parentBlockId = data.parentBlockId;
  }
  return prisma.block.update({ where: { id }, data: patch });
};

exports.remove = async (id, userId) => {
  const block = await prisma.block.findUnique({ where: { id } });
  if (!block) throw AppError.notFound('Block not found');
  await assertPageAccess(block.pageId, userId, 'write');
  await prisma.block.delete({ where: { id } });
  return { deleted: true };
};

// Bulk reorder: [{ id, position }, ...]. Runs as a single transaction so a
// drag that touches many blocks either fully applies or fully rolls back —
// previously a `Promise.all` of independent updates could partially fail
// (or race with a concurrent reorder) and leave positions inconsistent.
exports.reorder = async (pageId, order, userId) => {
  await assertPageAccess(pageId, userId, 'write');
  if (order && order.length) {
    await prisma.$transaction(
      order.map(({ id, position }) =>
        prisma.block.updateMany({ where: { id, pageId }, data: { position } })
      )
    );
  }
  return prisma.block.findMany({ where: { pageId }, orderBy: { position: 'asc' } });
};
