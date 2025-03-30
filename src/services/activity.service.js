// src/services/activity.service.js
const ActivityLog = require('../models/activityLog.model');

exports.log = (action, userId, taskId = null, description = '') =>
  ActivityLog.create({ action, userId, taskId, description });
