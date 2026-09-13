const prisma = require('../config/prisma');
const AppError = require('../utils/AppError');
const workspaceService = require('./workspace.service');

// Role-aware access check on the block's *page* — a block has no owner or
// workspace of its own, it inherits both from `Page` (see PLAN "Total
// scope" §A: "every Block mutation" routes through the same owner-or-role
// check as Page writes now do). 404s rather than 403s, matching
// page.service.js#assertAccess — a non-member shouldn't learn the page
// exists at all.
async function assertPageAccess(pageId, userId, need = 'read') {
  const page = await prisma.page.findUnique({ where: { id: pageId }, select: { ownerId: true, workspaceId: true } });
  if (!page) throw AppError.notFound('Page not found');
  const isOwner = page.ownerId === userId;
  if (!isOwner && !(await workspaceService.canAccess(page.workspaceId, userId, need))) {
    throw AppError.notFound('Page not found');
  }
}

exports.listByPage = async (pageId, userId) => {
  await assertPageAccess(pageId, userId, 'read');
  return prisma.block.findMany({ where: { pageId }, orderBy: { position: 'asc' } });
};

exports.create = async (pageId, data, userId) => {
  await assertPageAccess(pageId, userId, 'write');
  const parentBlockId = data.parentBlockId || null;

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
  if ('parentBlockId' in data) patch.parentBlockId = data.parentBlockId;
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
