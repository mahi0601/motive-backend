const mongoose = require('mongoose');
const User = require('../models/user.model');
const Task = require('../models/task.model');
const Subtask = require('../models/subtask.model');
const Comment = require('../models/comment.model');
const Notification = require('../models/notification.model');
const File = require('../models/file.model');
const ActivityLog = require('../models/activityLog.model');
const Page = require('../models/page.model');
const Block = require('../models/block.model');
const Workspace = require('../models/workspace.model');
const AppError = require('../utils/AppError');

exports.getProfile = (userId) => User.findById(userId);

exports.updateProfile = async (userId, data) => {
  // Whitelist updatable fields — never let a client patch password/email/tokenVersion here.
  const patch = {};
  ['name', 'avatar'].forEach((k) => {
    if (k in data) patch[k] = data[k];
  });
  const user = await User.findByIdAndUpdate(userId, patch, { new: true, runValidators: true });
  if (!user) throw AppError.notFound('User not found');
  return user;
};

// Delete the account and ALL data owned by the user, atomically when possible.
exports.deleteAccount = async (userId, password) => {
  const user = await User.findById(userId).select('+password');
  if (!user) throw AppError.notFound('User not found');

  // Re-authenticate before an irreversible, destructive action.
  const valid = await user.comparePassword(password);
  if (!valid) throw AppError.unauthorized('Incorrect password');

  // IDs needed to reach data that references the user indirectly.
  const taskIds = (await Task.find({ userId }).select('_id').lean()).map((t) => t._id);
  const pageIds = (await Page.find({ ownerId: userId }).select('_id').lean()).map((p) => p._id);

  const runDeletes = async (session) => {
    const opts = session ? { session } : {};
    await Promise.all([
      Subtask.deleteMany({ taskId: { $in: taskIds } }, opts),
      Comment.deleteMany({ $or: [{ userId }, { taskId: { $in: taskIds } }] }, opts),
      File.deleteMany({ $or: [{ uploadedBy: userId }, { taskId: { $in: taskIds } }] }, opts),
      ActivityLog.deleteMany({ $or: [{ userId }, { taskId: { $in: taskIds } }] }, opts),
      Block.deleteMany({ pageId: { $in: pageIds } }, opts),
      Notification.deleteMany({ userId }, opts),
    ]);
    // Delete parents after their children.
    await Page.deleteMany({ ownerId: userId }, opts);
    await Task.deleteMany({ userId }, opts);
    await Workspace.deleteMany({ ownerId: userId }, opts);
    // Remove the user from workspaces owned by others.
    await Workspace.updateMany(
      { 'members.userId': userId },
      { $pull: { members: { userId } } },
      opts
    );
    await User.deleteOne({ _id: userId }, opts);
  };

  // Prefer a transaction (all-or-nothing). Standalone MongoDB has no transactions,
  // so fall back to a best-effort sequential delete.
  let session;
  try {
    session = await mongoose.startSession();
    await session.withTransaction(() => runDeletes(session));
  } catch (err) {
    if (/Transaction|replica set|not supported/i.test(err.message)) {
      await runDeletes(); // non-transactional fallback (dev / standalone)
    } else {
      throw err;
    }
  } finally {
    if (session) session.endSession();
  }

  return { deleted: true };
};
