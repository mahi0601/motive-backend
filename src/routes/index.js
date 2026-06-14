const express = require('express');
const router = express.Router();

const authRoutes = require('./auth.routes');
const userRoutes = require('./user.routes');
const uploadRoutes = require('./upload.routes');
const subtaskRoutes = require('./subtask.routes');
const commentRoutes = require('./comment.routes');
const taskRoutes = require('./task.routes');
const statsRoutes = require('./statistics.routes');
const notificationRoutes = require('./notification.routes');
const workspaceRoutes = require('./workspace.routes');
const pageRoutes = require('./page.routes');
const blockRoutes = require('./block.routes');
const templateRoutes = require('./template.routes');

router.use('/auth', authRoutes);
router.use('/users', userRoutes);
router.use('/uploads', uploadRoutes);
router.use('/subtasks', subtaskRoutes);
router.use('/comments', commentRoutes);
router.use('/tasks', taskRoutes);
router.use('/stats', statsRoutes);
router.use('/notifications', notificationRoutes);

// Notion-style workspace
router.use('/workspaces', workspaceRoutes);
router.use('/pages', pageRoutes);
router.use('/blocks', blockRoutes);
router.use('/templates', templateRoutes);

module.exports = router;
