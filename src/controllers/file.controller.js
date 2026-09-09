const FileService = require('../services/file.service');
const asyncHandler = require('../utils/asyncHandler');

exports.listByTask = asyncHandler(async (req, res) => {
  const files = await FileService.listByTask(req.params.taskId, req.user.id);
  res.status(200).json({ success: true, files });
});

exports.remove = asyncHandler(async (req, res) => {
  await FileService.remove(req.params.id, req.user.id);
  res.status(200).json({ success: true, message: 'File deleted' });
});
