const WorkspaceService = require('../services/workspace.service');
const asyncHandler = require('../utils/asyncHandler');

// Public — no auth. The link is the credential; see
// WorkspaceService#getStatusByToken for exactly what it may expose.
exports.getByToken = asyncHandler(async (req, res) => {
  const status = await WorkspaceService.getStatusByToken(req.params.token);
  // A rotated or disabled link must stop working immediately, so nothing
  // between the server and the viewer may cache this response.
  res.set('Cache-Control', 'no-store');
  res.json({ success: true, status });
});
