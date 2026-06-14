const TaskService = require('../services/task.service');
const asyncHandler = require('../utils/asyncHandler');
const { getPagination, paginated } = require('../utils/pagination');

exports.getTasks = asyncHandler(async (req, res) => {
  const { page, limit, skip } = getPagination(req.query);
  const { items, total } = await TaskService.getAll(req.user.id, { skip, limit });
  res.json({ success: true, ...paginated(items, total, { page, limit }) });
});

exports.createTask = asyncHandler(async (req, res) => {
  const task = await TaskService.create(req.body, req.user.id);
  res.status(201).json({ success: true, task });
});

exports.updateTask = asyncHandler(async (req, res) => {
  const task = await TaskService.update(req.params.id, req.body, req.user.id);
  res.json({ success: true, task });
});

exports.deleteTask = asyncHandler(async (req, res) => {
  const result = await TaskService.remove(req.params.id, req.user.id);
  res.json({ success: true, ...result });
});
