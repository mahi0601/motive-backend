const mongoose = require('mongoose');

const taskSchema = new mongoose.Schema({
  title: String,
  description: String,
  priority: { type: String, enum: ['Low', 'Medium', 'High'], default: 'Low' },
  dueDate: Date,
  position: Number,
  userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User' }
}, { timestamps: true });

module.exports = mongoose.model('Task', taskSchema);
