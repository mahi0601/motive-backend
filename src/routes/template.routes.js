const router = require('express').Router();
const TemplateController = require('../controllers/template.controller');
const auth = require('../middlewares/auth.middleware');
const validate = require('../middlewares/validate.middleware');
const { saveTemplateRules, useTemplateRules } = require('../validators/template.validator');

router.use(auth);

router.get('/', TemplateController.list);
router.post('/', saveTemplateRules, validate, TemplateController.saveFromPage); // save current page as a template
router.post('/:id/use', useTemplateRules, validate, TemplateController.use); // create a page from a template
router.delete('/:id', TemplateController.remove);

module.exports = router;
