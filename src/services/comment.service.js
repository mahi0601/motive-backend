const prisma = require('../config/prisma');
const taskService = require('./task.service');
const workspaceService = require('./workspace.service');

// Everyone the requesting user could plausibly @mention: themself, plus
// every member (and owner) of every workspace they belong to — the same set
// the frontend's mention autocomplete draws from (see CommentSection.jsx).
// Mirrors the client's own rule that workspace membership is what makes
// someone mentionable, rather than trusting whatever id the client sends.
async function getMentionableUserIds(userId) {
  const workspaces = await workspaceService.listForUser(userId);
  const ids = new Set([userId]);
  workspaces.forEach((ws) => {
    ids.add(ws.ownerId);
    ws.members.forEach((m) => ids.add(m.userId));
  });
  return ids;
}

// Mentions are authored as @[Display Name](userId) — parsed back into a
// styled chip client-side. Extracts the distinct mentioned user ids.
const MENTION_RE = /@\[[^\]]+\]\(([^)]+)\)/g;
const extractMentionedUserIds = (text) => [...new Set([...text.matchAll(MENTION_RE)].map((m) => m[1]))];

// Returns `{ comment, notifications }` — the controller emits `notifications`
// over sockets itself (matching block.service.js/block.controller.js's
// split: this service owns persistence, the controller owns the realtime
// side effect) rather than this service reaching into socket.handler.js.
exports.addComment = async (taskId, userId, text) => {
  // Tasks have no workspace/collaborator model to comment on someone else's
  // task, so this also means only the task owner can ever comment — no
  // "notify the task owner" case is possible here, mentions are the only
  // way a comment notifies anyone other than yourself.
  const task = await taskService.assertOwner(taskId, userId);

  const comment = await prisma.comment.create({
    data: { taskId, userId, text },
    include: { user: { select: { name: true } } },
  });

  const mentionableIds = await getMentionableUserIds(userId);
  const mentionedIds = extractMentionedUserIds(text).filter(
    (id) => id !== userId && mentionableIds.has(id)
  );

  let notifications = [];
  if (mentionedIds.length) {
    const mentionData = mentionedIds.map((mentionedUserId) => ({
      userId: mentionedUserId,
      title: 'You were mentioned',
      message: `${comment.user.name} mentioned you on "${task.title}"`,
      type: 'mention',
    }));
    await prisma.notification.createMany({ data: mentionData });
    // createMany doesn't return the created rows (no `id`/`createdAt`) — a
    // socket push just needs enough to render a toast, not the persisted
    // id, so this client-constructed shape is fine for that.
    notifications = mentionData;
  }

  return { comment, notifications };
};

exports.getComments = async (taskId, userId) => {
  await taskService.assertOwner(taskId, userId);
  return prisma.comment.findMany({
    where: { taskId },
    include: { user: { select: { name: true, email: true } } },
  });
};
