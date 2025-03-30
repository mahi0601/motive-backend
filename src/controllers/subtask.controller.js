// src/controllers/subtask.controller.js
const Subtask = require('../models/subtask.model');

exports.createSubtask = async (req, res, next) => {
  try {
    const { title, taskId } = req.body;
    const subtask = await Subtask.create({ title, taskId });
    res.status(201).json({ success: true, subtask });
  } catch (err) {
    next(err);
  }
};

exports.getSubtasksByTaskId = async (req, res, next) => {
  try {
    const { taskId } = req.params;
    const subtasks = await Subtask.find({ taskId });
    res.status(200).json({ success: true, subtasks });
  } catch (err) {
    next(err);
  }
};

exports.updateSubtask = async (req, res, next) => {
  try {
    const { id } = req.params;
    const updated = await Subtask.findByIdAndUpdate(id, req.body, { new: true });
    res.status(200).json({ success: true, updated });
  } catch (err) {
    next(err);
  }
};

exports.deleteSubtask = async (req, res, next) => {
  try {
    const { id } = req.params;
    await Subtask.findByIdAndDelete(id);
    res.status(200).json({ success: true, message: "Subtask deleted" });
  } catch (err) {
    next(err);
  }
};
