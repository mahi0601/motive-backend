// src/services/subtask.service.js
const Subtask = require('../models/subtask.model');

exports.create = (data) => Subtask.create(data);
exports.findByTask = (taskId) => Subtask.find({ taskId });
exports.update = (id, data) => Subtask.findByIdAndUpdate(id, data, { new: true });
exports.remove = (id) => Subtask.findByIdAndDelete(id);
