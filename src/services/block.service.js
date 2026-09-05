const prisma = require('../config/prisma');
const AppError = require('../utils/AppError');

// Verify the page belongs to the user before touching its blocks.
async function assertPageOwner(pageId, userId) {
  const page = await prisma.page.findFirst({ where: { id: pageId, ownerId: userId }, select: { id: true } });
  if (!page) throw AppError.notFound('Page not found');
}

exports.listByPage = async (pageId, userId) => {
  await assertPageOwner(pageId, userId);
  return prisma.block.findMany({ where: { pageId }, orderBy: { position: 'asc' } });
};

exports.create = async (pageId, data, userId) => {
  await assertPageOwner(pageId, userId);
  let position = data.position;
  if (position === undefined || position === null) {
    position = await prisma.block.count({ where: { pageId } });
  }
  return prisma.block.create({
    data: {
      pageId,
      type: data.type || 'paragraph',
      content: data.content || {},
      position,
    },
  });
};

exports.update = async (id, data, userId) => {
  const block = await prisma.block.findUnique({ where: { id } });
  if (!block) throw AppError.notFound('Block not found');
  await assertPageOwner(block.pageId, userId);

  const patch = {};
  if ('type' in data) patch.type = data.type;
  if ('content' in data) patch.content = data.content;
  if ('position' in data) patch.position = data.position;
  return prisma.block.update({ where: { id }, data: patch });
};

exports.remove = async (id, userId) => {
  const block = await prisma.block.findUnique({ where: { id } });
  if (!block) throw AppError.notFound('Block not found');
  await assertPageOwner(block.pageId, userId);
  await prisma.block.delete({ where: { id } });
  return { deleted: true };
};

// Bulk reorder: [{ id, position }, ...]
exports.reorder = async (pageId, order, userId) => {
  await assertPageOwner(pageId, userId);
  await Promise.all(
    (order || []).map(({ id, position }) =>
      prisma.block.updateMany({ where: { id, pageId }, data: { position } })
    )
  );
  return prisma.block.findMany({ where: { pageId }, orderBy: { position: 'asc' } });
};
