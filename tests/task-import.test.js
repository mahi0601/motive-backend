// Importing tasks in bulk (the frontend parses a CSV and sends rows). All or
// nothing: any invalid row refuses the whole batch with the row's position, so a
// half-imported file never happens. Only an allowlist of fields is read from a row,
// the caller must be able to write to the workspace, and a task marked done is given
// a completion date that keeps the Momentum numbers honest rather than counting a
// whole backlog as shipped today.
process.env.IMPORT_RATE_MAX = '1000'; // this file imports many times from one ip

const request = require('supertest');
const app = require('../src/app');
const prisma = require('../src/config/prisma');
const { accessTokenFor, makeUser, makeWorkspaceWithMembers, cleanupUsers } = require('./helpers/fixtures');

describe('POST /api/tasks/import', () => {
  let owner, editor, viewer, stranger, ws;
  const as = async (u) => ({ Authorization: `Bearer ${await accessTokenFor(u)}` });
  const post = async (user, body) => request(app).post('/api/tasks/import').set(await as(user)).send(body);
  const tasksOf = (userId) => prisma.task.findMany({ where: { userId }, orderBy: { position: 'asc' } });
  const fresh = async (label) => {
    const u = await makeUser(label);
    created.push(u);
    return u;
  };
  const created = [];

  beforeAll(async () => {
    owner = await makeUser('impOwner');
    editor = await makeUser('impEditor');
    viewer = await makeUser('impViewer');
    stranger = await makeUser('impStranger');
    ws = await makeWorkspaceWithMembers(owner, { editors: [editor], viewers: [viewer] });
  });
  beforeEach(async () => {
    await prisma.task.deleteMany({ where: { userId: { in: [owner.id, editor.id, viewer.id, stranger.id, ...created.map((u) => u.id)] } } });
  });
  afterAll(async () => {
    delete process.env.IMPORT_RATE_MAX;
    await cleanupUsers(owner, editor, viewer, stranger, ...created);
    await prisma.$disconnect();
  });

  describe('importing', () => {
    test('creates every row as the caller\'s task, in order, with the fields from the file', async () => {
      const res = await post(owner, {
        tasks: [
          { title: 'Write brief', description: 'First draft', status: 'in_progress', priority: 'High', category: 'Client work', dueDate: '2026-12-01', tags: ['acme', 'copy'] },
          { title: 'Send invoice' },
        ],
      });
      expect(res.status).toBe(201);
      expect(res.body).toMatchObject({ success: true, imported: 2 });
      const tasks = await tasksOf(owner.id);
      expect(tasks.map((t) => t.title)).toEqual(['Write brief', 'Send invoice']);
      expect(tasks[0]).toMatchObject({ description: 'First draft', status: 'in_progress', priority: 'High', category: 'Client work', tags: ['acme', 'copy'] });
      expect(tasks[0].dueDate.toISOString().slice(0, 10)).toBe('2026-12-01');
      expect(tasks[1]).toMatchObject({ status: 'todo', userId: owner.id, assigneeId: owner.id });
    });

    test('they land in the caller\'s default workspace when none is named', async () => {
      await post(owner, { tasks: [{ title: 'A' }] });
      const [t] = await tasksOf(owner.id);
      expect(t.workspaceId).toBeTruthy();
    });

    test('positions continue after the tasks already there', async () => {
      await post(owner, { tasks: [{ title: 'Existing 1' }, { title: 'Existing 2' }] });
      await post(owner, { tasks: [{ title: 'New 1' }, { title: 'New 2' }] });
      const tasks = await tasksOf(owner.id);
      expect(tasks.map((t) => t.position)).toEqual([0, 1, 2, 3]);
      expect(tasks.map((t) => t.title)).toEqual(['Existing 1', 'Existing 2', 'New 1', 'New 2']);
    });

    test('500 rows is allowed and 501 is not', async () => {
      const rows = (n) => Array.from({ length: n }, (_, i) => ({ title: `Task ${i}` }));
      expect((await post(owner, { tasks: rows(500) })).body.imported).toBe(500);
      expect((await tasksOf(owner.id))).toHaveLength(500);
      expect((await post(owner, { tasks: rows(501) })).status).toBe(422);
      expect((await tasksOf(owner.id))).toHaveLength(500);
    });

    test('text stays text: markup in a title is stored as the same characters', async () => {
      await post(owner, { tasks: [{ title: '<img src=x onerror=alert(1)>' }] });
      expect((await tasksOf(owner.id))[0].title).toBe('<img src=x onerror=alert(1)>');
    });

    test('control characters, including a NUL that the database would reject, are removed; newlines are kept', async () => {
      const res = await post(owner, { tasks: [{ title: 'Bad\u0000 title\u0007', description: 'line1\nline2\u0000' }] });
      expect(res.status).toBe(201);
      const [t] = await tasksOf(owner.id);
      expect(t.title).toBe('Bad title');
      expect(t.description).toBe('line1\nline2');
    });
  });

  describe('only an allowlist of fields is read from a row', () => {
    test('ids, owners, workspaces, assignees and timestamps in a row are ignored', async () => {
      await post(owner, {
        tasks: [{ title: 'Mine', id: 'forced-id', userId: stranger.id, workspaceId: 'someone-elses', assigneeId: stranger.id, createdAt: '2000-01-01T00:00:00Z', position: 99, recurrence: 'daily' }],
      });
      const [t] = await tasksOf(owner.id);
      expect(t.id).not.toBe('forced-id');
      expect(t).toMatchObject({ userId: owner.id, assigneeId: owner.id, position: 0, recurrence: null });
      expect(t.workspaceId).not.toBe('someone-elses');
      expect(t.createdAt.getFullYear()).toBeGreaterThan(2000);
      expect(await tasksOf(stranger.id)).toHaveLength(0);
    });
  });

  describe('a done task gets a completion date that keeps Momentum honest', () => {
    const done = async (row) => {
      const res = await post(owner, { tasks: [{ title: 'D', status: 'done', ...row }] });
      expect(res.status).toBe(201);
      return (await tasksOf(owner.id)).at(-1);
    };

    test('the date in the file, when there is one', async () => {
      const t = await done({ completedAt: '2026-03-04', dueDate: '2026-05-01' });
      expect(t.completedAt.toISOString().slice(0, 10)).toBe('2026-03-04');
    });

    test('otherwise the due date, so it counts as on time and not as shipped today', async () => {
      const t = await done({ dueDate: '2026-05-01' });
      expect(t.completedAt.toISOString().slice(0, 10)).toBe('2026-05-01');
    });

    test('a due date in the future is never used as a completion date: it is capped at now', async () => {
      const t = await done({ dueDate: '2099-01-01' });
      expect(t.completedAt.getTime()).toBeLessThanOrEqual(Date.now() + 1000);
    });

    test('a completion date in the future is capped at now too', async () => {
      const t = await done({ completedAt: '2099-01-01' });
      expect(t.completedAt.getTime()).toBeLessThanOrEqual(Date.now() + 1000);
    });

    test('with neither date it is left empty rather than invented', async () => {
      expect((await done({})).completedAt).toBeNull();
    });

    test('a task that is not done never gets one, even if the file had a date', async () => {
      await post(owner, { tasks: [{ title: 'Open', status: 'todo', completedAt: '2026-03-04' }, { title: 'Doing', status: 'in_progress', completedAt: '2026-03-04' }] });
      const tasks = await tasksOf(owner.id);
      expect(tasks.map((t) => t.completedAt)).toEqual([null, null]);
    });

    test('Momentum is not distorted by an imported backlog of done work', async () => {
      await post(owner, { tasks: [{ title: 'Old work', status: 'done', dueDate: '2026-01-15' }] });
      const momentum = require('../src/services/momentum.service');
      const m = await momentum.getMomentum(owner.id, { period: 'week', timezone: 'UTC' });
      // Not shipped this week or last, and not an overdue task in last period's snapshot.
      expect(m.tiles.shipped).toMatchObject({ value: 0, previous: 0 });
      expect(m.tiles.overdue).toMatchObject({ value: 0, previous: 0 });
    });

    test('the same task with NO completion date WOULD distort the last-period overdue tile (why the rule exists)', async () => {
      await prisma.task.create({ data: { title: 'Old work', status: 'done', dueDate: new Date('2026-01-15'), completedAt: null, userId: owner.id } });
      const momentum = require('../src/services/momentum.service');
      const m = await momentum.getMomentum(owner.id, { period: 'week', timezone: 'UTC' });
      expect(m.tiles.overdue.previous).toBe(1);
    });
  });

  describe('all or nothing', () => {
    test.each([
      ['no tasks key', {}],
      ['an empty list', { tasks: [] }],
      ['tasks that is not a list', { tasks: 'a,b' }],
      ['a row that is not an object', { tasks: [{ title: 'ok' }, 'nope'] }],
      ['a missing title', { tasks: [{ title: 'ok' }, { description: 'no title' }] }],
      ['a blank title', { tasks: [{ title: 'ok' }, { title: '   ' }] }],
      ['a title that is only control characters', { tasks: [{ title: 'ok' }, { title: '\u0000\u0007' }] }],
      ['a title over 500 characters', { tasks: [{ title: 'ok' }, { title: 'x'.repeat(501) }] }],
      ['an unknown status', { tasks: [{ title: 'ok' }, { title: 'b', status: 'blocked' }] }],
      ['an unknown priority', { tasks: [{ title: 'ok' }, { title: 'b', priority: 'Urgent' }] }],
      ['a date that is not a date', { tasks: [{ title: 'ok' }, { title: 'b', dueDate: 'next tuesday' }] }],
      ['a completion date that is not a date', { tasks: [{ title: 'ok' }, { title: 'b', status: 'done', completedAt: 'soon' }] }],
      ['more than 50 tags', { tasks: [{ title: 'ok' }, { title: 'b', tags: Array.from({ length: 51 }, (_, i) => `t${i}`) }] }],
      ['a tag over 50 characters', { tasks: [{ title: 'ok' }, { title: 'b', tags: ['x'.repeat(51)] }] }],
      ['a description over 10000 characters', { tasks: [{ title: 'ok' }, { title: 'b', description: 'x'.repeat(10001) }] }],
      ['a category over 100 characters', { tasks: [{ title: 'ok' }, { title: 'b', category: 'x'.repeat(101) }] }],
    ])('%s is refused with 422 and nothing at all is imported', async (_label, body) => {
      const res = await post(owner, body);
      expect(res.status).toBe(422);
      expect(await tasksOf(owner.id)).toHaveLength(0);
    });

    test('the refusal names the row, so the file can be fixed (rows are counted from 1)', async () => {
      const res = await post(owner, { tasks: [{ title: 'ok' }, { title: 'ok too' }, { title: '' }] });
      expect(res.status).toBe(422);
      expect(res.body.errors.some((e) => /3/.test(e.message) || /tasks\[2\]/.test(e.field))).toBe(true);
    });

    test('a blank due date or completion date means none, not an error', async () => {
      expect((await post(owner, { tasks: [{ title: 'A', dueDate: '', completedAt: '' }] })).status).toBe(201);
      expect((await tasksOf(owner.id))[0].dueDate).toBeNull();
    });
  });

  describe('who may import where', () => {
    test('needs a signed-in user', async () => {
      expect((await request(app).post('/api/tasks/import').send({ tasks: [{ title: 'A' }] })).status).toBe(401);
    });

    test('an editor can import into the shared workspace, and the tasks belong to the editor in that workspace', async () => {
      const res = await post(editor, { workspaceId: ws.id, tasks: [{ title: 'From editor' }] });
      expect(res.status).toBe(201);
      const [t] = await tasksOf(editor.id);
      expect(t).toMatchObject({ workspaceId: ws.id, userId: editor.id });
    });

    test('the owner can import into their shared workspace', async () => {
      expect((await post(owner, { workspaceId: ws.id, tasks: [{ title: 'A' }] })).status).toBe(201);
    });

    test('a viewer cannot, and nothing is created', async () => {
      const res = await post(viewer, { workspaceId: ws.id, tasks: [{ title: 'A' }] });
      expect(res.status).toBe(403);
      expect(await tasksOf(viewer.id)).toHaveLength(0);
    });

    test('someone outside the workspace cannot, and a workspace that does not exist is refused the same way', async () => {
      expect((await post(stranger, { workspaceId: ws.id, tasks: [{ title: 'A' }] })).status).toBe(403);
      expect((await post(stranger, { workspaceId: 'does-not-exist', tasks: [{ title: 'A' }] })).status).toBe(403);
      expect(await tasksOf(stranger.id)).toHaveLength(0);
    });
  });

  describe('side effects', () => {
    test('the very first tasks count as the first task (the activation event), later imports do not', async () => {
      const u = await fresh('impFirst');
      await post(u, { tasks: [{ title: 'One' }] });
      await post(u, { tasks: [{ title: 'Two' }] });
      await new Promise((r) => setTimeout(r, 300));
      expect(await prisma.productEvent.count({ where: { name: 'first_task_created', userId: u.id } })).toBe(1);
    });

    test('one activity entry says how many were imported, not one per task', async () => {
      const u = await fresh('impActivity');
      await post(u, { tasks: [{ title: 'A' }, { title: 'B' }, { title: 'C' }] });
      await new Promise((r) => setTimeout(r, 300));
      const rows = await prisma.activityLog.findMany({ where: { userId: u.id } });
      expect(rows).toHaveLength(1);
      expect(rows[0].description).toMatch(/imported 3 tasks/i);
    });

    test('the import is recorded in the audit trail with a count, never the titles', async () => {
      const u = await fresh('impAudit');
      await post(u, { tasks: [{ title: 'Secret client name' }] });
      const rows = await prisma.securityEvent.findMany({ where: { type: 'tasks_imported', actorId: u.id } });
      expect(rows).toHaveLength(1);
      expect(rows[0].meta).toEqual({ count: 1 });
      expect(JSON.stringify(rows[0])).not.toMatch(/Secret client name/);
    });
  });
});
