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

module.exports = router;
