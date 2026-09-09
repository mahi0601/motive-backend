const prisma = require('../config/prisma');
const AppError = require('../utils/AppError');
const workspaceService = require('./workspace.service');

// Verify the page belongs to the user before touching its blocks. Mutations
// stay owner-only (see page.service.js's getById for why reads are broader).
async function assertPageOwner(pageId, userId) {
  const page = await prisma.page.findFirst({ where: { id: pageId, ownerId: userId }, select: { id: true } });
  if (!page) throw AppError.notFound('Page not found');
}

// Owner OR any workspace member — lets a shared viewer actually see a
// page's content, not just its title.
async function assertPageReadAccess(pageId, userId) {
  const page = await prisma.page.findUnique({ where: { id: pageId }, select: { ownerId: true, workspaceId: true } });
  if (!page) throw AppError.notFound('Page not found');
  if (page.ownerId !== userId && !(await workspaceService.canAccess(page.workspaceId, userId))) {
    throw AppError.notFound('Page not found');
  }
}

exports.listByPage = async (pageId, userId) => {
  await assertPageReadAccess(pageId, userId);
  return prisma.block.findMany({ where: { pageId }, orderBy: { position: 'asc' } });
};

exports.create = async (pageId, data, userId) => {
  await assertPageOwner(pageId, userId);
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
  await assertPageOwner(block.pageId, userId);

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
  await assertPageOwner(block.pageId, userId);
  await prisma.block.delete({ where: { id } });
  return { deleted: true };
};

// Bulk reorder: [{ id, position }, ...]. Runs as a single transaction so a
// drag that touches many blocks either fully applies or fully rolls back —
// previously a `Promise.all` of independent updates could partially fail
// (or race with a concurrent reorder) and leave positions inconsistent.
exports.reorder = async (pageId, order, userId) => {
  await assertPageOwner(pageId, userId);
  if (order && order.length) {
    await prisma.$transaction(
      order.map(({ id, position }) =>
        prisma.block.updateMany({ where: { id, pageId }, data: { position } })
      )
    );
  }
  return prisma.block.findMany({ where: { pageId }, orderBy: { position: 'asc' } });
};
