const router = require('express').Router();
const rateLimit = require('express-rate-limit');
const auth = require('../middlewares/auth.middleware');
const AuthController = require('../controllers/auth.controller');
const validate = require('../middlewares/validate.middleware');
const sameSite = require('../middlewares/sameSite.middleware');
const jsonOnly = require('../middlewares/jsonOnly.middleware');
const {
  registerRules,
  loginRules,
  forgotPasswordRules,
  resetPasswordRules,
  verifyEmailRules,
} = require('../validators/auth.validator');

router.post('/register', jsonOnly, registerRules, validate, AuthController.register);
router.post('/login', jsonOnly, loginRules, validate, AuthController.login);
router.post('/refresh', sameSite, AuthController.refresh); // uses httpOnly cookie, no body
router.post('/logout', sameSite, AuthController.logout);
// Rate-limited alongside login/register in server.js — same brute-force/abuse surface.
router.post('/forgot-password', forgotPasswordRules, validate, AuthController.forgotPassword);
router.post('/reset-password', resetPasswordRules, validate, AuthController.resetPassword);
router.post('/verify-email', verifyEmailRules, validate, AuthController.verifyEmail);
// Sends an email, so a few a day per account (keyed by user, not ip).
const resendLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  max: 3,
  keyGenerator: (req) => req.user.id,
  standardHeaders: true,
  legacyHeaders: false,
  message: { success: false, message: 'Too many confirmation emails — try again later.' },
});
router.post('/resend-verification', auth, resendLimiter, AuthController.resendVerification);

// GET, not POST — these are top-level browser navigations (redirect to
// Google, then Google redirects back here), not AJAX calls.
router.get('/google', AuthController.googleRedirect);
router.get('/google/callback', AuthController.googleCallback);

// Native (Capacitor Android) hand-off — see auth.controller.js#nativeExchange.
// Rate-limited alongside login/register/etc. in server.js.
router.post('/native-exchange', jsonOnly, AuthController.nativeExchange);

module.exports = router;
