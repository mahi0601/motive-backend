const BlockService = require('../services/block.service');
const { getIO } = require('../sockets/socket.handler');

// Notify everyone viewing the page that its blocks changed.
function broadcast(pageId, event, payload) {
  const io = getIO();
  if (io) io.to(`page:${pageId}`).emit(event, payload);
}

exports.listByPage = async (req, res, next) => {
  try {
    const blocks = await BlockService.listByPage(req.params.pageId, req.user.id);
    res.json(blocks);
  } catch (err) {
    next(err);
  }
};

exports.create = async (req, res, next) => {
  try {
    const block = await BlockService.create(req.params.pageId, req.body, req.user.id);
    broadcast(req.params.pageId, 'block:created', block);
    res.status(201).json(block);
  } catch (err) {
    next(err);
  }
};

exports.update = async (req, res, next) => {
  try {
    const block = await BlockService.update(req.params.id, req.body, req.user.id);
    broadcast(block.pageId, 'block:updated', block);
    res.json(block);
  } catch (err) {
    next(err);
  }
};

exports.remove = async (req, res, next) => {
  try {
    const result = await BlockService.remove(req.params.id, req.user.id);
    res.json(result);
  } catch (err) {
    next(err);
  }
};

exports.reorder = async (req, res, next) => {
  try {
    const blocks = await BlockService.reorder(req.params.pageId, req.body.order, req.user.id);
    broadcast(req.params.pageId, 'block:reordered', blocks);
    res.json(blocks);
  } catch (err) {
    next(err);
  }
};
