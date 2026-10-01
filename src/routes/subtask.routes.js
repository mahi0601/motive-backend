// src/routes/subtask.routes.js
const express = require('express');
const router = express.Router();
const SubtaskController = require('../controllers/subtask.controller');
const auth = require('../middlewares/auth.middleware');
const validate = require('../middlewares/validate.middleware');
const { createSubtaskRules, updateSubtaskRules } = require('../validators/subtask.validator');

router.post('/', auth, createSubtaskRules, validate, SubtaskController.createSubtask);
router.get('/:taskId', auth, SubtaskController.getSubtasksByTaskId);
router.put('/:id', auth, updateSubtaskRules, validate, SubtaskController.updateSubtask);
router.delete('/:id', auth, SubtaskController.deleteSubtask);

module.exports = router;
