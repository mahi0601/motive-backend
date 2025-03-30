// src/utils/fileUpload.js
const path = require('path');
const fs = require('fs');

exports.getFileExtension = (filename) => path.extname(filename).toLowerCase();

exports.removeFile = (filepath) => {
  if (fs.existsSync(filepath)) {
    fs.unlinkSync(filepath);
  }
};
