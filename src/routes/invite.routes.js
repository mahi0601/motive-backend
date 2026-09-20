const router = require('express').Router();
const InviteController = require('../controllers/invite.controller');
const auth = require('../middlewares/auth.middleware');

// Mixed public/private — unlike workspace.routes.js, auth is per-route, not
// blanket, since the whole point of this route is reaching someone who
// isn't authenticated (or doesn't have an account) yet.
router.get('/:token', InviteController.getByToken);
router.post('/:token/accept', auth, InviteController.accept);
router.post('/:token/decline', auth, InviteController.decline);

module.exports = router;
