// "Start a new client from this one": copies the STRUCTURE of a workspace the caller owns
// into a fresh workspace, so the next client is ready in one step.
//
// Copied: tasks (reset to To do, dates shifted to a new start date), their subtasks (reset),
// the page tree with its blocks, milestones (clean slate), and optionally the status page
// wording. NEVER copied: comments, files, activity, notifications, client feedback and
// sign-offs, members, invites, the share link, the response / branding switches, covers,
// archived pages. Image and embed blocks, and any block that links an uploaded file, are
// replaced with a placeholder, because they can point at the previous client's files.
// Everything is created in one transaction, so a failure creates nothing.
const crypto = require('crypto');
const prisma = require('../config/prisma');
const config = require('../config/env');
const AppError = require('../utils/AppError');
const audit = require('./audit.service');
const workspaceService = require('./workspace.service');
const { dayShift, shiftDate, earliest } = require('../utils/dateShift');

const MAX_TASKS = 500;
const MAX_PAGES = 200;
const PLACEHOLDER = 'A file or image was here in the source project and was not copied.';
const ALWAYS_PLACEHOLDER = new Set(['image', 'embed']);

// A block can hold a link to a file uploaded for the previous client (a local upload path
// or the public storage address). Conservative on purpose: if it looks like one, it is not
// copied.
const uploadMarkers = () => ['/uploads/', config.r2?.publicUrl].filter(Boolean);
const pointsAtUploads = (content) => {
  const text = JSON.stringify(content ?? {});
  return uploadMarkers().some((m) => text.includes(m));
};

const safeBlock = (b) =>
  ALWAYS_PLACEHOLDER.has(b.type) || pointsAtUploads(b.content)
    ? { type: 'paragraph', content: { text: PLACEHOLDER } }
    : { type: b.type, content: b.content ?? {} };

exports.duplicate = async (workspaceId, requesterId, input = {}) => {
  const source = await workspaceService.assertOwner(workspaceId, requesterId);
  const include = { tasks: true, pages: true, milestones: true, statusText: true, ...(input.include || {}) };
  const name = String(input.name).trim();
  const start = input.startDate ? new Date(input.startDate) : null;

  const [taskCount, pageCount] = await Promise.all([
    include.tasks ? prisma.task.count({ where: { workspaceId } }) : 0,
    include.pages ? prisma.page.count({ where: { workspaceId, archived: false } }) : 0,
  ]);
  if (taskCount > MAX_TASKS) throw new AppError(`This project has ${taskCount} tasks and up to ${MAX_TASKS} tasks can be copied. Leave tasks out, or archive some first.`, 422);
  if (pageCount > MAX_PAGES) throw new AppError(`This project has ${pageCount} pages and up to ${MAX_PAGES} pages can be copied. Leave pages out, or archive some first.`, 422);

  const [tasks, pages, milestones] = await Promise.all([
    include.tasks
      ? prisma.task.findMany({ where: { workspaceId }, orderBy: [{ position: 'asc' }, { createdAt: 'asc' }], include: { subtasks: { orderBy: { createdAt: 'asc' } } } })
      : [],
    include.pages
      ? prisma.page.findMany({ where: { workspaceId, archived: false }, include: { blocks: { orderBy: [{ position: 'asc' }, { createdAt: 'asc' }] } } })
      : [],
    include.milestones ? prisma.milestone.findMany({ where: { workspaceId }, orderBy: { position: 'asc' } }) : [],
  ]);

  // Every date moves by the same whole number of days, so the gaps are kept: the earliest
  // dated task or milestone lands on the start date. With no start date, dates are dropped
  // rather than left pointing at the past.
  const anchor = earliest([...tasks.map((t) => t.dueDate), ...milestones.map((m) => m.date)]);
  const move = (d) => (d && start && anchor ? shiftDate(d, dayShift(anchor, start)) : null);

  // Pages parent-first, so a child's parent is always in the same batch. A parent that was
  // not copied (archived) makes the child a top-level page.
  const pageIds = new Map(pages.map((p) => [p.id, crypto.randomUUID()]));
  const depth = (p, seen = new Set()) => (p.parentId && pageIds.has(p.parentId) && !seen.has(p.id) ? 1 + depth(pages.find((x) => x.id === p.parentId), seen.add(p.id)) : 0);
  const orderedPages = [...pages].sort((a, b) => depth(a) - depth(b) || a.position - b.position);

  const taskIds = new Map(tasks.map((t) => [t.id, crypto.randomUUID()]));

  const created = await prisma.$transaction(
    async (tx) => {
      const ws = await tx.workspace.create({
        data: {
          name,
          ownerId: requesterId,
          members: { create: [{ userId: requesterId, role: 'owner' }] },
          ...(include.statusText ? { statusHeadline: source.statusHeadline, statusSummary: source.statusSummary, statusAccent: source.statusAccent } : {}),
        },
      });

      if (tasks.length) {
        await tx.task.createMany({
          data: tasks.map((t, i) => ({
            id: taskIds.get(t.id),
            title: t.title,
            description: t.description,
            priority: t.priority,
            category: t.category,
            tags: t.tags,
            recurrence: t.recurrence,
            dueDate: move(t.dueDate),
            status: 'todo',
            completedAt: null,
            userId: requesterId,
            workspaceId: ws.id,
            assigneeId: requesterId,
            position: i,
          })),
        });
        const subtasks = tasks.flatMap((t) => t.subtasks.map((s) => ({ title: s.title, done: false, taskId: taskIds.get(t.id) })));
        if (subtasks.length) await tx.subtask.createMany({ data: subtasks });
      }

      if (pages.length) {
        await tx.page.createMany({
          data: orderedPages.map((p) => ({
            id: pageIds.get(p.id),
            title: p.title,
            icon: p.icon,
            cover: '', // a cover is an uploaded image of the previous client
            parentId: p.parentId && pageIds.has(p.parentId) ? pageIds.get(p.parentId) : null,
            workspaceId: ws.id,
            ownerId: requesterId,
            position: p.position,
          })),
        });
        const blockIds = new Map(pages.flatMap((p) => p.blocks.map((b) => [b.id, crypto.randomUUID()])));
        const blocks = pages.flatMap((p) =>
          p.blocks.map((b) => ({
            id: blockIds.get(b.id),
            pageId: pageIds.get(p.id),
            ...safeBlock(b),
            position: b.position,
            parentBlockId: b.parentBlockId && blockIds.has(b.parentBlockId) ? blockIds.get(b.parentBlockId) : null,
          }))
        );
        if (blocks.length) await tx.block.createMany({ data: blocks });
      }

      if (milestones.length) {
        await tx.milestone.createMany({ data: milestones.map((m, i) => ({ workspaceId: ws.id, title: m.title, date: move(m.date), position: i })) });
      }
      return ws;
    },
    { timeout: 20000 }
  );

  const counts = { tasks: tasks.length, pages: pages.length, milestones: milestones.length };
  await audit.record({ type: 'workspace_duplicated', actorId: requesterId, workspaceId: created.id, meta: counts });
  return { workspace: { id: created.id, name: created.name }, counts };
};
