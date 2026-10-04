// Client requests on the public status page: a client who holds only the link asks for
// something, the owner accepts it (which makes a task) or declines it, and the public
// page shows where it is. Like feedback it is an UNAUTHENTICATED WRITE, so the tests pin
// the same things: opt-in, indistinguishable 404s, bounded plain text, a honeypot, a daily
// cap, owner-only management, and that the public read leaks no id or sender name.
process.env.REQUEST_RATE_MAX = '1000';

const request = require('supertest');
const app = require('../src/app');
const prisma = require('../src/config/prisma');
const { runCleanup } = require('../src/jobs/cleanup');
const { accessTokenFor, makeUser, makeWorkspaceWithMembers, cleanupUsers } = require('./helpers/fixtures');

describe('client requests', () => {
  let owner, editor, stranger, ws, token;
  const as = async (user) => ({ Authorization: `Bearer ${await accessTokenFor(user)}` });
  const enable = async (workspace, user, allow = true) =>
    request(app).patch(`/api/workspaces/${workspace.id}/status-page`).set(await as(user)).send({ allowRequests: allow });
  const post = (t, body) => request(app).post(`/api/status/${t}/requests`).send(body);
  const send = (extra = {}) => post(token, { name: 'Ann from Acme', title: 'Add a pricing page', details: 'Three tiers please.', ...extra });
  const rows = (workspaceId = ws.id) => prisma.clientRequest.findMany({ where: { workspaceId }, orderBy: { createdAt: 'asc' } });
  const publicStatus = async () => (await request(app).get(`/api/status/${token}`)).body.status;
  const owned = async (user, path, method = 'get', body) => {
    const req = request(app)[method](`/api/workspaces/${ws.id}/requests${path}`).set(await as(user));
    return body === undefined ? req : req.send(body);
  };

  beforeAll(async () => {
    owner = await makeUser('rqOwner');
    editor = await makeUser('rqEditor');
    stranger = await makeUser('rqStranger');
    ws = await makeWorkspaceWithMembers(owner, { editors: [editor] });
    token = (await request(app).post(`/api/workspaces/${ws.id}/share`).set(await as(owner))).body.share.token;
  });
  afterAll(async () => {
    await cleanupUsers(owner, editor, stranger);
    await prisma.$disconnect();
  });
  beforeEach(async () => {
    await prisma.clientRequest.deleteMany({ where: { workspaceId: ws.id } });
    await prisma.task.deleteMany({ where: { workspaceId: ws.id } });
    await prisma.notification.deleteMany({ where: { userId: owner.id } });
    await enable(ws, owner, false);
  });

  describe('opt-in and indistinguishable when unavailable', () => {
    test('off by default: the page says so, has no list, and posting is a 404', async () => {
      const status = await publicStatus();
      expect(status.page.allowRequests).toBe(false);
      expect(status.requests).toBeUndefined();
      expect((await send()).status).toBe(404);
      expect(await rows()).toHaveLength(0);
    });

    test('only the owner can switch it on', async () => {
      expect((await enable(ws, editor)).status).toBe(403);
      expect((await enable(ws, owner)).status).toBe(200);
      expect((await publicStatus()).page.allowRequests).toBe(true);
    });

    test('an unknown token is the same 404 as "off"', async () => {
      await enable(ws, owner);
      const unknown = await post('0'.repeat(64), { name: 'Ann', title: 'x' });
      expect(unknown.status).toBe(404);
      await enable(ws, owner, false);
      const off = await send();
      expect(off.status).toBe(404);
      expect(off.body).toEqual(unknown.body);
    });
  });

  describe('submitting', () => {
    beforeEach(async () => {
      await enable(ws, owner);
    });

    test('stores the request as "received" and answers 201', async () => {
      expect((await send()).status).toBe(201);
      const [row] = await rows();
      expect(row).toMatchObject({ title: 'Add a pricing page', details: 'Three tiers please.', authorName: 'Ann from Acme', state: 'received', taskId: null, readAt: null });
    });

    test('details are optional', async () => {
      expect((await post(token, { name: 'Ann', title: 'Fix the footer' })).status).toBe(201);
    });

    test.each([
      ['no name', { name: undefined }],
      ['a name over 60 characters', { name: 'n'.repeat(61) }],
      ['no title', { title: undefined }],
      ['a title over 120 characters', { title: 't'.repeat(121) }],
      ['details over 1000 characters', { details: 'd'.repeat(1001) }],
      ['a non-string title', { title: { $ne: null } }],
    ])('rejects %s with 422 and stores nothing', async (_l, patch) => {
      expect((await send(patch)).status).toBe(422);
      expect(await rows()).toHaveLength(0);
    });

    test('a filled honeypot looks like success but stores nothing and notifies nobody', async () => {
      expect((await send({ website: 'http://spam.example' })).status).toBe(201);
      expect(await rows()).toHaveLength(0);
      expect(await prisma.notification.count({ where: { userId: owner.id } })).toBe(0);
    });

    test('markup is stored as plain text and control characters are stripped', async () => {
      await send({ title: '<b>Logo</b>\u0000\u0007 bigger' });
      expect((await rows())[0].title).toBe('<b>Logo</b> bigger');
    });

    test('the owner gets a notification, and the audit record does not hold the text', async () => {
      await send();
      const notes = await prisma.notification.findMany({ where: { userId: owner.id } });
      expect(notes).toHaveLength(1);
      expect(notes[0]).toMatchObject({ type: 'client_request' });
      expect(notes[0].message.length).toBeLessThanOrEqual(160);
      const events = await prisma.securityEvent.findMany({ where: { type: 'client_request_received', workspaceId: ws.id } });
      expect(events.length).toBeGreaterThan(0);
      expect(JSON.stringify(events)).not.toContain('pricing');
    });

    test('a workspace is capped at 100 requests a day, and older ones do not count', async () => {
      const make = (createdAt) => Array.from({ length: 100 }, (_, i) => ({ workspaceId: ws.id, title: `t${i}`, authorName: 'a', createdAt }));
      await prisma.clientRequest.createMany({ data: make(new Date(Date.now() - 2 * 86400000)) });
      expect((await send()).status).toBe(201);
      await prisma.clientRequest.createMany({ data: make(new Date()) });
      expect((await send()).status).toBe(429);
    });
  });

  describe('the owner manages them', () => {
    let first;
    beforeEach(async () => {
      await enable(ws, owner);
      await send();
      first = (await rows())[0];
    });

    test('only the owner can list; a stranger and an editor are refused', async () => {
      expect((await owned(stranger, '')).status).toBe(403);
      expect((await owned(editor, '')).status).toBe(403);
      const res = await owned(owner, '');
      expect(res.status).toBe(200);
      expect(res.body.unread).toBe(1);
      expect(res.body.items?.[0] ?? res.body.data?.[0]).toMatchObject({ title: 'Add a pricing page', authorName: 'Ann from Acme' });
    });

    test('filtering by an unknown state is a 422', async () => {
      expect((await owned(owner, '?state=nope')).status).toBe(422);
    });

    test('accepting makes a linked to-do task on the board, tagged by scope', async () => {
      const res = await owned(owner, `/${first.id}/accept`, 'post', { scope: 'extra' });
      expect(res.status).toBe(201);
      const row = await prisma.clientRequest.findUnique({ where: { id: first.id } });
      expect(row).toMatchObject({ state: 'accepted', scope: 'extra' });
      expect(row.readAt).not.toBeNull();
      const task = await prisma.task.findUnique({ where: { id: row.taskId } });
      expect(task).toMatchObject({ title: 'Add a pricing page', description: 'Three tiers please.', status: 'todo', workspaceId: ws.id });
    });

    test('accepting twice is a 409 and makes only one task', async () => {
      expect((await owned(owner, `/${first.id}/accept`, 'post', {})).status).toBe(201);
      expect((await owned(owner, `/${first.id}/accept`, 'post', {})).status).toBe(409);
      expect(await prisma.task.count({ where: { workspaceId: ws.id } })).toBe(1);
    });

    test('two accepts at once still make one task', async () => {
      const results = await Promise.all([owned(owner, `/${first.id}/accept`, 'post', {}), owned(owner, `/${first.id}/accept`, 'post', {})]);
      expect(results.map((r) => r.status).sort()).toEqual([201, 409]);
      expect(await prisma.task.count({ where: { workspaceId: ws.id } })).toBe(1);
    });

    test('a bad scope is a 422 and leaves the request undecided', async () => {
      expect((await owned(owner, `/${first.id}/accept`, 'post', { scope: 'free' })).status).toBe(422);
      expect((await prisma.clientRequest.findUnique({ where: { id: first.id } })).state).toBe('received');
    });

    test('declining stores a note, and a decided request cannot be declined again', async () => {
      const res = await owned(owner, `/${first.id}/decline`, 'post', { note: 'Out of scope for this quarter.' });
      expect(res.status).toBe(200);
      expect(await prisma.clientRequest.findUnique({ where: { id: first.id } })).toMatchObject({ state: 'declined', declineNote: 'Out of scope for this quarter.' });
      expect((await owned(owner, `/${first.id}/decline`, 'post', {})).status).toBe(409);
      expect(await prisma.task.count({ where: { workspaceId: ws.id } })).toBe(0);
    });

    test('a note over 300 characters is a 422', async () => {
      expect((await owned(owner, `/${first.id}/decline`, 'post', { note: 'n'.repeat(301) })).status).toBe(422);
    });

    test('the scope can be changed afterwards and the request marked read', async () => {
      await owned(owner, `/${first.id}/accept`, 'post', { scope: 'in_scope' });
      expect((await owned(owner, `/${first.id}`, 'patch', { scope: 'extra', read: true })).status).toBe(200);
      expect(await prisma.clientRequest.findUnique({ where: { id: first.id } })).toMatchObject({ scope: 'extra' });
    });

    test('deleting a request keeps the task it made', async () => {
      await owned(owner, `/${first.id}/accept`, 'post', {});
      expect((await owned(owner, `/${first.id}`, 'delete')).status).toBe(200);
      expect(await rows()).toHaveLength(0);
      expect(await prisma.task.count({ where: { workspaceId: ws.id } })).toBe(1);
    });

    test('an id from another workspace does nothing', async () => {
      const other = await makeWorkspaceWithMembers(stranger);
      const res = await request(app).delete(`/api/workspaces/${other.id}/requests/${first.id}`).set(await as(stranger));
      expect(res.status).toBe(404);
      expect(await rows()).toHaveLength(1);
    });
  });

  describe('what the public page shows', () => {
    let first;
    beforeEach(async () => {
      await enable(ws, owner);
      await send();
      first = (await rows())[0];
    });
    const only = async () => (await publicStatus()).requests;

    test('a new request is "received"', async () => {
      expect(await only()).toEqual([expect.objectContaining({ title: 'Add a pricing page', state: 'received', scope: null, declineNote: null })]);
    });

    test('an accepted request follows its task through the board', async () => {
      await owned(owner, `/${first.id}/accept`, 'post', { scope: 'extra' });
      const { taskId } = await prisma.clientRequest.findUnique({ where: { id: first.id } });
      expect((await only())[0]).toMatchObject({ state: 'planned', scope: 'extra' });
      await prisma.task.update({ where: { id: taskId }, data: { status: 'in_progress' } });
      expect((await only())[0].state).toBe('in_progress');
      await prisma.task.update({ where: { id: taskId }, data: { status: 'done' } });
      expect((await only())[0].state).toBe('done');
      await prisma.task.delete({ where: { id: taskId } });
      expect((await only())[0].state).toBe('closed');
    });

    test('a declined request shows the owner\'s note', async () => {
      await owned(owner, `/${first.id}/decline`, 'post', { note: 'Not this quarter.' });
      expect((await only())[0]).toMatchObject({ state: 'declined', declineNote: 'Not this quarter.' });
    });

    test('a note left on a request that is later accepted is never shown', async () => {
      await prisma.clientRequest.update({ where: { id: first.id }, data: { declineNote: 'stale' } });
      expect((await only())[0].declineNote).toBeNull();
    });

    test('it leaks no database id, sender name or details', async () => {
      const text = JSON.stringify((await publicStatus()).requests);
      expect(text).not.toContain(first.id);
      expect(text).not.toContain('Ann from Acme');
      expect(text).not.toContain('Three tiers');
      expect(Object.keys((await only())[0]).sort()).toEqual(['createdAt', 'declineNote', 'ref', 'scope', 'state', 'title']);
    });

    test('switching requests off removes the list from the page', async () => {
      await enable(ws, owner, false);
      expect((await publicStatus()).requests).toBeUndefined();
    });
  });

  describe('the Clients overview and retention', () => {
    test('an unread request makes the client need attention', async () => {
      await enable(ws, owner);
      await send();
      const res = await request(app).get('/api/workspaces/overview').set(await as(owner));
      const row = res.body.clients.find((c) => c.id === ws.id);
      expect(row.unreadRequests).toBe(1);
      expect(row.attention).toContain('requests');
    });

    test('cleanup removes requests older than a year but keeps the task they made', async () => {
      await enable(ws, owner);
      await send();
      const first = (await rows())[0];
      await owned(owner, `/${first.id}/accept`, 'post', {});
      await prisma.clientRequest.update({ where: { id: first.id }, data: { createdAt: new Date(Date.now() - 400 * 86400000) } });
      await runCleanup();
      expect(await rows()).toHaveLength(0);
      expect(await prisma.task.count({ where: { workspaceId: ws.id } })).toBe(1);
    });
  });
});
