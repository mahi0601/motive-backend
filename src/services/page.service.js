const prisma = require('../config/prisma');
const AppError = require('../utils/AppError');
const workspaceService = require('./workspace.service');

// All non-archived pages the user owns (optionally in a workspace).
exports.list = async (userId, { workspaceId } = {}) => {
  const where = { ownerId: userId, archived: false };
  if (workspaceId) where.workspaceId = workspaceId;
  return prisma.page.findMany({ where, orderBy: { position: 'asc' } });
};

exports.getById = async (id, userId) => {
  const page = await prisma.page.findFirst({ where: { id, ownerId: userId } });
  if (!page) throw AppError.notFound('Page not found');
  return page;
};

exports.create = async (data, userId) => {
  let workspaceId = data.workspaceId;
  if (!workspaceId) {
    const ws = await workspaceService.getDefault(userId);
    workspaceId = ws.id;
  }
  const count = await prisma.page.count({
    where: { ownerId: userId, parentId: data.parentId || null },
  });
  return prisma.page.create({
    data: {
      title: data.title || 'Untitled',
      icon: data.icon,
      parentId: data.parentId || null,
      workspaceId,
      ownerId: userId,
      position: count,
    },
  });
};

exports.update = async (id, data, userId) => {
  const allowed = ['title', 'icon', 'cover', 'parentId', 'position', 'favorite', 'archived'];
  const patch = {};
  for (const key of allowed) if (key in data) patch[key] = data[key];

  const { count } = await prisma.page.updateMany({ where: { id, ownerId: userId }, data: patch });
  if (!count) throw AppError.notFound('Page not found');
  return prisma.page.findUnique({ where: { id } });
};

// Archive (soft-delete) a page and its descendants + blocks.
exports.remove = async (id, userId) => {
  const page = await prisma.page.findFirst({ where: { id, ownerId: userId } });
  if (!page) throw AppError.notFound('Page not found');

  const ids = await collectDescendantIds(id, userId);
  ids.push(id);
  await prisma.page.updateMany({ where: { id: { in: ids }, ownerId: userId }, data: { archived: true } });
  await prisma.block.deleteMany({ where: { pageId: { in: ids } } });
  return { archived: ids.length };
};

async function collectDescendantIds(parentId, userId) {
  const children = await prisma.page.findMany({
    where: { parentId, ownerId: userId },
    select: { id: true },
  });
  let ids = children.map((c) => c.id);
  for (const child of children) {
    ids = ids.concat(await collectDescendantIds(child.id, userId));
  }
  return ids;
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

  const blockHits = await prisma.block.findMany({
    where: { content: { path: ['text'], string_contains: term } },
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
