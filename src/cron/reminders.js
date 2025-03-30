// src/cron/reminders.js
const Task = require('../models/task.model');
const User = require('../models/user.model');
const { sendEmail } = require('../utils/emailService');
const moment = require('moment');

const sendReminders = async () => {
  const tasks = await Task.find({ dueDate: { $gte: new Date(), $lte: moment().add(1, 'day').toDate() } });
  
  for (let task of tasks) {
    const user = await User.findById(task.assignedTo);
    if (user && user.email) {
      await sendEmail({
        to: user.email,
        subject: '🔔 Task Reminder',
        html: `<p>Hi ${user.name},</p><p>This is a reminder for your task: <strong>${task.title}</strong>.</p><p>Due by: ${task.dueDate}</p>`
      });
    }
  }
};

module.exports = sendReminders;
