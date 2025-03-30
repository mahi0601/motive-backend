const Task = require('../models/task.model');

exports.getAll = (userId) => Task.find({ userId }).sort('position');

exports.create = async (data, userId) => {
  const count = await Task.countDocuments({ userId });
  return Task.create({ ...data, userId, position: count });
};
