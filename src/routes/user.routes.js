// src/routes/user.routes.js
const express = require('express');
const rateLimit = require('express-rate-limit');
const router = express.Router();
const UserController = require('../controllers/user.controller');
const auth = require('../middlewares/auth.middleware');
const validate = require('../middlewares/validate.middleware');
const { deleteAccountRules, updateProfileRules } = require('../validators/user.validator');

// The export reads most of the account's tables, so it is limited to one per
// hour per account (keyed by user, not ip: shared networks are common).
const exportLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  max: 1,
  keyGenerator: (req) => req.user.id,
  standardHeaders: true,
  legacyHeaders: false,
  message: { success: false, message: 'You can export your data once an hour. Try again later.' },
});

router.get('/me', auth, UserController.getUserProfile);
router.get('/me/export', auth, exportLimiter, UserController.exportData);
router.put('/me', auth, updateProfileRules, validate, UserController.updateUserProfile);

router.delete('/me', auth, deleteAccountRules, validate, UserController.deleteAccount);

module.exports = router;
