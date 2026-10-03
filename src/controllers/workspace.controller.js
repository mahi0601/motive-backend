const WorkspaceService = require('../services/workspace.service');
const WorkspaceCopyService = require('../services/workspaceCopy.service');
const FeedbackService = require('../services/feedback.service');
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

exports.enableShare = asyncHandler(async (req, res) => {
  const share = await WorkspaceService.enableShare(req.params.id, req.user.id);
  res.json({ success: true, share });
});

exports.updateStatusPage = asyncHandler(async (req, res) => {
  const page = await WorkspaceService.updateStatusPage(req.params.id, req.user.id, req.body);
  res.json({ success: true, page });
});

exports.duplicate = asyncHandler(async (req, res) => {
  const result = await WorkspaceCopyService.duplicate(req.params.id, req.user.id, req.body);
  res.status(201).json({ success: true, ...result });
});

exports.setMilestones = asyncHandler(async (req, res) => {
  const milestones = await WorkspaceService.setMilestones(req.params.id, req.user.id, req.body.milestones);
  res.json({ success: true, milestones });
});

exports.listFeedback = asyncHandler(async (req, res) => {
  const result = await FeedbackService.list(req.params.id, req.user.id, req.query);
  res.json({ success: true, ...result });
});

exports.markFeedbackRead = asyncHandler(async (req, res) => {
  await FeedbackService.markRead(req.params.id, req.params.feedbackId, req.user.id);
  res.json({ success: true });
});

exports.deleteFeedback = asyncHandler(async (req, res) => {
  await FeedbackService.remove(req.params.id, req.params.feedbackId, req.user.id);
  res.json({ success: true });
});

exports.disableShare = asyncHandler(async (req, res) => {
  await WorkspaceService.disableShare(req.params.id, req.user.id);
  res.json({ success: true });
});
