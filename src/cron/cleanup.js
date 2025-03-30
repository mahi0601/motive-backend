// src/cron/cleanup.js
const fs = require('fs');
const path = require('path');

const cleanupLogs = () => {
  const logDir = path.join(__dirname, '../../logs');
  fs.readdir(logDir, (err, files) => {
    if (err) return console.error('Cleanup error:', err);
    files.forEach(file => {
      const filePath = path.join(logDir, file);
      const stats = fs.statSync(filePath);
      const isOld = (Date.now() - stats.mtimeMs) > 7 * 24 * 60 * 60 * 1000;
      if (isOld) fs.unlinkSync(filePath);
    });
  });
};

module.exports = cleanupLogs;
