// src/models/subtask.model.js
const mongoose = require('mongoose');

const subtaskSchema = new mongoose.Schema({
  title: { type: String, required: true },
  done: { type: Boolean, default: false },
  taskId: { type: mongoose.Schema.Types.ObjectId, ref: 'Task', required: true }
}, { timestamps: true });

module.exports = mongoose.model('Subtask', subtaskSchema);
