const prisma = require('../config/prisma');
const AppError = require('../utils/AppError');
const storageService = require('./storage.service');
const taskService = require('./task.service');

// `taskId` is optional — a bare upload (no task association) still just
// returns the URL/file row.
exports.upload = async (file, { protocol, host }, taskId, userId) => {
  if (taskId) await taskService.assertOwner(taskId, userId);

  const { url: fileUrl } = await storageService.saveFile(file, { protocol, host });
  const fileRow = await prisma.file.create({
    data: { name: file.originalname, url: fileUrl, uploadedBy: userId, taskId: taskId || null },
  });
  return { fileUrl, file: fileRow };
};

exports.listByTask = async (taskId, userId) => {
  await taskService.assertOwner(taskId, userId);
  return prisma.file.findMany({ where: { taskId }, orderBy: { createdAt: 'desc' } });
};

exports.remove = async (id, userId) => {
  const file = await prisma.file.findFirst({ where: { id, uploadedBy: userId } });
  if (!file) throw AppError.notFound('File not found');

  await prisma.file.delete({ where: { id } });
  // Best-effort cleanup on whichever backend actually stored it (R2 or
  // local disk) — a failure here shouldn't fail the request, the DB record
  // (the source of truth for "is this attached to anything") is already gone.
  storageService.deleteFile(file.url).catch(() => {});
};
