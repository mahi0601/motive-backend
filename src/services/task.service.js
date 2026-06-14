const Task = require('../models/task.model');
const AppError = require('../utils/AppError');

// Paginated, indexed, lean read — scales to large task counts per user.
exports.getAll = async (userId, { skip, limit }) => {
  const [items, total] = await Promise.all([
    Task.find({ userId }).sort('position').skip(skip).limit(limit).lean(),
    Task.countDocuments({ userId }),
  ]);
  return { items, total };
};

exports.create = async (data, userId) => {
  const count = await Task.countDocuments({ userId });
  return Task.create({ ...data, userId, position: count });
};

exports.update = async (id, data, userId) => {
  const allowed = ['title', 'description', 'priority', 'status', 'category', 'dueDate', 'position'];
  const patch = {};
  for (const key of allowed) if (key in data) patch[key] = data[key];

  const task = await Task.findOneAndUpdate({ _id: id, userId }, patch, {
    new: true,
    runValidators: true,
  });
  if (!task) throw AppError.notFound('Task not found');
  return task;
};

exports.remove = async (id, userId) => {
  const task = await Task.findOneAndDelete({ _id: id, userId });
  if (!task) throw AppError.notFound('Task not found');
  return { deleted: true };
};
