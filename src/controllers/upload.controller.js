// src/controllers/upload.controller.js
const FileService = require('../services/file.service');
const asyncHandler = require('../utils/asyncHandler');
const AppError = require('../utils/AppError');

exports.uploadFile = asyncHandler(async (req, res) => {
  if (!req.file) throw AppError.badRequest('No file uploaded');

  const { taskId } = req.body;
  const { fileUrl, file } = await FileService.upload(
    req.file,
    { protocol: req.protocol, host: req.get('host') },
    taskId,
    req.user.id
  );

  res.status(200).json({ success: true, fileUrl, file });
});
