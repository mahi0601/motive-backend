const ClientTemplateService = require('../services/clientTemplate.service');
const asyncHandler = require('../utils/asyncHandler');

exports.list = asyncHandler(async (req, res) => {
  res.json({ success: true, templates: await ClientTemplateService.list(req.user.id) });
});

exports.save = asyncHandler(async (req, res) => {
  res.status(201).json({ success: true, template: await ClientTemplateService.save(req.user.id, req.body) });
});

exports.remove = asyncHandler(async (req, res) => {
  await ClientTemplateService.remove(req.user.id, req.params.id);
  res.json({ success: true });
});

exports.use = asyncHandler(async (req, res) => {
  res.status(201).json({ success: true, ...(await ClientTemplateService.use(req.user.id, req.params.id, req.body)) });
});
