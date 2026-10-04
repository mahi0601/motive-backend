const WorkspaceService = require('../services/workspace.service');
const analytics = require('../services/analytics.service');
const FeedbackService = require('../services/feedback.service');
const asyncHandler = require('../utils/asyncHandler');
const { isAutomated } = require('../utils/automatedVisitors');

// Public — no auth. The link is the credential; see
// WorkspaceService#getStatusByToken for exactly what it may expose.
exports.getByToken = asyncHandler(async (req, res) => {
  const userAgent = req.get('user-agent');
  const visitor = analytics.visitorKey({ ip: req.ip, userAgent });
  // Settings opens the owner's own link with ?preview=1 so a preview isn't counted
  // as a client looking. Only that exact value counts; anyone can add it, which
  // can only ever UNDER-count views, never inflate them.
  const preview = req.query.preview === '1';
  // A link preview, crawler or script gets the page but is not counted as a client looking.
  const status = await WorkspaceService.getStatusByToken(req.params.token, { visitor, preview, automated: isAutomated(userAgent) });
  // A rotated or disabled link must stop working immediately, so nothing
  // between the server and the viewer may cache this response.
  res.set('Cache-Control', 'no-store');
  res.json({ success: true, status });
});

// Public — the link is the credential, and the service decides whether this
// workspace takes feedback at all (otherwise the same 404 as an unknown link).
exports.submitFeedback = asyncHandler(async (req, res) => {
  await FeedbackService.submit(req.params.token, req.body);
  res.set('Cache-Control', 'no-store');
  res.status(201).json({ success: true });
});

// Public and body-less: the marketing page reports that a visitor arrived via a
// status page footer. Stores the daily visitor hash and nothing from the request
// body, so there is nothing to forge beyond "one more visit" (and the route's
// rate limit caps even that).
exports.landingFromStatus = asyncHandler(async (req, res) => {
  const visitor = analytics.visitorKey({ ip: req.ip, userAgent: req.get('user-agent') });
  await analytics.track('landing_from_status', { visitor });
  res.status(204).end();
});
