// src/controllers/subtask.controller.js
const prisma = require('../config/prisma');

exports.createSubtask = async (req, res, next) => {
  try {
    const { title, taskId } = req.body;
    const subtask = await prisma.subtask.create({ data: { title, taskId } });
    res.status(201).json({ success: true, subtask });
  } catch (err) {
    next(err);
  }
};

exports.getSubtasksByTaskId = async (req, res, next) => {
  try {
    const { taskId } = req.params;
    const subtasks = await prisma.subtask.findMany({ where: { taskId } });
    res.status(200).json({ success: true, subtasks });
  } catch (err) {
    next(err);
  }
};

exports.updateSubtask = async (req, res, next) => {
  try {
    const { id } = req.params;
    const patch = {};
    for (const key of ['title', 'done']) if (key in req.body) patch[key] = req.body[key];
    const updated = await prisma.subtask.update({ where: { id }, data: patch });
    res.status(200).json({ success: true, updated });
  } catch (err) {
    next(err);
  }
};

exports.deleteSubtask = async (req, res, next) => {
  try {
    const { id } = req.params;
    await prisma.subtask.delete({ where: { id } });
    res.status(200).json({ success: true, message: 'Subtask deleted' });
  } catch (err) {
    next(err);
  }
};
