// src/routes/notification.routes.js
const express = require('express');
const router = express.Router();
const NotificationController = require('../controllers/notification.controller');
const auth = require('../middlewares/auth.middleware');

router.get('/', auth, NotificationController.getUserNotifications);
router.put('/:id/read', auth, NotificationController.markAsRead);
router.delete('/clear', auth, NotificationController.clearNotifications);

module.exports = router;
