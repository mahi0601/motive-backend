// src/routes/user.routes.js
const express = require('express');
const router = express.Router();
const UserController = require('../controllers/user.controller');
const auth = require('../middlewares/auth.middleware');

router.get('/me', auth, UserController.getUserProfile);
router.put('/me', auth, UserController.updateUserProfile);

module.exports = router;
