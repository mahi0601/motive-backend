// src/services/comment.service.js
const Comment = require('../models/comment.model');

exports.add = (data) => Comment.create(data);
exports.findByTaskId = (taskId) => Comment.find({ taskId }).populate('userId', 'name email');
