const rateLimit = require('express-rate-limit');
const router = require('express').Router();
const ClientTemplateController = require('../controllers/clientTemplate.controller');
const auth = require('../middlewares/auth.middleware');
const validate = require('../middlewares/validate.middleware');
const { saveTemplateRules, useTemplateRules } = require('../validators/clientTemplate.validator');

router.use(auth);

// Saving and using a template can create hundreds of rows, so both share a tight limit.
// CLIENT_TEMPLATE_RATE_MAX can raise it (tests); only a positive number counts.
const max = Number.parseInt(process.env.CLIENT_TEMPLATE_RATE_MAX, 10);
const writeLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: max > 0 ? max : 20,
  standardHeaders: true,
  legacyHeaders: false,
  message: { success: false, message: 'Too many requests, try again later.' },
});

router.get('/', ClientTemplateController.list);
router.post('/', writeLimiter, saveTemplateRules, validate, ClientTemplateController.save);
router.post('/:id/use', writeLimiter, useTemplateRules, validate, ClientTemplateController.use);
router.delete('/:id', ClientTemplateController.remove);

module.exports = router;
