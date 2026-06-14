const Template = require('../models/template.model');
const Block = require('../models/block.model');
const Page = require('../models/page.model');
const builtins = require('../data/builtinTemplates');
const pageService = require('./page.service');
const AppError = require('../utils/AppError');

// A lightweight block-type sequence for the card thumbnail preview.
const previewOf = (blocks = []) => blocks.slice(0, 7).map((b) => b.type);

// Built-ins (from code) + the user's saved custom templates.
exports.list = async (userId) => {
  const custom = await Template.find({ ownerId: userId }).sort('-createdAt').lean();
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
      id: String(t._id),
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

// Resolve a template (built-in by key, or custom by _id owned by the user).
const resolve = async (templateId, userId) => {
  const builtin = builtins.find((t) => t.key === templateId);
  if (builtin) return builtin;

  const custom = await Template.findOne({ _id: templateId, ownerId: userId }).lean();
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
    pageId: page._id,
    type: b.type || 'paragraph',
    content: b.content || {},
    position: i,
  }));
  if (blocks.length) await Block.insertMany(blocks);

  return page;
};

// Save an existing page's blocks as a reusable custom template.
exports.saveFromPage = async (userId, { pageId, name, icon, description }) => {
  const page = await Page.findOne({ _id: pageId, ownerId: userId }).lean();
  if (!page) throw AppError.notFound('Page not found');

  const blocks = await Block.find({ pageId }).sort('position').lean();
  return Template.create({
    name: name || page.title || 'Untitled template',
    icon: icon || page.icon || '⭐',
    description: description || '',
    ownerId: userId,
    blocks: blocks.map((b) => ({ type: b.type, content: b.content })),
  });
};

exports.remove = async (id, userId) => {
  const deleted = await Template.findOneAndDelete({ _id: id, ownerId: userId });
  if (!deleted) throw AppError.notFound('Template not found');
  return { deleted: true };
};
