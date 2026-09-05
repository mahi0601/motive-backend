const prisma = require('../config/prisma');
const builtins = require('../data/builtinTemplates');
const pageService = require('./page.service');
const AppError = require('../utils/AppError');

// A lightweight block-type sequence for the card thumbnail preview.
const previewOf = (blocks = []) => blocks.slice(0, 7).map((b) => b.type);

// Built-ins (from code) + the user's saved custom templates.
exports.list = async (userId) => {
  const custom = await prisma.template.findMany({
    where: { ownerId: userId },
    orderBy: { createdAt: 'desc' },
  });
  return {
    builtIn: builtins.map(({ key, name, icon, description, category, accent, blocks }) => ({
      id: key,
      name,
      icon,
      description,
      category: category || 'General',
      accent: accent || 'violet',
      preview: previewOf(blocks),
      blockCount: blocks.length,
      builtIn: true,
    })),
    custom: custom.map((t) => ({
      id: t.id,
      name: t.name,
      icon: t.icon,
      description: t.description,
      category: 'Yours',
      accent: 'violet',
      preview: previewOf(t.blocks),
      blockCount: (t.blocks || []).length,
      builtIn: false,
    })),
  };
};

// Resolve a template (built-in by key, or custom by id owned by the user).
const resolve = async (templateId, userId) => {
  const builtin = builtins.find((t) => t.key === templateId);
  if (builtin) return builtin;

  const custom = await prisma.template.findFirst({ where: { id: templateId, ownerId: userId } });
  if (!custom) throw AppError.notFound('Template not found');
  return custom;
};

// Create a new page from a template (page + its blocks).
exports.use = async (templateId, userId, { parentId } = {}) => {
  const tpl = await resolve(templateId, userId);

  const page = await pageService.create(
    { title: tpl.name === 'Blank page' ? 'Untitled' : tpl.name, icon: tpl.icon, parentId },
    userId
  );

  const blocks = (tpl.blocks || []).map((b, i) => ({
    pageId: page.id,
    type: b.type || 'paragraph',
    content: b.content || {},
    position: i,
  }));
  if (blocks.length) await prisma.block.createMany({ data: blocks });

  return page;
};

// Save an existing page's blocks as a reusable custom template.
exports.saveFromPage = async (userId, { pageId, name, icon, description }) => {
  const page = await prisma.page.findFirst({ where: { id: pageId, ownerId: userId } });
  if (!page) throw AppError.notFound('Page not found');

  const blocks = await prisma.block.findMany({ where: { pageId }, orderBy: { position: 'asc' } });
  return prisma.template.create({
    data: {
      name: name || page.title || 'Untitled template',
      icon: icon || page.icon || '⭐',
      description: description || '',
      ownerId: userId,
      blocks: blocks.map((b) => ({ type: b.type, content: b.content })),
    },
  });
};

exports.remove = async (id, userId) => {
  const { count } = await prisma.template.deleteMany({ where: { id, ownerId: userId } });
  if (!count) throw AppError.notFound('Template not found');
  return { deleted: true };
};
