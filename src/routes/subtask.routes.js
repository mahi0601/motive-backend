// src/routes/subtask.routes.js
const express = require('express');
const router = express.Router();
const SubtaskController = require('../controllers/subtask.controller');
const auth = require('../middlewares/auth.middleware');

router.post('/', auth, SubtaskController.createSubtask);
router.get('/:taskId', auth, SubtaskController.getSubtasksByTaskId);
router.put('/:id', auth, SubtaskController.updateSubtask);
router.delete('/:id', auth, SubtaskController.deleteSubtask);

module.exports = router;
