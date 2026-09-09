const router = require('express').Router();
const AuthController = require('../controllers/auth.controller');
const validate = require('../middlewares/validate.middleware');
const {
  registerRules,
  loginRules,
  forgotPasswordRules,
  resetPasswordRules,
} = require('../validators/auth.validator');

router.post('/register', registerRules, validate, AuthController.register);
router.post('/login', loginRules, validate, AuthController.login);
router.post('/refresh', AuthController.refresh); // uses httpOnly cookie, no body
router.post('/logout', AuthController.logout);
// Rate-limited alongside login/register in server.js — same brute-force/abuse surface.
router.post('/forgot-password', forgotPasswordRules, validate, AuthController.forgotPassword);
router.post('/reset-password', resetPasswordRules, validate, AuthController.resetPassword);

// GET, not POST — these are top-level browser navigations (redirect to
// Google, then Google redirects back here), not AJAX calls.
router.get('/google', AuthController.googleRedirect);
router.get('/google/callback', AuthController.googleCallback);

// Native (Capacitor Android) hand-off — see auth.controller.js#nativeExchange.
// Rate-limited alongside login/register/etc. in server.js.
router.post('/native-exchange', AuthController.nativeExchange);

module.exports = router;
