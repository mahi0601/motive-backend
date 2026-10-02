const prisma = require('../config/prisma');
const taskService = require('./task.service');

// Everyone who can be @mentioned on a task: the commenter, and the owner and
// members of THE TASK'S workspace. Not everyone the commenter shares some other
// workspace with: otherwise a mention on a client-facing task could notify (and
// confirm the existence of) people from an unrelated team. A task with no
// workspace (legacy personal rows) allows only the commenter.
async function getMentionableUserIds(userId, workspaceId) {
  const ids = new Set([userId]);
  if (!workspaceId) return ids;
  const ws = await prisma.workspace.findUnique({
    where: { id: workspaceId },
    select: { ownerId: true, members: { select: { userId: true } } },
  });
  if (ws) {
    ids.add(ws.ownerId);
    ws.members.forEach((m) => ids.add(m.userId));
  }
  return ids;
}

// Mentions are authored as @[Display Name](userId), parsed back into a styled
// chip client-side. Extracts the distinct mentioned user ids. Every part is
// bounded (a display name is at most 100 characters and contains no "]" or
// newline; an id is 1-64 URL-safe characters), so the match cannot backtrack
// over a long hostile string: CodeQL flagged the unbounded version as
// polynomial ReDoS on comment text of up to 5000 characters.
const MENTION_RE = /@\[[^\]\n]{1,100}\]\(([A-Za-z0-9_-]{1,64})\)/g;
const extractMentionedUserIds = (text) => [...new Set([...text.matchAll(MENTION_RE)].map((m) => m[1]))];
exports._internals = { extractMentionedUserIds };

// Returns `{ comment, notifications }` — the controller emits `notifications`
// over sockets itself (matching block.service.js/block.controller.js's
// split: this service owns persistence, the controller owns the realtime
// side effect) rather than this service reaching into socket.handler.js.
exports.addComment = async (taskId, userId, text) => {
  // Any workspace member (owner/editor/viewer) can comment on a shared
  // task — a viewer leaving feedback (e.g. a client) is a normal case, not
  // an edge case, so this deliberately only requires 'read', not 'write'.
  const task = await taskService.assertAccess(taskId, userId, 'read');

  const comment = await prisma.comment.create({
    data: { taskId, userId, text },
    include: { user: { select: { name: true } } },
  });

  const mentionableIds = await getMentionableUserIds(userId, task.workspaceId);
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
  await taskService.assertAccess(taskId, userId, 'read');
  // Oldest first, with a ceiling: a task with thousands of comments must not
  // load them all in one request.
  return prisma.comment.findMany({
    where: { taskId },
    orderBy: { createdAt: 'asc' },
    take: 500,
    include: { user: { select: { name: true, email: true } } },
  });
};
