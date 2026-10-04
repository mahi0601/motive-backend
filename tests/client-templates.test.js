// Saved client templates: an owner keeps the structure of a client (tasks, pages, milestones,
// status wording) as a reusable starting point. A template is sanitised when it is SAVED, so
// one client's confidential material is never stored in it, and it is private to its owner.
process.env.CLIENT_TEMPLATE_RATE_MAX = '1000';

const request = require('supertest');
const app = require('../src/app');
const prisma = require('../src/config/prisma');
const { accessTokenFor, makeUser, makeWorkspaceWithMembers, cleanupUsers } = require('./helpers/fixtures');

const D = (s) => new Date(`${s}T00:00:00.000Z`);
const day = (d) => (d ? d.toISOString().slice(0, 10) : null);

describe('client templates', () => {
  let owner, editor, stranger, src;
  const made = [];
  const as = async (u) => ({ Authorization: `Bearer ${await accessTokenFor(u)}` });
  const save = async (user, body, wsId = src.id) => request(app).post('/api/client-templates').set(await as(user)).send({ workspaceId: wsId, name: 'Website project', ...body });
  const list = async (user) => request(app).get('/api/client-templates').set(await as(user));
  const use = async (user, id, body = {}) => {
    const res = await request(app).post(`/api/client-templates/${id}/use`).set(await as(user)).send({ name: 'New Co', startDate: '2027-03-01', ...body });
    if (res.status === 201) made.push(res.body.workspace.id);
    return res;
  };
  const snapshotOf = async (id) => (await prisma.clientTemplate.findUnique({ where: { id } })).snapshot;

  beforeAll(async () => {
    owner = await makeUser('tplOwner', { isPro: true });
    editor = await makeUser('tplEditor');
    stranger = await makeUser('tplStranger');
    src = await makeWorkspaceWithMembers(owner, { editors: [editor] });
    await prisma.workspace.update({ where: { id: src.id }, data: { name: 'Acme Redesign', statusHeadline: 'Website for Acme', statusSummary: 'Phase 1', statusAccent: 'violet' } });

    const t1 = await prisma.task.create({ data: { title: 'Kickoff call', description: 'Agree scope', priority: 'High', category: 'Client work', tags: ['onboarding'], status: 'done', completedAt: D('2026-10-01'), dueDate: D('2026-10-01'), recurrence: 'weekly', userId: owner.id, workspaceId: src.id, assigneeId: editor.id, position: 0 } });
    await prisma.task.create({ data: { title: 'First review', priority: 'Medium', dueDate: D('2026-10-11'), userId: owner.id, workspaceId: src.id, position: 1 } });
    await prisma.task.create({ data: { title: 'Undated task', userId: owner.id, workspaceId: src.id, position: 2 } });
    await prisma.subtask.create({ data: { title: 'Send agenda', done: true, taskId: t1.id } });
    await prisma.comment.create({ data: { taskId: t1.id, userId: editor.id, text: 'CONFIDENTIAL CLIENT COMMENT' } });
    await prisma.file.create({ data: { name: 'secret-contract.pdf', url: 'https://api.example.test/uploads/secret-contract.pdf', size: 10, uploadedBy: owner.id, taskId: t1.id } });

    const root = await prisma.page.create({ data: { title: 'Project brief', icon: '📝', cover: 'https://api.example.test/uploads/cover.png', workspaceId: src.id, ownerId: owner.id, position: 0 } });
    await prisma.page.create({ data: { title: 'Kickoff notes', parentId: root.id, workspaceId: src.id, ownerId: owner.id, position: 0 } });
    await prisma.block.createMany({
      data: [
        { pageId: root.id, type: 'heading1', content: { text: 'Brief' }, position: 0 },
        { pageId: root.id, type: 'image', content: { url: 'https://api.example.test/uploads/logo.png' }, position: 1 },
        { pageId: root.id, type: 'embed', content: { url: 'https://docs.example.test/private' }, position: 2 },
        { pageId: root.id, type: 'paragraph', content: { html: 'See <a href="https://api.example.test/uploads/brief.pdf">brief</a>' }, position: 3 },
      ],
    });
    await prisma.milestone.create({ data: { workspaceId: src.id, title: 'Design sign-off', date: D('2026-10-20'), position: 0, version: 2 } });
    await prisma.clientFeedback.create({ data: { workspaceId: src.id, kind: 'approve', authorName: 'Ann Client', milestoneTitle: 'Design sign-off', milestoneVersion: 2 } });
    await prisma.workspace.update({ where: { id: src.id }, data: { shareTokenHash: `hash-${Date.now()}`, shareEnabledAt: new Date() } });
  });
  afterEach(async () => {
    await prisma.clientTemplate.deleteMany({ where: { ownerId: { in: [owner.id, stranger.id] } } });
  });
  afterAll(async () => {
    await prisma.workspace.deleteMany({ where: { id: { in: made } } });
    delete process.env.CLIENT_TEMPLATE_RATE_MAX;
    await cleanupUsers(owner, editor, stranger);
    await prisma.$disconnect();
  });

  describe('saving', () => {
    test('saves what a copy would hold, and says how much', async () => {
      const res = await save(owner, { description: 'Our standard build' });
      expect(res.status).toBe(201);
      expect(res.body.template).toMatchObject({ name: 'Website project', description: 'Our standard build', counts: { tasks: 3, pages: 2, milestones: 1 } });
      expect(res.body.template.snapshot).toBeUndefined();
    });

    test('nothing confidential is stored: no comments, files, people, approvals, link, cover or upload URLs', async () => {
      const id = (await save(owner)).body.template.id;
      const text = JSON.stringify(await snapshotOf(id));
      for (const leak of ['CONFIDENTIAL', 'secret-contract', 'Ann Client', 'cover.png', 'logo.png', 'docs.example.test', 'brief.pdf', 'hash-', owner.id, editor.id, owner.email, editor.email, src.id]) {
        expect(text).not.toContain(leak);
      }
      expect(text).toContain('Kickoff call'); // while the structure itself is there
    });

    test('image, embed and uploaded-file blocks become a placeholder', async () => {
      const id = (await save(owner)).body.template.id;
      const blocks = (await snapshotOf(id)).pages[0].blocks.map((b) => [b.type, b.content.text ?? null]);
      expect(blocks.filter(([t]) => t === 'image' || t === 'embed')).toEqual([]);
      expect(blocks.filter(([, text]) => text && text.includes('was not copied')).length).toBe(3);
    });

    test('dates are stored as offsets from the earliest, never as calendar dates', async () => {
      const snap = await snapshotOf((await save(owner)).body.template.id);
      expect(snap.tasks.map((t) => t.due && t.due.offset)).toEqual([0, 10, null]);
      expect(snap.milestones[0].date.offset).toBe(19);
      expect(JSON.stringify(snap)).not.toMatch(/2026-10/);
    });

    test('only the owner of the client can save it: editors, strangers and signed-out callers cannot', async () => {
      expect((await save(editor)).status).toBe(403);
      expect((await save(stranger)).status).toBe(403);
      expect((await request(app).post('/api/client-templates').send({ workspaceId: src.id, name: 'x' })).status).toBe(401);
      expect(await prisma.clientTemplate.count({ where: { ownerId: { in: [owner.id, editor.id, stranger.id] } } })).toBe(0);
    });

    test.each([
      ['no name', { name: '' }],
      ['a name over 100 characters', { name: 'x'.repeat(101) }],
      ['a description over 300 characters', { description: 'x'.repeat(301) }],
      ['a non-string name', { name: 5 }],
    ])('refuses %s', async (_n, body) => {
      expect((await save(owner, body)).status).toBe(422);
    });

    test('refuses a client with more than 500 tasks, naming the reason', async () => {
      const big = await makeWorkspaceWithMembers(owner, {});
      await prisma.task.createMany({ data: Array.from({ length: 501 }, (_, i) => ({ title: `t${i}`, userId: owner.id, workspaceId: big.id, position: i })) });
      const res = await save(owner, {}, big.id);
      expect(res.status).toBe(422);
      expect(res.body.message).toMatch(/501 tasks/);
    });

    test('refuses a snapshot over about 2 MB', async () => {
      const big = await makeWorkspaceWithMembers(owner, {});
      const page = await prisma.page.create({ data: { title: 'Huge', workspaceId: big.id, ownerId: owner.id } });
      await prisma.block.create({ data: { pageId: page.id, type: 'paragraph', content: { text: 'x'.repeat(2_200_000) }, position: 0 } });
      const res = await save(owner, {}, big.id);
      expect(res.status).toBe(422);
      expect(res.body.message).toMatch(/too large/i);
    });

    test('at most 20 templates per owner; the 21st is refused and nothing extra is stored', async () => {
      await prisma.clientTemplate.createMany({ data: Array.from({ length: 20 }, (_, i) => ({ ownerId: owner.id, name: `T${i}`, snapshot: {} })) });
      const res = await save(owner);
      expect(res.status).toBe(409);
      expect(res.body.message).toMatch(/20/);
      expect(await prisma.clientTemplate.count({ where: { ownerId: owner.id } })).toBe(20);
      // another owner has their own allowance
      expect((await save(owner, {}, src.id)).status).toBe(409);
    });

    test('is written to the audit trail with counts only', async () => {
      const id = (await save(owner)).body.template.id;
      const ev = await prisma.securityEvent.findFirst({ where: { type: 'client_template_saved', actorId: owner.id }, orderBy: { createdAt: 'desc' } });
      expect(ev).toBeTruthy();
      expect(ev.meta).toEqual({ tasks: 3, pages: 2, milestones: 1 });
      expect(JSON.stringify(ev)).not.toMatch(/Kickoff|Website project|Acme/);
      expect(id).toBeTruthy();
    });
  });

  describe('listing and deleting', () => {
    test('lists only the caller’s own templates, newest first, without the snapshot', async () => {
      const a = (await save(owner, { name: 'A' })).body.template.id;
      const b = (await save(owner, { name: 'B' })).body.template.id;
      const mine = await list(owner);
      expect(mine.status).toBe(200);
      expect(mine.body.templates.map((t) => t.id)).toEqual([b, a]);
      expect(Object.keys(mine.body.templates[0]).sort()).toEqual(['counts', 'createdAt', 'description', 'id', 'name']);
      expect((await list(stranger)).body.templates).toEqual([]);
      expect((await request(app).get('/api/client-templates')).status).toBe(401);
    });

    test('another owner cannot delete it; the owner can; it is then gone', async () => {
      const id = (await save(owner)).body.template.id;
      const del = async (u) => request(app).delete(`/api/client-templates/${id}`).set(await as(u));
      expect((await del(stranger)).status).toBe(404);
      expect(await prisma.clientTemplate.count({ where: { id } })).toBe(1);
      expect((await del(owner)).status).toBe(200);
      expect(await prisma.clientTemplate.count({ where: { id } })).toBe(0);
      expect((await del(owner)).status).toBe(404);
    });

    test('a template survives deleting the client it came from', async () => {
      const own = await makeWorkspaceWithMembers(owner, {});
      await prisma.task.create({ data: { title: 'Only task', userId: owner.id, workspaceId: own.id } });
      const id = (await save(owner, {}, own.id)).body.template.id;
      await prisma.workspace.delete({ where: { id: own.id } });
      const res = await use(owner, id);
      expect(res.status).toBe(201);
      expect(res.body.counts).toEqual({ tasks: 1, pages: 0, milestones: 0 });
    });
  });

  describe('using a template', () => {
    test('creates a new client owned by the caller, from the stored structure', async () => {
      const id = (await save(owner)).body.template.id;
      const res = await use(owner, id);
      expect(res.status).toBe(201);
      expect(res.body.counts).toEqual({ tasks: 3, pages: 2, milestones: 1 });
      const ws = await prisma.workspace.findUnique({ where: { id: res.body.workspace.id }, include: { members: true } });
      expect(ws).toMatchObject({ name: 'New Co', ownerId: owner.id, statusHeadline: 'Website for Acme', statusAccent: 'violet' });
      expect(ws.members.map((m) => [m.userId, m.role])).toEqual([[owner.id, 'owner']]);
      const tasks = await prisma.task.findMany({ where: { workspaceId: ws.id }, orderBy: { position: 'asc' }, include: { subtasks: true } });
      expect(tasks.map((t) => [t.title, t.status, t.userId])).toEqual([['Kickoff call', 'todo', owner.id], ['First review', 'todo', owner.id], ['Undated task', 'todo', owner.id]]);
      expect(tasks[0]).toMatchObject({ priority: 'High', recurrence: 'weekly', tags: ['onboarding'], completedAt: null, assigneeId: owner.id });
      expect(tasks[0].subtasks.map((s) => [s.title, s.done])).toEqual([['Send agenda', false]]);
    });

    test('dates land from the start date, keeping the gaps; no start date means no dates', async () => {
      const id = (await save(owner)).body.template.id;
      const dated = await use(owner, id, { startDate: '2027-03-01' });
      const tasks = await prisma.task.findMany({ where: { workspaceId: dated.body.workspace.id }, orderBy: { position: 'asc' } });
      expect(tasks.map((t) => day(t.dueDate))).toEqual(['2027-03-01', '2027-03-11', null]);
      const ms = await prisma.milestone.findMany({ where: { workspaceId: dated.body.workspace.id } });
      expect(ms.map((m) => [m.title, day(m.date), m.version])).toEqual([['Design sign-off', '2027-03-20', 0]]);
      const undated = await use(owner, id, { startDate: undefined });
      expect((await prisma.task.findMany({ where: { workspaceId: undated.body.workspace.id } })).map((t) => t.dueDate)).toEqual([null, null, null]);
    });

    test('the same template can be used again and again, each time independent', async () => {
      const id = (await save(owner)).body.template.id;
      const one = await use(owner, id, { name: 'One' });
      const two = await use(owner, id, { name: 'Two' });
      expect(one.body.workspace.id).not.toBe(two.body.workspace.id);
      await prisma.task.deleteMany({ where: { workspaceId: one.body.workspace.id } });
      expect(await prisma.task.count({ where: { workspaceId: two.body.workspace.id } })).toBe(3);
      expect(await prisma.clientTemplate.count({ where: { id } })).toBe(1);
    });

    test('leaving sections out copies the rest', async () => {
      const id = (await save(owner)).body.template.id;
      const res = await use(owner, id, { include: { pages: false, statusText: false } });
      expect(res.body.counts).toEqual({ tasks: 3, pages: 0, milestones: 1 });
      const ws = await prisma.workspace.findUnique({ where: { id: res.body.workspace.id } });
      expect(ws.statusHeadline).toBeNull();
    });

    test('another owner cannot use it (404, nothing created); signed-out callers get 401', async () => {
      const id = (await save(owner)).body.template.id;
      const before = await prisma.workspace.count({ where: { ownerId: stranger.id } });
      expect((await use(stranger, id)).status).toBe(404);
      expect(await prisma.workspace.count({ where: { ownerId: stranger.id } })).toBe(before);
      expect((await request(app).post(`/api/client-templates/${id}/use`).send({ name: 'x' })).status).toBe(401);
    });

    test('needs a valid name and start date', async () => {
      const id = (await save(owner)).body.template.id;
      expect((await use(owner, id, { name: '' })).status).toBe(422);
      expect((await use(owner, id, { startDate: 'tomorrow' })).status).toBe(422);
      expect((await use(owner, id, { include: { tasks: 'yes' } })).status).toBe(422);
    });

    test('a tampered snapshot cannot inject ids, owners, files or unknown block types', async () => {
      const id = (await save(owner)).body.template.id;
      const snap = await snapshotOf(id);
      snap.tasks[0].userId = stranger.id;
      snap.tasks[0].id = 'forced-id';
      snap.tasks[0].priority = 'Urgent';
      snap.pages[0].ownerId = stranger.id;
      snap.pages[0].blocks.push({ ref: 'bx', type: 'script', content: { text: 'x' }, position: 9 });
      snap.pages[0].blocks.push({ ref: 'by', type: 'paragraph', content: { url: 'https://api.example.test/uploads/evil.pdf' }, position: 10 });
      await prisma.clientTemplate.update({ where: { id }, data: { snapshot: snap } });
      const res = await use(owner, id);
      expect(res.status).toBe(201);
      const ws = res.body.workspace.id;
      const tasks = await prisma.task.findMany({ where: { workspaceId: ws } });
      expect(tasks.every((t) => t.userId === owner.id && t.id !== 'forced-id')).toBe(true);
      expect(tasks.find((t) => t.title === 'Kickoff call').priority).toBe('Low');
      expect((await prisma.page.findMany({ where: { workspaceId: ws } })).every((p) => p.ownerId === owner.id)).toBe(true);
      const blocks = await prisma.block.findMany({ where: { page: { workspaceId: ws } } });
      expect(blocks.map((b) => b.type)).not.toContain('script');
      expect(JSON.stringify(blocks)).not.toContain('evil.pdf');
    });

    test('is written to the audit trail with counts only', async () => {
      const id = (await save(owner)).body.template.id;
      const res = await use(owner, id);
      const ev = await prisma.securityEvent.findFirst({ where: { type: 'client_template_used', actorId: owner.id }, orderBy: { createdAt: 'desc' } });
      expect(ev.workspaceId).toBe(res.body.workspace.id);
      expect(ev.meta).toEqual({ tasks: 3, pages: 2, milestones: 1 });
    });
  });
});
