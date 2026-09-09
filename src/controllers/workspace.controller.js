const WorkspaceService = require('../services/workspace.service');
const asyncHandler = require('../utils/asyncHandler');

exports.list = asyncHandler(async (req, res) => {
  const workspaces = await WorkspaceService.listForUser(req.user.id);
  res.json({ success: true, workspaces });
});

exports.create = asyncHandler(async (req, res) => {
  const workspace = await WorkspaceService.create(req.body, req.user.id);
  res.status(201).json({ success: true, workspace });
});

exports.inviteMember = asyncHandler(async (req, res) => {
  const member = await WorkspaceService.inviteMember(req.params.id, req.user.id, req.body.email);
  res.status(201).json({ success: true, member });
});
