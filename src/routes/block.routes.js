const router = require('express').Router();
const BlockController = require('../controllers/block.controller');
const auth = require('../middlewares/auth.middleware');
const validate = require('../middlewares/validate.middleware');
const { updateBlockRules } = require('../validators/block.validator');

router.use(auth);

// Individual block operations (list/create live under /pages/:pageId/blocks)
router.patch('/:id', updateBlockRules, validate, BlockController.update);
router.delete('/:id', BlockController.remove);

module.exports = router;
