const router = require('express').Router();
const TemplateController = require('../controllers/template.controller');
const auth = require('../middlewares/auth.middleware');

router.use(auth);

router.get('/', TemplateController.list);
router.post('/', TemplateController.saveFromPage); // save current page as a template
router.post('/:id/use', TemplateController.use); // create a page from a template
router.delete('/:id', TemplateController.remove);

module.exports = router;
