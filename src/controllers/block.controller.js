const BlockService = require('../services/block.service');
const asyncHandler = require('../utils/asyncHandler');
const { getIO } = require('../sockets/socket.handler');

// Notify everyone viewing the page that its blocks changed.
function broadcast(pageId, event, payload) {
  const io = getIO();
  if (io) io.to(`page:${pageId}`).emit(event, payload);
}

exports.listByPage = asyncHandler(async (req, res) => {
  const blocks = await BlockService.listByPage(req.params.pageId, req.user.id);
  res.json({ success: true, blocks });
});

exports.create = asyncHandler(async (req, res) => {
  const block = await BlockService.create(req.params.pageId, req.body, req.user.id);
  broadcast(req.params.pageId, 'block:created', block);
  res.status(201).json({ success: true, block });
});

exports.update = asyncHandler(async (req, res) => {
  const block = await BlockService.update(req.params.id, req.body, req.user.id);
  broadcast(block.pageId, 'block:updated', block);
  res.json({ success: true, block });
});

exports.remove = asyncHandler(async (req, res) => {
  const result = await BlockService.remove(req.params.id, req.user.id);
  res.json({ success: true, ...result });
});

exports.reorder = asyncHandler(async (req, res) => {
  const blocks = await BlockService.reorder(req.params.pageId, req.body.order, req.user.id);
  broadcast(req.params.pageId, 'block:reordered', blocks);
  res.json({ success: true, blocks });
});
