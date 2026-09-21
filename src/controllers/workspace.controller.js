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

exports.createInvite = asyncHandler(async (req, res) => {
  const invite = await WorkspaceService.createInvite(req.params.id, req.user.id, req.body.email, req.body.role);
  res.status(201).json({ success: true, invite });
});

exports.listInvites = asyncHandler(async (req, res) => {
  const invites = await WorkspaceService.listInvites(req.params.id, req.user.id);
  res.json({ success: true, invites });
});

exports.resendInvite = asyncHandler(async (req, res) => {
  const invite = await WorkspaceService.resendInvite(req.params.id, req.params.inviteId, req.user.id);
  res.json({ success: true, invite });
});

exports.revokeInvite = asyncHandler(async (req, res) => {
  await WorkspaceService.revokeInvite(req.params.id, req.params.inviteId, req.user.id);
  res.json({ success: true });
});

exports.updateMemberRole = asyncHandler(async (req, res) => {
  const member = await WorkspaceService.updateMemberRole(req.params.id, req.params.userId, req.body.role, req.user.id);
  res.json({ success: true, member });
});

exports.removeMember = asyncHandler(async (req, res) => {
  await WorkspaceService.removeMember(req.params.id, req.params.userId, req.user.id);
  res.json({ success: true });
});

exports.transferOwnership = asyncHandler(async (req, res) => {
  await WorkspaceService.transferOwnership(req.params.id, req.body.userId, req.user.id);
  res.json({ success: true });
});

exports.leaveWorkspace = asyncHandler(async (req, res) => {
  await WorkspaceService.leaveWorkspace(req.params.id, req.user.id);
  res.json({ success: true });
});
