// src/controllers/subtask.controller.js
const prisma = require('../config/prisma');
const AppError = require('../utils/AppError');

// None of these originally checked that the parent task belonged to the
// requesting user — any authenticated user could read/create/edit/delete
// subtasks on any task by guessing its id. Now wired into real UI for the
// first time, so this is the first time it's actually reachable/exploitable.
async function assertTaskOwner(taskId, userId) {
  const task = await prisma.task.findFirst({ where: { id: taskId, userId }, select: { id: true } });
  if (!task) throw AppError.notFound('Task not found');
}

exports.createSubtask = async (req, res, next) => {
  try {
    const { title, taskId } = req.body;
    await assertTaskOwner(taskId, req.user.id);
    const subtask = await prisma.subtask.create({ data: { title, taskId } });
    res.status(201).json({ success: true, subtask });
  } catch (err) {
    next(err);
  }
};

exports.getSubtasksByTaskId = async (req, res, next) => {
  try {
    const { taskId } = req.params;
    await assertTaskOwner(taskId, req.user.id);
    const subtasks = await prisma.subtask.findMany({ where: { taskId }, orderBy: { createdAt: 'asc' } });
    res.status(200).json({ success: true, subtasks });
  } catch (err) {
    next(err);
  }
};

exports.updateSubtask = async (req, res, next) => {
  try {
    const { id } = req.params;
    const subtask = await prisma.subtask.findUnique({ where: { id }, select: { taskId: true } });
    if (!subtask) throw AppError.notFound('Subtask not found');
    await assertTaskOwner(subtask.taskId, req.user.id);

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
    const subtask = await prisma.subtask.findUnique({ where: { id }, select: { taskId: true } });
    if (!subtask) throw AppError.notFound('Subtask not found');
    await assertTaskOwner(subtask.taskId, req.user.id);

    await prisma.subtask.delete({ where: { id } });
    res.status(200).json({ success: true, message: 'Subtask deleted' });
  } catch (err) {
    next(err);
  }
};
