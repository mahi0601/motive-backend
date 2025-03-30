// src/utils/cronService.js
const cron = require('node-cron');

exports.scheduleTask = (expression, taskFunction) => {
  cron.schedule(expression, taskFunction);
};
