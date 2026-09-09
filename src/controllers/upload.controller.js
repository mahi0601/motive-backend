// src/controllers/upload.controller.js
const FileService = require('../services/file.service');
const asyncHandler = require('../utils/asyncHandler');

exports.uploadFile = asyncHandler(async (req, res) => {
  if (!req.file) {
    return res.status(400).json({ success: false, message: 'No file uploaded' });
  }

  const { taskId } = req.body;
  const { fileUrl, file } = await FileService.upload(
    req.file,
    { protocol: req.protocol, host: req.get('host') },
    taskId,
    req.user.id
  );

  res.status(200).json({ success: true, fileUrl, file });
});
