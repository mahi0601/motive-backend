const prisma = require('../config/prisma');

// Returns the user's workspaces; creates a default one on first access.
exports.listForUser = async (userId) => {
  let workspaces = await prisma.workspace.findMany({
    where: { OR: [{ ownerId: userId }, { members: { some: { userId } } }] },
    include: { members: true },
    orderBy: { createdAt: 'asc' },
  });

  if (workspaces.length === 0) {
    const ws = await prisma.workspace.create({
      data: {
        name: 'My Workspace',
        ownerId: userId,
        members: { create: [{ userId, role: 'owner' }] },
      },
      include: { members: true },
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
  prisma.workspace.create({
    data: {
      ...data,
      ownerId: userId,
      members: { create: [{ userId, role: 'owner' }] },
    },
    include: { members: true },
  });

// True if the user may access the workspace (owner or member).
exports.canAccess = async (workspaceId, userId) => {
  const ws = await prisma.workspace.findFirst({
    where: { id: workspaceId, OR: [{ ownerId: userId }, { members: { some: { userId } } }] },
  });
  return !!ws;
};
