const prisma = require('../config/prisma');
const AppError = require('../utils/AppError');
const taskService = require('./task.service');

// Subtasks are task *content*, not a discussion — creating/editing/removing
// one requires 'write' (owner/editor), same as editing the task itself.
async function assertSubtaskAccess(id, userId, need = 'write') {
  const subtask = await prisma.subtask.findUnique({ where: { id }, select: { taskId: true } });
  if (!subtask) throw AppError.notFound('Subtask not found');
  await taskService.assertAccess(subtask.taskId, userId, need);
  return subtask;
}

exports.create = async (taskId, title, userId) => {
  await taskService.assertAccess(taskId, userId, 'write');
  return prisma.subtask.create({ data: { title, taskId } });
};

exports.listByTask = async (taskId, userId) => {
  await taskService.assertAccess(taskId, userId, 'read');
  return prisma.subtask.findMany({ where: { taskId }, orderBy: { createdAt: 'asc' } });
};

exports.update = async (id, data, userId) => {
  await assertSubtaskAccess(id, userId, 'write');
  const patch = {};
  for (const key of ['title', 'done']) if (key in data) patch[key] = data[key];
  return prisma.subtask.update({ where: { id }, data: patch });
};

exports.remove = async (id, userId) => {
  await assertSubtaskAccess(id, userId, 'write');
  await prisma.subtask.delete({ where: { id } });
  return { deleted: true };
};
