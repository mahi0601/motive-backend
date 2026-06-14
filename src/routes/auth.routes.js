const router = require('express').Router();
const AuthController = require('../controllers/auth.controller');
const validate = require('../middlewares/validate.middleware');
const { registerRules, loginRules } = require('../validators/auth.validator');

router.post('/register', registerRules, validate, AuthController.register);
router.post('/login', loginRules, validate, AuthController.login);
router.post('/refresh', AuthController.refresh); // uses httpOnly cookie, no body
router.post('/logout', AuthController.logout);

module.exports = router;
