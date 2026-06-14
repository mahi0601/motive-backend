const TemplateService = require('../services/template.service');
const asyncHandler = require('../utils/asyncHandler');

exports.list = asyncHandler(async (req, res) => {
  const templates = await TemplateService.list(req.user.id);
  res.json({ success: true, ...templates });
});

// Create a new page from a template → returns the new page.
exports.use = asyncHandler(async (req, res) => {
  const page = await TemplateService.use(req.params.id, req.user.id, {
    parentId: req.body.parentId || null,
  });
  res.status(201).json({ success: true, page });
});

// Save an existing page as a custom template.
exports.saveFromPage = asyncHandler(async (req, res) => {
  const tpl = await TemplateService.saveFromPage(req.user.id, req.body);
  res.status(201).json({ success: true, template: tpl });
});

exports.remove = asyncHandler(async (req, res) => {
  const result = await TemplateService.remove(req.params.id, req.user.id);
  res.json({ success: true, ...result });
});
