const Page = require('../models/page.model');
const Block = require('../models/block.model');
const AppError = require('../utils/AppError');
const workspaceService = require('./workspace.service');

// All non-archived pages the user owns (optionally in a workspace).
exports.list = async (userId, { workspaceId } = {}) => {
  const query = { ownerId: userId, archived: false };
  if (workspaceId) query.workspaceId = workspaceId;
  return Page.find(query).sort('position').lean();
};

exports.getById = async (id, userId) => {
  const page = await Page.findOne({ _id: id, ownerId: userId });
  if (!page) throw AppError.notFound('Page not found');
  return page;
};

exports.create = async (data, userId) => {
  let workspaceId = data.workspaceId;
  if (!workspaceId) {
    const ws = await workspaceService.getDefault(userId);
    workspaceId = ws._id;
  }
  const count = await Page.countDocuments({ ownerId: userId, parentId: data.parentId || null });
  return Page.create({
    title: data.title || 'Untitled',
    icon: data.icon,
    parentId: data.parentId || null,
    workspaceId,
    ownerId: userId,
    position: count,
  });
};

exports.update = async (id, data, userId) => {
  const allowed = ['title', 'icon', 'cover', 'parentId', 'position', 'favorite', 'archived'];
  const patch = {};
  for (const key of allowed) if (key in data) patch[key] = data[key];

  const page = await Page.findOneAndUpdate({ _id: id, ownerId: userId }, patch, { new: true });
  if (!page) throw AppError.notFound('Page not found');
  return page;
};

// Archive (soft-delete) a page and its descendants + blocks.
exports.remove = async (id, userId) => {
  const page = await Page.findOne({ _id: id, ownerId: userId });
  if (!page) throw AppError.notFound('Page not found');

  const ids = await collectDescendantIds(id, userId);
  ids.push(id);
  await Page.updateMany({ _id: { $in: ids }, ownerId: userId }, { archived: true });
  await Block.deleteMany({ pageId: { $in: ids } });
  return { archived: ids.length };
};

async function collectDescendantIds(parentId, userId) {
  const children = await Page.find({ parentId, ownerId: userId }).select('_id').lean();
  let ids = children.map((c) => c._id);
  for (const child of children) {
    ids = ids.concat(await collectDescendantIds(child._id, userId));
  }
  return ids;
}

// Full-text search across page titles and block text.
exports.search = async (term, userId) => {
  if (!term || !term.trim()) return [];
  const byTitle = await Page.find({
    ownerId: userId,
    archived: false,
    $text: { $search: term },
  })
    .limit(20)
    .lean();

  const blockHits = await Block.find({ $text: { $search: term } })
    .limit(20)
    .lean();
  const pageIds = [...new Set(blockHits.map((b) => String(b.pageId)))];
  const byContent = await Page.find({
    _id: { $in: pageIds },
    ownerId: userId,
    archived: false,
  }).lean();

  const map = new Map();
  [...byTitle, ...byContent].forEach((p) => map.set(String(p._id), p));
  return [...map.values()];
};
