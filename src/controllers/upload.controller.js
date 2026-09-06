// src/controllers/upload.controller.js
const prisma = require('../config/prisma');
const AppError = require('../utils/AppError');

exports.uploadFile = async (req, res, next) => {
  try {
    if (!req.file) {
      return res.status(400).json({ success: false, message: 'No file uploaded' });
    }

    const fileUrl = `${req.protocol}://${req.get('host')}/uploads/${req.file.filename}`;

    // taskId is optional — a bare upload (no task association) still just
    // returns the URL, same as before. Previously nothing was ever persisted
    // to the database at all, even when a taskId was implied by the caller —
    // there was no way to list "files attached to this task" afterward.
    const { taskId } = req.body;
    if (taskId) {
      const task = await prisma.task.findFirst({ where: { id: taskId, userId: req.user.id } });
      if (!task) throw AppError.notFound('Task not found');
    }

    const file = await prisma.file.create({
      data: {
        name: req.file.originalname,
        url: fileUrl,
        uploadedBy: req.user.id,
        taskId: taskId || null,
      },
    });

    res.status(200).json({ success: true, fileUrl, file });
  } catch (err) {
    next(err);
  }
};
