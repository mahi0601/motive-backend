const rateLimit = require('express-rate-limit');
const router = require('express').Router();
const StatusController = require('../controllers/status.controller');

// Public and unauthenticated, so it gets its own per-IP cap on top of the
// global /api limiter — tighter than that, looser than a credential endpoint
// (a client legitimately leaves this page open and it re-polls every minute).
const statusLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 120,
  standardHeaders: true,
  legacyHeaders: false,
  message: { success: false, message: 'Too many requests, try again later.' },
});

router.get('/:token', statusLimiter, StatusController.getByToken);

// The only unauthenticated write: much tighter than reading, because each post
// stores a row and notifies the owner. Per client ip; the service adds a
// per-workspace daily cap.
const feedbackLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: parseInt(process.env.FEEDBACK_RATE_MAX, 10) || 10,
  standardHeaders: true,
  legacyHeaders: false,
  message: { success: false, message: 'Too many messages, please try again later.' },
});
router.post('/:token/feedback', feedbackLimiter, StatusController.submitFeedback);

module.exports = router;
