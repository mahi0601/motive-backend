const prisma = require('../config/prisma');
const AppError = require('../utils/AppError');
const activityLog = require('./activityLog.service');

// Paginated, indexed read — scales to large task counts per user.
exports.getAll = async (userId, { skip, limit }) => {
  const [items, total] = await Promise.all([
    prisma.task.findMany({ where: { userId }, orderBy: { position: 'asc' }, skip, take: limit }),
    prisma.task.count({ where: { userId } }),
  ]);
  return { items, total };
};

const WRITABLE_FIELDS = ['title', 'description', 'priority', 'status', 'category', 'dueDate'];

exports.create = async (data, userId) => {
  const patch = {};
  for (const key of WRITABLE_FIELDS) if (key in data) patch[key] = data[key];

  const count = await prisma.task.count({ where: { userId } });
  const task = await prisma.task.create({ data: { ...patch, userId, position: count } });
  activityLog.log('created', userId, { taskId: task.id, description: `Created "${task.title}"` });
  return task;
};

exports.update = async (id, data, userId) => {
  const patch = {};
  for (const key of [...WRITABLE_FIELDS, 'position']) if (key in data) patch[key] = data[key];

  const { count } = await prisma.task.updateMany({ where: { id, userId }, data: patch });
  if (!count) throw AppError.notFound('Task not found');
  const task = await prisma.task.findUnique({ where: { id } });

  // Completing a task is the interesting activity-feed moment; skip logging
  // every minor field edit (drag-to-reorder, description tweak, etc).
  if (patch.status === 'done') {
    activityLog.log('completed', userId, { taskId: task.id, description: `Completed "${task.title}"` });
  } else {
    activityLog.log('updated', userId, { taskId: task.id, description: `Updated "${task.title}"` });
  }
  return task;
};

exports.remove = async (id, userId) => {
  const task = await prisma.task.findUnique({ where: { id }, select: { title: true } });
  const { count } = await prisma.task.deleteMany({ where: { id, userId } });
  if (!count) throw AppError.notFound('Task not found');
  activityLog.log('deleted', userId, { description: `Deleted "${task?.title ?? 'a task'}"` });
  return { deleted: true };
};
