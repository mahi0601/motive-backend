// src/controllers/subtask.controller.js
const SubtaskService = require('../services/subtask.service');
const asyncHandler = require('../utils/asyncHandler');

exports.createSubtask = asyncHandler(async (req, res) => {
  const { title, taskId } = req.body;
  const subtask = await SubtaskService.create(taskId, title, req.user.id);
  res.status(201).json({ success: true, subtask });
});

exports.getSubtasksByTaskId = asyncHandler(async (req, res) => {
  const subtasks = await SubtaskService.listByTask(req.params.taskId, req.user.id);
  res.status(200).json({ success: true, subtasks });
});

exports.updateSubtask = asyncHandler(async (req, res) => {
  const subtask = await SubtaskService.update(req.params.id, req.body, req.user.id);
  res.status(200).json({ success: true, subtask });
});

exports.deleteSubtask = asyncHandler(async (req, res) => {
  await SubtaskService.remove(req.params.id, req.user.id);
  res.status(200).json({ success: true, message: 'Subtask deleted' });
});
