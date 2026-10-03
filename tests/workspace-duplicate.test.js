// "Start a new client from this one": copies the STRUCTURE of a workspace the caller owns
// into a fresh workspace. Structure means tasks (reset to To do, dates shifted to a new
// start date), their subtasks (reset), pages with their blocks, and milestones. It never
// carries one client's confidential material to the next: no comments, files, feedback,
// sign-offs, members, invites or share link, and image / embed / uploaded-file blocks are
// replaced with a placeholder because they can point at the previous client's files.
process.env.DUPLICATE_RATE_MAX = '1000'; // this file duplicates many times from one ip

const request = require('supertest');
const app = require('../src/app');
const prisma = require('../src/config/prisma');
const { accessTokenFor, makeUser, makeWorkspaceWithMembers, cleanupUsers } = require('./helpers/fixtures');

const D = (s) => new Date(`${s}T00:00:00.000Z`);
const day = (d) => (d ? d.toISOString().slice(0, 10) : null);

describe('POST /api/workspaces/:id/duplicate', () => {
  let owner, editor, viewer, stranger, src;
  const as = async (u) => ({ Authorization: `Bearer ${await accessTokenFor(u)}` });
  const dup = async (user, body, id = src.id) => request(app).post(`/api/workspaces/${id}/duplicate`).set(await as(user)).send(body);
  const copyOf = (res) => res.body.workspace.id;
  const tasksOf = (workspaceId) => prisma.task.findMany({ where: { workspaceId }, orderBy: { position: 'asc' }, include: { subtasks: true } });
  const pagesOf = (workspaceId) => prisma.page.findMany({ where: { workspaceId }, orderBy: [{ position: 'asc' }], include: { blocks: { orderBy: { position: 'asc' } } } });
  const created = [];

  beforeAll(async () => {
    owner = await makeUser('dupOwner', { isPro: true });
    editor = await makeUser('dupEditor');
    viewer = await makeUser('dupViewer');
    stranger = await makeUser('dupStranger');
    src = await makeWorkspaceWithMembers(owner, { editors: [editor], viewers: [viewer] });
    await prisma.workspace.update({
      where: { id: src.id },
      data: { name: 'Acme Redesign', icon: '🚀', statusHeadline: 'Website redesign for Acme', statusSummary: 'Phase 2 of 3.', statusAccent: 'violet', statusAllowFeedback: true, statusHideBranding: true },
    });

    // Tasks: the first due date (Oct 1) is the anchor; another is 10 days later.
    const t1 = await prisma.task.create({
      data: { title: 'Kickoff call', description: 'Agree scope', priority: 'High', category: 'Client work', tags: ['onboarding', 'acme'], status: 'done', completedAt: D('2026-10-01'), dueDate: D('2026-10-01'), recurrence: 'weekly', userId: owner.id, workspaceId: src.id, assigneeId: editor.id, position: 0 },
    });
    const t2 = await prisma.task.create({
      data: { title: 'First review', priority: 'Medium', category: 'Client work', status: 'in_progress', dueDate: D('2026-10-11'), userId: editor.id, workspaceId: src.id, assigneeId: editor.id, position: 1 },
    });
    await prisma.task.create({ data: { title: 'Undated task', status: 'todo', userId: owner.id, workspaceId: src.id, position: 2 } });
    await prisma.subtask.createMany({ data: [{ title: 'Send agenda', done: true, taskId: t1.id }, { title: 'Book the room', done: false, taskId: t1.id }] });
    // Confidential material that must never travel.
    await prisma.comment.create({ data: { taskId: t1.id, userId: editor.id, text: 'CONFIDENTIAL CLIENT COMMENT' } });
    await prisma.file.create({ data: { name: 'secret-contract.pdf', url: 'https://api.example.test/uploads/secret-contract.pdf', size: 10, uploadedBy: owner.id, taskId: t2.id } });

    // Pages: root with a child, blocks including toggle children, an image, an uploaded-file link and an ordinary link.
    const root = await prisma.page.create({ data: { title: 'Project brief', icon: '📝', cover: 'https://api.example.test/uploads/cover.png', workspaceId: src.id, ownerId: owner.id, position: 0 } });
    const child = await prisma.page.create({ data: { title: 'Kickoff notes', icon: '📌', parentId: root.id, workspaceId: src.id, ownerId: editor.id, position: 0 } });
    await prisma.page.create({ data: { title: 'Old archived page', workspaceId: src.id, ownerId: owner.id, archived: true, position: 5 } });
    const toggle = await prisma.block.create({ data: { pageId: root.id, type: 'toggle', content: { text: 'Details' }, position: 1 } });
    await prisma.block.createMany({
      data: [
        { pageId: root.id, type: 'heading1', content: { text: 'Brief' }, position: 0 },
        { pageId: root.id, type: 'bulleted', content: { text: 'Inside the toggle' }, position: 0, parentBlockId: toggle.id },
        { pageId: root.id, type: 'image', content: { url: 'https://api.example.test/uploads/logo.png', caption: 'Client logo' }, position: 2 },
        { pageId: root.id, type: 'embed', content: { url: 'https://docs.example.test/clients-private-doc' }, position: 3 },
        { pageId: root.id, type: 'paragraph', content: { html: 'See <a href="https://api.example.test/uploads/brief.pdf">the brief</a>' }, position: 4 },
        { pageId: root.id, type: 'paragraph', content: { html: 'Read <a href="https://example.org/guide">our guide</a>' }, position: 5 },
        { pageId: child.id, type: 'todo', content: { text: 'Collect logins', checked: true }, position: 0 },
      ],
    });

    // Milestones with an approval, plus feedback, a share link and an invite.
    const m1 = await prisma.milestone.create({ data: { workspaceId: src.id, title: 'Design sign-off', date: D('2026-10-20'), position: 0, version: 3 } });
    await prisma.milestone.create({ data: { workspaceId: src.id, title: 'Launch', date: D('2026-11-30'), position: 1 } });
    await prisma.clientFeedback.create({ data: { workspaceId: src.id, kind: 'approve', authorName: 'Ann', milestoneId: m1.id, milestoneTitle: 'Design sign-off', milestoneVersion: 3 } });
    await prisma.workspaceInvite.create({ data: { workspaceId: src.id, email: 'someone@example.invalid', tokenHash: `tok-${Date.now()}`, invitedById: owner.id, expiresAt: new Date(Date.now() + 86400000) } });
    await prisma.workspace.update({ where: { id: src.id }, data: { shareTokenHash: `hash-${Date.now()}`, shareEnabledAt: new Date() } });
  });
  afterAll(async () => {
    await prisma.workspace.deleteMany({ where: { id: { in: created } } });
    delete process.env.DUPLICATE_RATE_MAX;
    await cleanupUsers(owner, editor, viewer, stranger);
    await prisma.$disconnect();
  });
  const make = async (body = {}, user = owner) => {
    const res = await dup(user, { name: 'Beta Co', startDate: '2027-03-01', ...body });
    if (res.status === 201) created.push(copyOf(res));
    return res;
  };

  describe('what is copied', () => {
    test('creates a new workspace owned by the caller, and reports what it copied', async () => {
      const res = await make();
      expect(res.status).toBe(201);
      const ws = await prisma.workspace.findUnique({ where: { id: copyOf(res) }, include: { members: true } });
      expect(ws).toMatchObject({ name: 'Beta Co', ownerId: owner.id });
      expect(ws.members.map((m) => [m.userId, m.role])).toEqual([[owner.id, 'owner']]);
      expect(res.body.counts).toEqual({ tasks: 3, pages: 2, milestones: 2 });
    });

    test('tasks keep their content, are reset to To do and unassigned from others, and belong to the caller', async () => {
      const id = copyOf(await make());
      const tasks = await tasksOf(id);
      expect(tasks.map((t) => t.title)).toEqual(['Kickoff call', 'First review', 'Undated task']);
      expect(tasks[0]).toMatchObject({ description: 'Agree scope', priority: 'High', category: 'Client work', tags: ['onboarding', 'acme'], recurrence: 'weekly' });
      for (const t of tasks) {
        expect(t).toMatchObject({ status: 'todo', completedAt: null, userId: owner.id, assigneeId: owner.id });
      }
      expect(tasks.map((t) => t.position)).toEqual([0, 1, 2]);
    });

    test('subtasks come across, all reset to not done', async () => {
      const id = copyOf(await make());
      const [kickoff] = await tasksOf(id);
      expect(kickoff.subtasks.map((s) => [s.title, s.done]).sort()).toEqual([['Book the room', false], ['Send agenda', false]]);
    });

    test('dates keep their gaps: the earliest becomes the start date and the rest move with it; undated stay undated', async () => {
      const id = copyOf(await make({ startDate: '2027-03-01' }));
      const tasks = await tasksOf(id);
      expect(day(tasks[0].dueDate)).toBe('2027-03-01'); // Oct 1 -> Mar 1 (151 days)
      expect(day(tasks[1].dueDate)).toBe('2027-03-11'); // +10 days, as before
      expect(tasks[2].dueDate).toBeNull();
      const ms = await prisma.milestone.findMany({ where: { workspaceId: id }, orderBy: { position: 'asc' } });
      expect(ms.map((m) => day(m.date))).toEqual(['2027-03-20', '2027-04-30']); // Oct 20 and Nov 30 moved by the same 151 days
    });

    test('with no start date, dates are dropped rather than left in the past', async () => {
      const id = copyOf(await make({ startDate: undefined }));
      expect((await tasksOf(id)).map((t) => t.dueDate)).toEqual([null, null, null]);
      expect((await prisma.milestone.findMany({ where: { workspaceId: id } })).map((m) => m.date)).toEqual([null, null]);
    });

    test('milestones keep their titles and order, with a clean slate: no version history, no approvals', async () => {
      const id = copyOf(await make());
      const ms = await prisma.milestone.findMany({ where: { workspaceId: id }, orderBy: { position: 'asc' } });
      expect(ms.map((m) => [m.title, m.version])).toEqual([['Design sign-off', 0], ['Launch', 0]]);
      expect(await prisma.clientFeedback.count({ where: { workspaceId: id } })).toBe(0);
    });

    test('the page tree survives, owned by the caller, with icons and titles; archived pages and covers are left behind', async () => {
      const id = copyOf(await make());
      const pages = await pagesOf(id);
      const root = pages.find((p) => p.title === 'Project brief');
      const child = pages.find((p) => p.title === 'Kickoff notes');
      expect(pages).toHaveLength(2);
      expect(root).toMatchObject({ icon: '📝', parentId: null, ownerId: owner.id, cover: '' });
      expect(child).toMatchObject({ icon: '📌', parentId: root.id, ownerId: owner.id });
      expect(pages.some((p) => p.title === 'Old archived page')).toBe(false);
    });

    test('blocks keep their order and type, toggle children stay under their toggle, and every id is new', async () => {
      const id = copyOf(await make());
      const root = (await pagesOf(id)).find((p) => p.title === 'Project brief');
      const top = root.blocks.filter((b) => !b.parentBlockId);
      expect(top.map((b) => b.type)).toEqual(['heading1', 'toggle', 'paragraph', 'paragraph', 'paragraph', 'paragraph']);
      const toggle = top.find((b) => b.type === 'toggle');
      const kids = root.blocks.filter((b) => b.parentBlockId === toggle.id);
      expect(kids.map((b) => b.content.text)).toEqual(['Inside the toggle']);
      const sourceIds = (await prisma.block.findMany({ where: { page: { workspaceId: src.id } } })).map((b) => b.id);
      expect(root.blocks.every((b) => !sourceIds.includes(b.id))).toBe(true);
    });

    test('an ordinary link in a block is kept', async () => {
      const id = copyOf(await make());
      const root = (await pagesOf(id)).find((p) => p.title === 'Project brief');
      expect(root.blocks.some((b) => JSON.stringify(b.content).includes('https://example.org/guide'))).toBe(true);
    });

    test('the status page wording comes across by default, but not the branding or response switches', async () => {
      const ws = await prisma.workspace.findUnique({ where: { id: copyOf(await make()) } });
      expect(ws).toMatchObject({ statusHeadline: 'Website redesign for Acme', statusSummary: 'Phase 2 of 3.', statusAccent: 'violet', statusAllowFeedback: false, statusHideBranding: false });
    });

    test('and can be left out', async () => {
      const ws = await prisma.workspace.findUnique({ where: { id: copyOf(await make({ include: { statusText: false } })) } });
      expect(ws).toMatchObject({ statusHeadline: null, statusSummary: null, statusAccent: 'teal' });
    });

    test.each([
      ['tasks', { tasks: false }, { tasks: 0, pages: 2, milestones: 2 }],
      ['pages', { pages: false }, { tasks: 3, pages: 0, milestones: 2 }],
      ['milestones', { milestones: false }, { tasks: 3, pages: 2, milestones: 0 }],
    ])('leaving out %s copies the rest', async (_n, include, counts) => {
      const res = await make({ include });
      expect(res.body.counts).toEqual(counts);
    });
  });

  describe('what is never copied (one client\'s material stays with that client)', () => {
    let copyId;
    beforeAll(async () => {
      copyId = copyOf(await make());
    });

    test('no comments, files, activity or notifications', async () => {
      const taskIds = (await tasksOf(copyId)).map((t) => t.id);
      expect(await prisma.comment.count({ where: { taskId: { in: taskIds } } })).toBe(0);
      expect(await prisma.file.count({ where: { taskId: { in: taskIds } } })).toBe(0);
      expect(await prisma.comment.count({ where: { text: 'CONFIDENTIAL CLIENT COMMENT', taskId: { in: taskIds } } })).toBe(0);
    });

    test('no members, invites, share link or client feedback', async () => {
      // shareTokenHash is hidden from queries by default; ask for it so null is a real answer.
      const ws = await prisma.workspace.findUnique({ where: { id: copyId }, include: { members: true }, omit: { shareTokenHash: false } });
      expect(ws.members).toHaveLength(1);
      expect(ws.shareTokenHash).toBeNull();
      expect(ws.shareEnabledAt).toBeNull();
      expect(await prisma.workspaceInvite.count({ where: { workspaceId: copyId } })).toBe(0);
      expect(await prisma.clientFeedback.count({ where: { workspaceId: copyId } })).toBe(0);
    });

    test('an image block, an embed and a block linking an uploaded file become a placeholder', async () => {
      const root = (await pagesOf(copyId)).find((p) => p.title === 'Project brief');
      const all = JSON.stringify(root.blocks.map((b) => b.content));
      for (const leaked of ['logo.png', 'clients-private-doc', 'brief.pdf', 'Client logo', 'secret-contract', 'cover.png']) expect(all).not.toContain(leaked);
      const placeholders = root.blocks.filter((b) => b.type === 'paragraph' && /not copied/i.test(JSON.stringify(b.content)));
      expect(placeholders).toHaveLength(3);
      expect(root.blocks.some((b) => b.type === 'image' || b.type === 'embed')).toBe(false);
    });

    test('nothing the source held is changed: it is exactly as it was', async () => {
      const tasks = await tasksOf(src.id);
      expect(tasks.map((t) => t.status)).toEqual(['done', 'in_progress', 'todo']);
      expect(await prisma.comment.count({ where: { task: { workspaceId: src.id } } })).toBe(1);
      expect((await prisma.workspace.findUnique({ where: { id: src.id } })).shareEnabledAt).not.toBeNull();
      expect(await prisma.milestone.count({ where: { workspaceId: src.id } })).toBe(2);
      expect(await prisma.clientFeedback.count({ where: { workspaceId: src.id } })).toBe(1);
    });
  });

  describe('who may do it, and what is refused', () => {
    const workspaceCount = () => prisma.workspace.count({ where: { ownerId: { in: [owner.id, editor.id, viewer.id, stranger.id] } } });

    test.each([['an editor of it', () => editor], ['a viewer of it', () => viewer], ['someone outside it', () => stranger]])('%s cannot, and nothing is created', async (_l, who) => {
      const before = await workspaceCount();
      expect((await dup(who(), { name: 'Nope' })).status).toBe(403);
      expect(await workspaceCount()).toBe(before);
    });

    test('a workspace that does not exist is refused the same way', async () => {
      expect((await dup(owner, { name: 'X' }, 'does-not-exist')).status).toBe(403);
    });

    test('needs a signed-in user', async () => {
      expect((await request(app).post(`/api/workspaces/${src.id}/duplicate`).send({ name: 'X' })).status).toBe(401);
    });

    test.each([
      ['no name', {}],
      ['a blank name', { name: '   ' }],
      ['a name over 100 characters', { name: 'x'.repeat(101) }],
      ['a name that is not text', { name: 5 }],
      ['a start date that is not a date', { name: 'X', startDate: 'next tuesday' }],
      ['include that is not an object', { name: 'X', include: 'all' }],
      ['an include flag that is not a boolean', { name: 'X', include: { tasks: 'yes' } }],
    ])('%s is refused with 422 and creates nothing', async (_l, body) => {
      const before = await workspaceCount();
      expect((await dup(owner, body)).status).toBe(422);
      expect(await workspaceCount()).toBe(before);
    });

    test('too many tasks is refused with the reason, and nothing is created or partly copied', async () => {
      const big = await makeWorkspaceWithMembers(owner);
      await prisma.task.createMany({ data: Array.from({ length: 501 }, (_, i) => ({ title: `T${i}`, userId: owner.id, workspaceId: big.id, position: i })) });
      const before = await workspaceCount();
      const res = await dup(owner, { name: 'Big' }, big.id);
      expect(res.status).toBe(422);
      expect(res.body.message).toMatch(/500 tasks/);
      expect(await workspaceCount()).toBe(before);
    });

    test('too many pages is refused too', async () => {
      const big = await makeWorkspaceWithMembers(owner);
      await prisma.page.createMany({ data: Array.from({ length: 201 }, (_, i) => ({ title: `P${i}`, workspaceId: big.id, ownerId: owner.id, position: i })) });
      const res = await dup(owner, { name: 'Big' }, big.id);
      expect(res.status).toBe(422);
      expect(res.body.message).toMatch(/200 pages/);
    });
  });

  describe('records', () => {
    test('is written to the audit trail with counts only, never a title', async () => {
      const res = await make({ name: 'Secret Client Name' });
      const rows = await prisma.securityEvent.findMany({ where: { type: 'workspace_duplicated', workspaceId: copyOf(res) } });
      expect(rows).toHaveLength(1);
      expect(rows[0].meta).toEqual({ tasks: 3, pages: 2, milestones: 2 });
      expect(JSON.stringify(rows[0])).not.toMatch(/Secret Client Name|Kickoff call/);
    });

    test('does not write an activity entry per copied task', async () => {
      const before = await prisma.activityLog.count({ where: { userId: owner.id } });
      await make();
      expect(await prisma.activityLog.count({ where: { userId: owner.id } })).toBe(before);
    });
  });
});
