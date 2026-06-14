const router = require('express').Router();
const PageController = require('../controllers/page.controller');
const BlockController = require('../controllers/block.controller');
const auth = require('../middlewares/auth.middleware');

router.use(auth);

// Pages
router.get('/', PageController.list);
router.get('/search', PageController.search);
router.post('/', PageController.create);
router.get('/:id', PageController.getOne);
router.patch('/:id', PageController.update);
router.delete('/:id', PageController.remove);

// Blocks nested under a page
router.get('/:pageId/blocks', BlockController.listByPage);
router.post('/:pageId/blocks', BlockController.create);
router.put('/:pageId/blocks/reorder', BlockController.reorder);

module.exports = router;
