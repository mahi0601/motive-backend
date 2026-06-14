const router = require('express').Router();
const BlockController = require('../controllers/block.controller');
const auth = require('../middlewares/auth.middleware');

router.use(auth);

// Individual block operations (list/create live under /pages/:pageId/blocks)
router.patch('/:id', BlockController.update);
router.delete('/:id', BlockController.remove);

module.exports = router;
