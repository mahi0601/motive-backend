const Workspace = require('../models/workspace.model');

// Returns the user's workspaces; creates a default one on first access.
exports.listForUser = async (userId) => {
  let workspaces = await Workspace.find({
    $or: [{ ownerId: userId }, { 'members.userId': userId }],
  }).sort('createdAt');

  if (workspaces.length === 0) {
    const ws = await Workspace.create({
      name: 'My Workspace',
      ownerId: userId,
      members: [{ userId, role: 'owner' }],
    });
    workspaces = [ws];
  }
  return workspaces;
};

exports.getDefault = async (userId) => {
  const [ws] = await exports.listForUser(userId);
  return ws;
};

exports.create = (data, userId) =>
  Workspace.create({
    ...data,
    ownerId: userId,
    members: [{ userId, role: 'owner' }],
  });

// True if the user may access the workspace (owner or member).
exports.canAccess = async (workspaceId, userId) => {
  const ws = await Workspace.findOne({
    _id: workspaceId,
    $or: [{ ownerId: userId }, { 'members.userId': userId }],
  });
  return !!ws;
};
