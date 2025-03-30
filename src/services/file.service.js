// src/services/file.service.js
const File = require('../models/file.model');

exports.upload = (data) => File.create(data);
exports.findByTask = (taskId) => File.find({ taskId });
exports.delete = (id) => File.findByIdAndDelete(id);
