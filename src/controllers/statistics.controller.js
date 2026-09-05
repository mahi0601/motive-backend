// controllers/statistics.controller.js
const {
    getWeeklyTaskStats,
    getPriorityStats
  } = require('../services/statistics.service');
  
  const getStatistics = async (req, res) => {
    try {
      const userId = req.user.id;
  
      const taskStats = await getWeeklyTaskStats(userId);
      const priorityStats = await getPriorityStats(userId);
  
      return res.status(200).json({
        success: true,
        taskStats,
        priorityStats
      });
    } catch (error) {
      console.error('Error in statistics controller:', error.message);
      return res.status(500).json({
        success: false,
        message: 'Failed to fetch statistics',
        error: error.message
      });
    }
  };
  
  module.exports = {
    getStatistics
  };
  