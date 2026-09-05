const prisma = require('../config/prisma');
const AppError = require('../utils/AppError');

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
  return prisma.task.create({ data: { ...patch, userId, position: count } });
};

exports.update = async (id, data, userId) => {
  const patch = {};
  for (const key of [...WRITABLE_FIELDS, 'position']) if (key in data) patch[key] = data[key];

  const { count } = await prisma.task.updateMany({ where: { id, userId }, data: patch });
  if (!count) throw AppError.notFound('Task not found');
  return prisma.task.findUnique({ where: { id } });
};

exports.remove = async (id, userId) => {
  const { count } = await prisma.task.deleteMany({ where: { id, userId } });
  if (!count) throw AppError.notFound('Task not found');
  return { deleted: true };
};
