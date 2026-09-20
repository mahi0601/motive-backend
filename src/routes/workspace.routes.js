const router = require('express').Router();
const WorkspaceController = require('../controllers/workspace.controller');
const auth = require('../middlewares/auth.middleware');
const validate = require('../middlewares/validate.middleware');
const { inviteRules, roleUpdateRules } = require('../validators/workspace.validator');

router.use(auth);
router.get('/', WorkspaceController.list);
router.post('/', WorkspaceController.create);

router.post('/:id/invites', inviteRules, validate, WorkspaceController.createInvite);
router.get('/:id/invites', WorkspaceController.listInvites);
router.post('/:id/invites/:inviteId/resend', WorkspaceController.resendInvite);
router.delete('/:id/invites/:inviteId', WorkspaceController.revokeInvite);

router.patch('/:id/members/:userId', roleUpdateRules, validate, WorkspaceController.updateMemberRole);
router.delete('/:id/members/:userId', WorkspaceController.removeMember);

module.exports = router;
