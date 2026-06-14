const Task = require('../models/task.model');

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
