const express = require('express');
const router = express.Router();

const authRoutes = require('./auth.routes');
const userRoutes = require('./user.routes');
const uploadRoutes = require('./upload.routes');
const fileRoutes = require('./file.routes');
const subtaskRoutes = require('./subtask.routes');
const commentRoutes = require('./comment.routes');
const taskRoutes = require('./task.routes');
const statsRoutes = require('./statistics.routes'); // deprecated alias — kept one release for stale PWA clients, see momentumRoutes
const momentumRoutes = require('./momentum.routes');
const notificationRoutes = require('./notification.routes');
const activityRoutes = require('./activity.routes');
const digestRoutes = require('./digest.routes');
const workspaceRoutes = require('./workspace.routes');
const pageRoutes = require('./page.routes');
const blockRoutes = require('./block.routes');
const templateRoutes = require('./template.routes');
const paymentRoutes = require('./payment.routes');

router.use('/auth', authRoutes);
router.use('/payments', paymentRoutes);
router.use('/users', userRoutes);
router.use('/uploads', uploadRoutes);
router.use('/files', fileRoutes);
router.use('/subtasks', subtaskRoutes);
router.use('/comments', commentRoutes);
router.use('/tasks', taskRoutes);
router.use('/stats', statsRoutes); // deprecated — superseded by /momentum
router.use('/momentum', momentumRoutes);
router.use('/notifications', notificationRoutes);
router.use('/activity', activityRoutes);
router.use('/digest', digestRoutes);

// Notion-style workspace
router.use('/workspaces', workspaceRoutes);
router.use('/pages', pageRoutes);
router.use('/blocks', blockRoutes);
router.use('/templates', templateRoutes);

module.exports = router;
