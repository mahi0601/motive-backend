const Block = require('../models/block.model');
const Page = require('../models/page.model');
const AppError = require('../utils/AppError');

// Verify the page belongs to the user before touching its blocks.
async function assertPageOwner(pageId, userId) {
  const page = await Page.findOne({ _id: pageId, ownerId: userId }).select('_id').lean();
  if (!page) throw AppError.notFound('Page not found');
}

exports.listByPage = async (pageId, userId) => {
  await assertPageOwner(pageId, userId);
  return Block.find({ pageId }).sort('position').lean();
};

exports.create = async (pageId, data, userId) => {
  await assertPageOwner(pageId, userId);
  let position = data.position;
  if (position === undefined || position === null) {
    position = await Block.countDocuments({ pageId });
  }
  return Block.create({
    pageId,
    type: data.type || 'paragraph',
    content: data.content || {},
    position,
  });
};

exports.update = async (id, data, userId) => {
  const block = await Block.findById(id);
  if (!block) throw AppError.notFound('Block not found');
  await assertPageOwner(block.pageId, userId);

  if ('type' in data) block.type = data.type;
  if ('content' in data) block.content = data.content;
  if ('position' in data) block.position = data.position;
  await block.save();
  return block;
};

exports.remove = async (id, userId) => {
  const block = await Block.findById(id);
  if (!block) throw AppError.notFound('Block not found');
  await assertPageOwner(block.pageId, userId);
  await block.deleteOne();
  return { deleted: true };
};

// Bulk reorder: [{ id, position }, ...]
exports.reorder = async (pageId, order, userId) => {
  await assertPageOwner(pageId, userId);
  await Promise.all(
    (order || []).map(({ id, position }) =>
      Block.updateOne({ _id: id, pageId }, { position })
    )
  );
  return Block.find({ pageId }).sort('position').lean();
};
