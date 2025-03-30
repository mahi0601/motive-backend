// services/statistics.service.js
const Task = require('../models/task.model');
const moment = require('moment');

// Service to calculate weekly task completion stats
const getWeeklyTaskStats = async (userId) => {
  const startOfWeek = moment().startOf('week');
  const endOfWeek = moment().endOf('week');

  const tasks = await Task.find({
    createdAt: { $gte: startOfWeek.toDate(), $lte: endOfWeek.toDate() },
    userId,
  });

  // Group tasks by day of the week
  const days = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
  const stats = days.map(day => ({ name: day, completed: 0 }));

  tasks.forEach(task => {
    const day = moment(task.createdAt).format('ddd');
    const index = stats.findIndex(s => s.name === day);
    if (index !== -1) stats[index].completed += 1;
  });

  return stats;
};

// Service to calculate task priority distribution
const getPriorityStats = async (userId) => {
  const tasks = await Task.find({ userId });

  const priorityStats = [
    { name: 'High', value: 0 },
    { name: 'Medium', value: 0 },
    { name: 'Low', value: 0 }
  ];

  tasks.forEach(task => {
    const index = priorityStats.findIndex(p => p.name === task.priority);
    if (index !== -1) priorityStats[index].value += 1;
  });

  return priorityStats;
};

module.exports = {
  getWeeklyTaskStats,
  getPriorityStats
};
