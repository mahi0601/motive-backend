const router = require('express').Router();
const PageController = require('../controllers/page.controller');
const BlockController = require('../controllers/block.controller');
const auth = require('../middlewares/auth.middleware');
const validate = require('../middlewares/validate.middleware');
const { createPageRules, updatePageRules } = require('../validators/page.validator');
const { createBlockRules, reorderBlocksRules } = require('../validators/block.validator');

router.use(auth);

// Pages
router.get('/', PageController.list);
router.get('/search', PageController.search);
router.post('/', createPageRules, validate, PageController.create);
router.get('/:id', PageController.getOne);
router.patch('/:id', updatePageRules, validate, PageController.update);
router.delete('/:id', PageController.remove);

// Blocks nested under a page
router.get('/:pageId/blocks', BlockController.listByPage);
router.post('/:pageId/blocks', createBlockRules, validate, BlockController.create);
router.put('/:pageId/blocks/reorder', reorderBlocksRules, validate, BlockController.reorder);

module.exports = router;
