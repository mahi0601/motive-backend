const rateLimit = require('express-rate-limit');
const router = require('express').Router();
const WorkspaceController = require('../controllers/workspace.controller');
const auth = require('../middlewares/auth.middleware');
const validate = require('../middlewares/validate.middleware');
const { inviteRules, roleUpdateRules, createWorkspaceRules } = require('../validators/workspace.validator');

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

module.exports = router;
