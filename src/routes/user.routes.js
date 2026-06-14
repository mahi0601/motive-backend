// src/routes/user.routes.js
const express = require('express');
const router = express.Router();
const { body } = require('express-validator');
const UserController = require('../controllers/user.controller');
const auth = require('../middlewares/auth.middleware');
const validate = require('../middlewares/validate.middleware');

router.get('/me', auth, UserController.getUserProfile);
router.put('/me', auth, UserController.updateUserProfile);

router.delete(
  '/me',
  auth,
  [body('password').notEmpty().withMessage('Password is required to delete your account')],
  validate,
  UserController.deleteAccount
);

module.exports = router;
