const rateLimit = require('express-rate-limit');
const router = require('express').Router();
const WorkspaceController = require('../controllers/workspace.controller');
const auth = require('../middlewares/auth.middleware');
const validate = require('../middlewares/validate.middleware');
const { inviteRules, roleUpdateRules, createWorkspaceRules, statusPageRules, milestonesRules, duplicateWorkspaceRules } = require('../validators/workspace.validator');

// Scoped to just create/resend — the two routes that can spam someone's
// inbox. Reads and revoke/accept/decline are unaffected. Mirrors server.js's
// credentialLimiter shape rather than sharing that instance, since this is a
// different abuse surface (spamming an invitee, not brute-forcing a
// password) with its own counter.
const inviteLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 20,
  standardHeaders: true,
  legacyHeaders: false,
  message: { success: false, message: 'Too many invite attempts, try again later.' },
});

router.use(auth);
router.get('/', WorkspaceController.list);
router.post('/', createWorkspaceRules, validate, WorkspaceController.create);
// Every client the caller owns, most in need of attention first. Before any /:id route.
router.get('/overview', WorkspaceController.overview);

router.post('/:id/invites', inviteLimiter, inviteRules, validate, WorkspaceController.createInvite);
router.get('/:id/invites', WorkspaceController.listInvites);
router.post('/:id/invites/:inviteId/resend', inviteLimiter, WorkspaceController.resendInvite);
router.delete('/:id/invites/:inviteId', WorkspaceController.revokeInvite);

router.patch('/:id/members/:userId', roleUpdateRules, validate, WorkspaceController.updateMemberRole);
router.delete('/:id/members/:userId', WorkspaceController.removeMember);
router.post('/:id/transfer-ownership', WorkspaceController.transferOwnership);
router.delete('/:id/leave', WorkspaceController.leaveWorkspace);

// Owner-only public status link — POST enables or rotates, DELETE turns it off.
router.post('/:id/share', WorkspaceController.enableShare);
router.delete('/:id/share', WorkspaceController.disableShare);
// Owner-only inbox for what clients send from the public page.
router.get('/:id/feedback', WorkspaceController.listFeedback);
router.patch('/:id/feedback/:feedbackId/read', WorkspaceController.markFeedbackRead);
router.delete('/:id/feedback/:feedbackId', WorkspaceController.deleteFeedback);
// Owner-only inbox for what clients ask for; accepting one makes a task.
router.get('/:id/requests', WorkspaceController.listRequests);
router.post('/:id/requests/:requestId/accept', WorkspaceController.acceptRequest);
router.post('/:id/requests/:requestId/decline', WorkspaceController.declineRequest);
router.patch('/:id/requests/:requestId', WorkspaceController.updateRequest);
router.delete('/:id/requests/:requestId', WorkspaceController.deleteRequest);
// Owner-only: what the public page says about the project (headline, summary, milestone, accent).
router.patch('/:id/status-page', statusPageRules, validate, WorkspaceController.updateStatusPage);
// A copy can create hundreds of rows, so it is capped well below the global limit.
// DUPLICATE_RATE_MAX can raise it (tests); only a positive number counts.
const duplicateMax = Number.parseInt(process.env.DUPLICATE_RATE_MAX, 10);
const duplicateLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: duplicateMax > 0 ? duplicateMax : 10,
  standardHeaders: true,
  legacyHeaders: false,
  message: { success: false, message: 'Too many copies, try again later.' },
});
router.post('/:id/duplicate', duplicateLimiter, duplicateWorkspaceRules, validate, WorkspaceController.duplicate);
router.get('/:id/engagement', WorkspaceController.getEngagement);
router.put('/:id/milestones', milestonesRules, validate, WorkspaceController.setMilestones);

module.exports = router;
