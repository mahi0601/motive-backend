// src/routes/user.routes.js
const express = require('express');
const router = express.Router();
const UserController = require('../controllers/user.controller');
const auth = require('../middlewares/auth.middleware');
const validate = require('../middlewares/validate.middleware');
const { deleteAccountRules, updateProfileRules } = require('../validators/user.validator');

router.get('/me', auth, UserController.getUserProfile);
router.put('/me', auth, updateProfileRules, validate, UserController.updateUserProfile);

router.delete('/me', auth, deleteAccountRules, validate, UserController.deleteAccount);

module.exports = router;
