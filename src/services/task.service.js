const prisma = require('../config/prisma');
const AppError = require('../utils/AppError');
const activityLog = require('./activityLog.service');

// Paginated, indexed read — scales to large task counts per user.
exports.getAll = async (userId, { skip, limit }) => {
  const [items, total] = await Promise.all([
    prisma.task.findMany({ where: { userId }, orderBy: { position: 'asc' }, skip, take: limit }),
    prisma.task.count({ where: { userId } }),
  ]);
  return { items, total };
};

// Shared by comment/subtask/file services (and upload.controller.js) — each
// used to re-implement this same "does this task belong to this user" check
// with a slightly different shape. `title` is included since the comment
// service needs it for notification text; callers that only need existence
// can just ignore it.
exports.assertOwner = async (taskId, userId) => {
  const task = await prisma.task.findFirst({ where: { id: taskId, userId }, select: { id: true, title: true } });
  if (!task) throw AppError.notFound('Task not found');
  return task;
};

// Title search, for the command palette — mirrors page.service.js's search.
exports.search = async (term, userId) => {
  if (!term || !term.trim()) return [];
  return prisma.task.findMany({
    where: { userId, title: { contains: term.trim(), mode: 'insensitive' } },
    orderBy: { position: 'asc' },
    take: 20,
  });
};

const WRITABLE_FIELDS = ['title', 'description', 'priority', 'status', 'category', 'dueDate', 'tags', 'recurrence'];

function nextOccurrence(from, frequency) {
  const d = new Date(from);
  if (frequency === 'daily') d.setDate(d.getDate() + 1);
  else if (frequency === 'weekly') d.setDate(d.getDate() + 7);
  else if (frequency === 'monthly') d.setMonth(d.getMonth() + 1);
  return d;
}

// Completing a recurring task creates its next occurrence immediately,
// rather than a scheduled job generating instances ahead of time — simpler,
// and naturally idempotent (exactly one next-occurrence per completion, no
// risk of a cron run double-generating). Carries over everything except the
// completion state and due date, which moves forward by one interval (from
// the old due date if there was one, else from today).
async function spawnNextOccurrence(task, userId) {
  const dueDate = nextOccurrence(task.dueDate || new Date(), task.recurrence);
  await prisma.$transaction(
    async (tx) => {
      const count = await tx.task.count({ where: { userId } });
      return tx.task.create({
        data: {
          title: task.title,
          description: task.description,
          priority: task.priority,
          category: task.category,
          tags: task.tags,
          recurrence: task.recurrence,
          dueDate,
          userId,
          position: count,
        },
      });
    },
    { isolationLevel: 'Serializable' }
  );
}

// `completedAt` isn't client-writable — it's derived from the `status`
// transition so the statistics service has a trustworthy "when" for a
// completion, independent of `updatedAt` (which changes on any edit).
// Needs the task's *previous* status: re-sending `status: 'done'` on a task
// that's already done (e.g. bulk-complete selecting a mixed set of done and
// not-done tasks) must NOT re-stamp `completedAt` to "now" — it isn't a new
// completion.
function withCompletedAt(patch, previousStatus) {
  if (!('status' in patch)) return patch;
  if (patch.status === 'done') {
    if (previousStatus !== 'done') patch.completedAt = new Date();
    // else: already done — leave completedAt exactly as it was.
  } else {
    patch.completedAt = null;
  }
  return patch;
}

// `<input type="date">` (used by the task modal) sends a date-only string
// like "2026-09-15", which Prisma's DateTime scalar rejects outright
// ("Expected ISO-8601 DateTime") — only the Calendar page's own
// `date.toISOString()` calls happened to already be full datetimes. Coerce
// here so any caller can send either shape.
function withNormalizedDueDate(patch) {
  if ('dueDate' in patch) patch.dueDate = patch.dueDate ? new Date(patch.dueDate) : null;
  return patch;
}

exports.create = async (data, userId) => {
  const patch = {};
  for (const key of WRITABLE_FIELDS) if (key in data) patch[key] = data[key];
  withCompletedAt(patch);
  withNormalizedDueDate(patch);

  // count+create wrapped in a Serializable transaction so two concurrent
  // creates can't both read the same count and collide on `position`.
  const task = await prisma.$transaction(
    async (tx) => {
      const count = await tx.task.count({ where: { userId } });
      return tx.task.create({ data: { ...patch, userId, position: count } });
    },
    { isolationLevel: 'Serializable' }
  );
  activityLog.log('created', userId, { taskId: task.id, description: `Created "${task.title}"` });
  return task;
};

exports.update = async (id, data, userId) => {
  const patch = {};
  for (const key of [...WRITABLE_FIELDS, 'position']) if (key in data) patch[key] = data[key];

  // Fetched up front to detect a genuine todo→done transition — without
  // this, re-sending status:'done' on an already-done task (bulk-complete
  // selecting a mixed set, a fast double-click, etc.) would look identical
  // to a first-time completion.
  const existing = await prisma.task.findFirst({ where: { id, userId }, select: { status: true } });
  if (!existing) throw AppError.notFound('Task not found');
  const isNewCompletion = patch.status === 'done' && existing.status !== 'done';

  withCompletedAt(patch, existing.status);
  withNormalizedDueDate(patch);

  const { count } = await prisma.task.updateMany({ where: { id, userId }, data: patch });
  if (!count) throw AppError.notFound('Task not found');
  const task = await prisma.task.findUnique({ where: { id } });

  // Only a genuine first-time completion is the interesting activity-feed
  // moment (and spawns the next recurrence) — a redundant re-completion is
  // a no-op, not a second "Completed" event.
  if (isNewCompletion) {
    activityLog.log('completed', userId, { taskId: task.id, description: `Completed "${task.title}"` });
    if (task.recurrence) await spawnNextOccurrence(task, userId);
  } else {
    activityLog.log('updated', userId, { taskId: task.id, description: `Updated "${task.title}"` });
  }
  return task;
};

exports.remove = async (id, userId) => {
  const task = await prisma.task.findUnique({ where: { id }, select: { title: true } });
  const { count } = await prisma.task.deleteMany({ where: { id, userId } });
  if (!count) throw AppError.notFound('Task not found');
  activityLog.log('deleted', userId, { description: `Deleted "${task?.title ?? 'a task'}"` });
  return { deleted: true };
};
