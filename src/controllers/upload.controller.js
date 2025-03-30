// src/controllers/upload.controller.js
const path = require('path');

exports.uploadFile = async (req, res, next) => {
  try {
    if (!req.file) {
      return res.status(400).json({ success: false, message: 'No file uploaded' });
    }

    const fileUrl = `${req.protocol}://${req.get('host')}/uploads/${req.file.filename}`;
    res.status(200).json({ success: true, fileUrl });
  } catch (err) {
    next(err);
  }
};
