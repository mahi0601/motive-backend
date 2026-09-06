const prisma = require('../config/prisma');
const AppError = require('../utils/AppError');
const fs = require('fs');
const path = require('path');

exports.listByTask = async (req, res, next) => {
  try {
    const { taskId } = req.params;
    const task = await prisma.task.findFirst({ where: { id: taskId, userId: req.user.id } });
    if (!task) throw AppError.notFound('Task not found');

    const files = await prisma.file.findMany({ where: { taskId }, orderBy: { createdAt: 'desc' } });
    res.status(200).json({ success: true, files });
  } catch (err) {
    next(err);
  }
};

exports.remove = async (req, res, next) => {
  try {
    const { id } = req.params;
    const file = await prisma.file.findFirst({ where: { id, uploadedBy: req.user.id } });
    if (!file) throw AppError.notFound('File not found');

    await prisma.file.delete({ where: { id } });
    // Best-effort disk cleanup — a failure here shouldn't fail the request,
    // the DB record (the source of truth for "is this attached to anything")
    // is already gone.
    const diskPath = path.join('public/uploads', path.basename(file.url));
    fs.unlink(diskPath, () => {});

    res.status(200).json({ success: true, message: 'File deleted' });
  } catch (err) {
    next(err);
  }
};
