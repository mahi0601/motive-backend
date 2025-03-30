const TaskService = require('../services/task.service');

exports.getTasks = async (req, res) => {
  const tasks = await TaskService.getAll(req.user.id);
  res.json(tasks);
};

exports.createTask = async (req, res) => {
  const task = await TaskService.create(req.body, req.user.id);
  res.status(201).json(task);
};
