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
//
// Two steps, shared with saved client templates: collectStructure() reads a workspace into a
// plain, JSON-safe, already-sanitised structure; createFromStructure() builds a new workspace
// from one. A structure never holds ids, people or files, and dates are day offsets.
const crypto = require('crypto');
const prisma = require('../config/prisma');
const config = require('../config/env');
const AppError = require('../utils/AppError');
const audit = require('./audit.service');
const workspaceService = require('./workspace.service');
const { earliest } = require('../utils/dateShift');
const { ACCENTS, DEFAULT_ACCENT } = require('../utils/statusAccents');

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

const DAY_MS = 24 * 60 * 60 * 1000;
const utcDay = (d) => Math.floor(new Date(d).getTime() / DAY_MS);
const BLOCK_TYPES = new Set(['paragraph', 'heading1', 'heading2', 'heading3', 'bulleted', 'numbered', 'todo', 'toggle', 'quote', 'code', 'divider', 'image', 'callout', 'table', 'embed']);
const asText = (v, max) => String(v ?? '').slice(0, max);
const oneOf = (v, allowed, fallback) => (allowed.includes(v) ? v : fallback);

// A date as whole UTC days from the anchor, plus its time of day, so it can land on any start date.
const offsetOf = (d, anchor) => (d && anchor ? { offset: utcDay(d) - utcDay(anchor), time: new Date(d).getTime() - utcDay(d) * DAY_MS } : null);
const placeOn = (o, start) => (o && start ? new Date((utcDay(start) + o.offset) * DAY_MS + o.time) : null);

// Reads what a copy of `workspaceId` would contain. `include` picks the sections.
exports.collectStructure = async (workspaceId, include = {}) => {
  const want = { tasks: true, pages: true, milestones: true, statusText: true, ...include };
  const [taskCount, pageCount] = await Promise.all([
    want.tasks ? prisma.task.count({ where: { workspaceId } }) : 0,
    want.pages ? prisma.page.count({ where: { workspaceId, archived: false } }) : 0,
  ]);
  if (taskCount > MAX_TASKS) throw new AppError(`This project has ${taskCount} tasks and up to ${MAX_TASKS} tasks can be copied. Leave tasks out, or archive some first.`, 422);
  if (pageCount > MAX_PAGES) throw new AppError(`This project has ${pageCount} pages and up to ${MAX_PAGES} pages can be copied. Leave pages out, or archive some first.`, 422);

  const [source, tasks, pages, milestones] = await Promise.all([
    prisma.workspace.findUnique({ where: { id: workspaceId }, select: { statusHeadline: true, statusSummary: true, statusAccent: true } }),
    want.tasks
      ? prisma.task.findMany({ where: { workspaceId }, orderBy: [{ position: 'asc' }, { createdAt: 'asc' }], include: { subtasks: { orderBy: { createdAt: 'asc' } } } })
      : [],
    want.pages
      ? prisma.page.findMany({ where: { workspaceId, archived: false }, include: { blocks: { orderBy: [{ position: 'asc' }, { createdAt: 'asc' }] } } })
      : [],
    want.milestones ? prisma.milestone.findMany({ where: { workspaceId }, orderBy: { position: 'asc' } }) : [],
  ]);

  // Every date moves by the same whole number of days, so the gaps are kept: the earliest
  // dated task or milestone is day 0.
  const anchor = earliest([...tasks.map((t) => t.dueDate), ...milestones.map((m) => m.date)]);

  // Pages parent-first, so a child's parent is always created first. A parent that was
  // not copied (archived) makes the child a top-level page.
  const pageRef = new Map(pages.map((p, i) => [p.id, `p${i}`]));
  const depth = (p, seen = new Set()) => (p.parentId && pageRef.has(p.parentId) && !seen.has(p.id) ? 1 + depth(pages.find((x) => x.id === p.parentId), seen.add(p.id)) : 0);
  const ordered = [...pages].sort((a, b) => depth(a) - depth(b) || a.position - b.position);

  return {
    version: 1,
    status: want.statusText ? { headline: source.statusHeadline, summary: source.statusSummary, accent: source.statusAccent } : null,
    tasks: tasks.map((t) => ({
      title: t.title, description: t.description, priority: t.priority, category: t.category, tags: t.tags, recurrence: t.recurrence,
      due: offsetOf(t.dueDate, anchor), subtasks: t.subtasks.map((s) => s.title),
    })),
    pages: ordered.map((p) => {
      const blockRef = new Map(p.blocks.map((b, i) => [b.id, `b${i}`]));
      return {
        ref: pageRef.get(p.id), parentRef: p.parentId && pageRef.has(p.parentId) ? pageRef.get(p.parentId) : null,
        title: p.title, icon: p.icon, position: p.position,
        blocks: p.blocks.map((b) => ({ ref: blockRef.get(b.id), parentRef: b.parentBlockId && blockRef.has(b.parentBlockId) ? blockRef.get(b.parentBlockId) : null, ...safeBlock(b), position: b.position })),
      };
    }),
    milestones: milestones.map((m) => ({ title: m.title, date: offsetOf(m.date, anchor) })),
  };
};

// Rebuilds a structure from whitelisted fields only, so a stored snapshot can never inject
// ids, owners, files or unknown block types. Blocks are sanitised again on the way in.
exports.cleanStructure = (raw) => {
  const r = raw && typeof raw === 'object' ? raw : {};
  const date = (o) => (o && Number.isInteger(o.offset) && Number.isFinite(o.time) ? { offset: o.offset, time: o.time } : null);
  const list = (v) => (Array.isArray(v) ? v : []);
  return {
    version: 1,
    status: r.status ? { headline: r.status.headline == null ? null : asText(r.status.headline, 200), summary: r.status.summary == null ? null : asText(r.status.summary, 2000), accent: oneOf(r.status.accent, ACCENTS, DEFAULT_ACCENT) } : null,
    tasks: list(r.tasks).map((t) => ({
      title: asText(t.title, 200), description: t.description == null ? null : asText(t.description, 5000), priority: oneOf(t.priority, ['Low', 'Medium', 'High'], 'Low'), category: asText(t.category, 60) || 'Personal',
      tags: list(t.tags).map((x) => asText(x, 40)), recurrence: oneOf(t.recurrence, ['daily', 'weekly', 'monthly'], null), due: date(t.due), subtasks: list(t.subtasks).map((x) => asText(x, 200)),
    })),
    pages: list(r.pages).map((p) => ({
      ref: asText(p.ref, 20), parentRef: p.parentRef ? asText(p.parentRef, 20) : null, title: asText(p.title, 200), icon: asText(p.icon, 16), position: Number(p.position) || 0,
      blocks: list(p.blocks).map((b) => ({
        ref: asText(b.ref, 20), parentRef: b.parentRef ? asText(b.parentRef, 20) : null, position: Number(b.position) || 0,
        ...(BLOCK_TYPES.has(b.type) ? safeBlock(b) : { type: 'paragraph', content: { text: PLACEHOLDER } }),
      })),
    })),
    milestones: list(r.milestones).map((m) => ({ title: asText(m.title, 200), date: date(m.date) })),
  };
};

// Creates the new workspace (owned by `ownerId`) in one transaction. `start` (a Date) is where
// day 0 lands; with no start date, dates are dropped rather than left pointing at the past.
exports.createFromStructure = async (rawStructure, { ownerId, name, start = null, include = {} }) => {
  const want = { tasks: true, pages: true, milestones: true, statusText: true, ...include };
  const s = exports.cleanStructure(rawStructure);
  const tasks = want.tasks ? s.tasks : [];
  const pages = want.pages ? s.pages : [];
  const milestones = want.milestones ? s.milestones : [];
  const pageIds = new Map(pages.map((p) => [p.ref, crypto.randomUUID()]));

  const created = await prisma.$transaction(
    async (tx) => {
      const ws = await tx.workspace.create({
        data: {
          name,
          ownerId,
          members: { create: [{ userId: ownerId, role: 'owner' }] },
          ...(want.statusText && s.status ? { statusHeadline: s.status.headline, statusSummary: s.status.summary, statusAccent: s.status.accent } : {}),
        },
      });

      if (tasks.length) {
        const ids = tasks.map(() => crypto.randomUUID());
        await tx.task.createMany({
          data: tasks.map((t, i) => ({
            id: ids[i],
            title: t.title,
            description: t.description,
            priority: t.priority,
            category: t.category,
            tags: t.tags,
            recurrence: t.recurrence,
            dueDate: placeOn(t.due, start),
            status: 'todo',
            completedAt: null,
            userId: ownerId,
            workspaceId: ws.id,
            assigneeId: ownerId,
            position: i,
          })),
        });
        const subtasks = tasks.flatMap((t, i) => t.subtasks.map((title) => ({ title, done: false, taskId: ids[i] })));
        if (subtasks.length) await tx.subtask.createMany({ data: subtasks });
      }

      if (pages.length) {
        await tx.page.createMany({
          data: pages.map((p) => ({
            id: pageIds.get(p.ref),
            title: p.title,
            icon: p.icon,
            cover: '', // a cover is an uploaded image of the previous client
            parentId: p.parentRef && pageIds.has(p.parentRef) ? pageIds.get(p.parentRef) : null,
            workspaceId: ws.id,
            ownerId,
            position: p.position,
          })),
        });
        const blocks = pages.flatMap((p) => {
          const ids = new Map(p.blocks.map((b) => [b.ref, crypto.randomUUID()]));
          return p.blocks.map((b) => ({
            id: ids.get(b.ref),
            pageId: pageIds.get(p.ref),
            type: b.type,
            content: b.content,
            position: b.position,
            parentBlockId: b.parentRef && ids.has(b.parentRef) ? ids.get(b.parentRef) : null,
          }));
        });
        if (blocks.length) await tx.block.createMany({ data: blocks });
      }

      if (milestones.length) {
        await tx.milestone.createMany({ data: milestones.map((m, i) => ({ workspaceId: ws.id, title: m.title, date: placeOn(m.date, start), position: i })) });
      }
      return ws;
    },
    { timeout: 20000 }
  );
  return { workspace: created, counts: { tasks: tasks.length, pages: pages.length, milestones: milestones.length } };
};

exports.duplicate = async (workspaceId, requesterId, input = {}) => {
  await workspaceService.assertOwner(workspaceId, requesterId);
  const include = { tasks: true, pages: true, milestones: true, statusText: true, ...(input.include || {}) };
  const structure = await exports.collectStructure(workspaceId, include);
  const start = input.startDate ? new Date(input.startDate) : null;
  const { workspace, counts } = await exports.createFromStructure(structure, { ownerId: requesterId, name: String(input.name).trim(), start, include });
  await audit.record({ type: 'workspace_duplicated', actorId: requesterId, workspaceId: workspace.id, meta: counts });
  return { workspace: { id: workspace.id, name: workspace.name }, counts };
};
