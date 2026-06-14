const router = require('express').Router();
const WorkspaceController = require('../controllers/workspace.controller');
const auth = require('../middlewares/auth.middleware');

router.use(auth);
router.get('/', WorkspaceController.list);
router.post('/', WorkspaceController.create);

module.exports = router;
