const prisma = require('../config/prisma');
const WorkspaceService = require('../services/workspace.service');
const asyncHandler = require('../utils/asyncHandler');

// Public — no auth. Metadata only (see WorkspaceService#getInviteByToken for
// exactly what's safe to expose to someone who isn't a member yet).
exports.getByToken = asyncHandler(async (req, res) => {
  const invite = await WorkspaceService.getInviteByToken(req.params.token);
  res.json({ success: true, invite });
});

// auth.middleware only decodes { id, type, iat, exp } from the JWT — no
// email — so accept/decline (which must check the invite's email against
// the caller's own) look it up here, same as momentum.controller.js does
// for fields the token doesn't carry.
exports.accept = asyncHandler(async (req, res) => {
  const user = await prisma.user.findUnique({ where: { id: req.user.id }, select: { email: true } });
  const workspace = await WorkspaceService.acceptInvite(req.params.token, req.user.id, user.email);
  res.json({ success: true, workspace });
});

exports.decline = asyncHandler(async (req, res) => {
  const user = await prisma.user.findUnique({ where: { id: req.user.id }, select: { email: true } });
  await WorkspaceService.declineInvite(req.params.token, req.user.id, user.email);
  res.json({ success: true });
});
