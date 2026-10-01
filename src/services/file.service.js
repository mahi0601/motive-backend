const prisma = require('../config/prisma');
const AppError = require('../utils/AppError');
const storageService = require('./storage.service');
const taskService = require('./task.service');

// `taskId` is optional — a bare upload (no task association) still just
// returns the URL/file row. Attaching a file to a task is a content
// mutation, same as adding a subtask — requires 'write'.
//
// Each account has a storage quota — a free account a small one, Pro a large
// one — checked before anything is written to the bucket. Concurrent uploads
// can overshoot by a file or two; the point is a ceiling on abuse, not exact
// accounting.
const MB = 1024 * 1024;
const QUOTA_BYTES = {
  free: (parseInt(process.env.UPLOAD_QUOTA_FREE_MB, 10) || 100) * MB,
  pro: (parseInt(process.env.UPLOAD_QUOTA_PRO_MB, 10) || 2048) * MB,
};

exports.upload = async (file, taskId, userId) => {
  if (taskId) await taskService.assertAccess(taskId, userId, 'write');

  const size = file.size ?? file.buffer?.length ?? 0;
  const [user, used] = await Promise.all([
    prisma.user.findUnique({ where: { id: userId }, select: { isPro: true } }),
    prisma.file.aggregate({ where: { uploadedBy: userId }, _sum: { size: true } }),
  ]);
  const quota = user?.isPro ? QUOTA_BYTES.pro : QUOTA_BYTES.free;
  if ((used._sum.size || 0) + size > quota) {
    throw new AppError(
      `You have used your ${Math.round(quota / MB)} MB of file storage — delete some files${user?.isPro ? '' : ' or upgrade to Motive Pro'} to upload more.`,
      413
    );
  }

  const { url: fileUrl } = await storageService.saveFile(file);
  const fileRow = await prisma.file.create({
    data: { name: file.originalname, url: fileUrl, size, uploadedBy: userId, taskId: taskId || null },
  });
  return { fileUrl, file: fileRow };
};

exports.listByTask = async (taskId, userId) => {
  await taskService.assertAccess(taskId, userId, 'read');
  return prisma.file.findMany({ where: { taskId }, orderBy: { createdAt: 'desc' } });
};

// Deliberately still uploader-only, unlike everything else touched in this
// pass — this is "can you delete a specific file," a different question
// from "do you have write access to the task it's attached to." Left
// exactly as it was; broadening it to any workspace editor is a real
// product decision (should an editor be able to delete a teammate's
// upload?) that shouldn't be bundled into a consistency fix.
exports.remove = async (id, userId) => {
  const file = await prisma.file.findFirst({ where: { id, uploadedBy: userId } });
  if (!file) throw AppError.notFound('File not found');

  await prisma.file.delete({ where: { id } });
  // Best-effort cleanup on whichever backend actually stored it (R2 or
  // local disk) — a failure here shouldn't fail the request, the DB record
  // (the source of truth for "is this attached to anything") is already gone.
  storageService.deleteFile(file.url).catch(() => {});
};
