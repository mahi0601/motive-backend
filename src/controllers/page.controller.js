const PageService = require('../services/page.service');
const asyncHandler = require('../utils/asyncHandler');

exports.list = asyncHandler(async (req, res) => {
  const pages = await PageService.list(req.user.id, { workspaceId: req.query.workspaceId });
  res.json({ success: true, pages });
});

exports.search = asyncHandler(async (req, res) => {
  const pages = await PageService.search(req.query.q, req.user.id);
  res.json({ success: true, pages });
});

exports.getOne = asyncHandler(async (req, res) => {
  const page = await PageService.getById(req.params.id, req.user.id);
  res.json({ success: true, page });
});

exports.create = asyncHandler(async (req, res) => {
  const page = await PageService.create(req.body, req.user.id);
  res.status(201).json({ success: true, page });
});

exports.update = asyncHandler(async (req, res) => {
  const page = await PageService.update(req.params.id, req.body, req.user.id);
  res.json({ success: true, page });
});

exports.remove = asyncHandler(async (req, res) => {
  const result = await PageService.remove(req.params.id, req.user.id);
  res.json({ success: true, ...result });
});
