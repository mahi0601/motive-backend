const express = require('express');
const router = express.Router();

const authRoutes = require('./auth.routes');
const userRoutes = require('./user.routes');
const uploadRoutes = require('./upload.routes');
const subtaskRoutes = require('./subtask.routes');
const commentRoutes = require('./comment.routes');
const taskRoutes = require('./task.routes');
const statsRoutes = require('./statistics.routes');

router.use('/auth', authRoutes);
router.use('/users', userRoutes);
router.use('/uploads', uploadRoutes);
router.use('/subtasks', subtaskRoutes);
router.use('/comments', commentRoutes);
router.use('/tasks', taskRoutes);

router.use('/stats',statsRoutes)
module.exports = router;
