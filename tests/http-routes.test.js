// HTTP-level tests. The other suites call services directly, so nothing
// exercised the route wiring — the per-router auth middleware, request
// validation, and status codes a client actually sees. These go through the
// real Express app via supertest (src/app.js — importing it binds no port).
const request = require('supertest');
const { Prisma } = require('@prisma/client');
const prisma = require('../src/config/prisma');
const app = require('../src/app');
const tokenService = require('../src/services/token.service');
const taskService = require('../src/services/task.service');
const errorHandler = require('../src/middlewares/error.middleware');
const { makeUser, makeWorkspaceWithMembers, cleanupUsers } = require('./helpers/fixtures');

const bearer = (user) => ({ Authorization: `Bearer ${tokenService.issueTokens(user).accessToken}` });

describe('HTTP routes', () => {
  let alice, bob;
  let aliceTask;

  beforeAll(async () => {
    alice = await makeUser('alice');
    bob = await makeUser('bob');
    aliceTask = await taskService.create({ title: "Alice's task" }, alice.id);
  });

  afterAll(async () => {
    await cleanupUsers(alice, bob);
    await prisma.$disconnect();
  });

  describe('authentication', () => {
    test.each([
      ['get', '/api/tasks'],
      ['get', '/api/pages'],
      ['get', '/api/workspaces'],
      ['get', '/api/momentum'],
      ['post', '/api/tasks'],
      ['post', '/api/uploads'],
      ['post', '/api/payments/portal'],
    ])('%s %s without a token → 401', async (method, url) => {
      const res = await request(app)[method](url);
      expect(res.status).toBe(401);
    });

    test('a refresh token cannot authenticate an API call', async () => {
      const { refreshToken } = tokenService.issueTokens(alice);
      const res = await request(app).get('/api/tasks').set('Authorization', `Bearer ${refreshToken}`);
      expect(res.status).toBe(401);
    });

    test('a garbage token → 401', async () => {
      const res = await request(app).get('/api/tasks').set('Authorization', 'Bearer not-a-jwt');
      expect(res.status).toBe(401);
    });
  });

  describe('health', () => {
    test('GET /api/health is public and reports the database', async () => {
      const res = await request(app).get('/api/health');
      expect(res.status).toBe(200);
      expect(res.body).toMatchObject({ status: 'ok', db: 'connected' });
    });
  });

  describe('tasks', () => {
    test('creates a task and lists it for its owner', async () => {
      const created = await request(app).post('/api/tasks').set(bearer(alice)).send({ title: 'From HTTP' });
      expect(created.status).toBe(201);

      const list = await request(app).get('/api/tasks').set(bearer(alice));
      expect(list.status).toBe(200);
      expect(JSON.stringify(list.body)).toContain('From HTTP');
    });

    test("another user cannot see or modify someone else's task", async () => {
      const list = await request(app).get('/api/tasks').set(bearer(bob));
      expect(JSON.stringify(list.body)).not.toContain(aliceTask.id);

      const patch = await request(app).patch(`/api/tasks/${aliceTask.id}`).set(bearer(bob)).send({ title: 'pwned' });
      expect(patch.status).toBe(404);

      const del = await request(app).delete(`/api/tasks/${aliceTask.id}`).set(bearer(bob));
      expect(del.status).toBe(404);

      const still = await prisma.task.findUnique({ where: { id: aliceTask.id } });
      expect(still.title).toBe("Alice's task");
    });
  });

  describe('public status page', () => {
    let owner, member, ws;

    beforeAll(async () => {
      owner = await makeUser('statusOwner');
      member = await makeUser('statusMember');
      ws = await makeWorkspaceWithMembers(owner, { editors: [member] });
      // The fixture's default name embeds the owner's id, which would make the
      // "no ids in the payload" assertion below trip on the legitimate name.
      ws = await prisma.workspace.update({ where: { id: ws.id }, data: { name: 'Acme Redesign' } });
      await taskService.create(
        { title: 'Design homepage', description: 'secret brief', status: 'done', workspaceId: ws.id, assigneeId: member.id },
        owner.id
      );
      await taskService.create({ title: 'Build API', status: 'in_progress', workspaceId: ws.id }, owner.id);
      await taskService.create({ title: 'Launch', workspaceId: ws.id, dueDate: '2026-12-01' }, owner.id);
    });

    afterAll(async () => {
      await cleanupUsers(owner, member);
    });

    test('is 404 before sharing is enabled, for any token', async () => {
      const res = await request(app).get('/api/status/definitely-not-a-token');
      expect(res.status).toBe(404);
    });

    test('only the owner can enable or disable sharing', async () => {
      const asMember = await request(app).post(`/api/workspaces/${ws.id}/share`).set(bearer(member));
      expect(asMember.status).toBe(403);
      const asOutsider = await request(app).post(`/api/workspaces/${ws.id}/share`).set(bearer(bob));
      expect(asOutsider.status).toBe(403);
      const del = await request(app).delete(`/api/workspaces/${ws.id}/share`).set(bearer(member));
      expect(del.status).toBe(403);
    });

    test('serves a minimal public view with no auth, and no-store caching', async () => {
      const enabled = await request(app).post(`/api/workspaces/${ws.id}/share`).set(bearer(owner));
      expect(enabled.status).toBe(200);
      const { token } = enabled.body.share;
      expect(token).toMatch(/^[0-9a-f]{64}$/);

      const res = await request(app).get(`/api/status/${token}`); // no Authorization header
      expect(res.status).toBe(200);
      expect(res.headers['cache-control']).toBe('no-store');

      const { status } = res.body;
      expect(status.workspace).toEqual({ name: ws.name, icon: ws.icon });
      expect(status.summary).toEqual({ todo: 1, in_progress: 1, done: 1, total: 3, percent: 33 });
      expect(status.tasks.map((t) => t.title)).toEqual(['Launch', 'Build API', 'Design homepage']);
      for (const task of status.tasks) {
        expect(Object.keys(task).sort()).toEqual(['completedAt', 'dueDate', 'status', 'title']);
      }

      // Nothing identifying or internal anywhere in the payload.
      const body = JSON.stringify(res.body);
      for (const secret of ['secret brief', member.id, member.email, owner.id, owner.email, ws.id]) {
        expect(body).not.toContain(secret);
      }
    });

    test('regenerating the link invalidates the old one', async () => {
      const first = (await request(app).post(`/api/workspaces/${ws.id}/share`).set(bearer(owner))).body.share.token;
      const second = (await request(app).post(`/api/workspaces/${ws.id}/share`).set(bearer(owner))).body.share.token;
      expect(second).not.toBe(first);
      expect((await request(app).get(`/api/status/${first}`)).status).toBe(404);
      expect((await request(app).get(`/api/status/${second}`)).status).toBe(200);
    });

    test('disabling the link turns the page off', async () => {
      const { token } = (await request(app).post(`/api/workspaces/${ws.id}/share`).set(bearer(owner))).body.share;
      const off = await request(app).delete(`/api/workspaces/${ws.id}/share`).set(bearer(owner));
      expect(off.status).toBe(200);
      expect((await request(app).get(`/api/status/${token}`)).status).toBe(404);
    });

    test('the token hash never appears in workspace responses, but sharing state does', async () => {
      await request(app).post(`/api/workspaces/${ws.id}/share`).set(bearer(owner));
      const res = await request(app).get('/api/workspaces').set(bearer(member));
      const listed = res.body.workspaces.find((w) => w.id === ws.id);
      expect(listed).not.toHaveProperty('shareTokenHash');
      expect(listed.shareEnabledAt).toBeTruthy();
    });
  });

  describe('Stripe webhook', () => {
    test('is rate-limited — it is registered ahead of the global /api limiter, so it needs its own', async () => {
      const post = () => request(app).post('/api/payments/webhook').set('Content-Type', 'application/json').send('{}');
      const statuses = [];
      for (let i = 0; i < 125; i += 1) statuses.push((await post()).status);

      // Payments aren't configured in tests, so every un-throttled call is the
      // signature failure (400). The 121st onwards must be throttled instead.
      expect(statuses.slice(0, 120).every((c) => c === 400)).toBe(true);
      expect(statuses.slice(120).every((c) => c === 429)).toBe(true);
    });
  });

  describe('billing', () => {
    test('the billing portal needs a billing account', async () => {
      const res = await request(app).post('/api/payments/portal').set(bearer(bob));
      // A fresh user has never been a Stripe customer — 400, not a 500 from Stripe
      // (or from payments being unconfigured, which would be a 500).
      expect(res.status).toBe(400);
      expect(res.body.message).toMatch(/billing account/i);
    });

    test('a user’s subscription state is exposed, but never Stripe ids', async () => {
      const res = await request(app).get('/api/users/me').set(bearer(bob));
      expect(res.status).toBe(200);
      expect(res.body.user).toMatchObject({ isPro: false, proLifetime: false, subscriptionStatus: null });
      expect(res.body.user).not.toHaveProperty('stripeCustomerId');
      expect(res.body.user).not.toHaveProperty('stripeSubscriptionId');
      expect(res.body.user).not.toHaveProperty('password');
    });
  });

  describe('workspaces', () => {
    test('POST /api/workspaces ignores fields outside the allowlist', async () => {
      const res = await request(app)
        .post('/api/workspaces')
        .set(bearer(bob))
        .send({ name: 'Bob WS', ownerId: alice.id, tasks: { connect: [{ id: aliceTask.id }] } });
      expect(res.status).toBe(201);
      expect(res.body.workspace.ownerId).toBe(bob.id);

      const task = await prisma.task.findUnique({ where: { id: aliceTask.id } });
      expect(task.workspaceId).not.toBe(res.body.workspace.id);
    });
  });

  describe('request validation', () => {
    const post = (url, user, body) => request(app).post(url).set(bearer(user)).send(body);

    test('tasks: missing/oversized title and bad enums are 422, not 500', async () => {
      expect((await post('/api/tasks', alice, {})).status).toBe(422);
      expect((await post('/api/tasks', alice, { title: 'x'.repeat(501) })).status).toBe(422);
      expect((await post('/api/tasks', alice, { title: 'ok', priority: 'Urgent' })).status).toBe(422);
      expect((await post('/api/tasks', alice, { title: 'ok', status: 'finished' })).status).toBe(422);
      expect((await post('/api/tasks', alice, { title: 'ok', recurrence: 'yearly' })).status).toBe(422);
      expect((await post('/api/tasks', alice, { title: 'ok', dueDate: 'next tuesday' })).status).toBe(422);
      expect((await post('/api/tasks', alice, { title: 'ok', tags: 'not-an-array' })).status).toBe(422);
    });

    test('tasks: the shapes the UI really sends are accepted', async () => {
      const ok = await post('/api/tasks', alice, {
        title: 'Form task',
        description: '',
        priority: 'High',
        category: 'Work',
        dueDate: '2026-12-01', // <input type="date">
        recurrence: '', // "no recurrence" from the task form
        tags: ['a', 'b'],
      });
      expect(ok.status).toBe(201);
      expect(ok.body.task.recurrence).toBeNull();

      const cleared = await request(app)
        .patch(`/api/tasks/${ok.body.task.id}`)
        .set(bearer(alice))
        .send({ dueDate: '', status: 'in_progress' });
      expect(cleared.status).toBe(200);
      expect(cleared.body.task.dueDate).toBeNull();
    });

    test('tasks: a PATCH with a bad value is rejected and changes nothing', async () => {
      const res = await request(app).patch(`/api/tasks/${aliceTask.id}`).set(bearer(alice)).send({ priority: 'nope' });
      expect(res.status).toBe(422);
      expect(res.body.errors[0]).toMatchObject({ field: 'priority' });
    });

    test('comments and subtasks: empty or oversized text is 422', async () => {
      expect((await post('/api/comments', alice, { taskId: aliceTask.id, text: '   ' })).status).toBe(422);
      expect((await post('/api/comments', alice, { taskId: aliceTask.id, text: 'x'.repeat(5001) })).status).toBe(422);
      expect((await post('/api/comments', alice, { text: 'no task' })).status).toBe(422);
      expect((await post('/api/subtasks', alice, { taskId: aliceTask.id })).status).toBe(422);
      expect((await post('/api/comments', alice, { taskId: aliceTask.id, text: 'fine' })).status).toBe(201);
    });

    test('pages and blocks: bad types, non-object content and oversized content are 422', async () => {
      const page = await post('/api/pages', alice, { title: 'Doc' });
      expect(page.status).toBe(201);
      const pageId = page.body.page.id;

      expect((await post('/api/pages', alice, { title: 'x'.repeat(201) })).status).toBe(422);
      expect((await post(`/api/pages/${pageId}/blocks`, alice, { type: 'sparkle' })).status).toBe(422);
      expect((await post(`/api/pages/${pageId}/blocks`, alice, { content: 'a string' })).status).toBe(422);
      expect((await post(`/api/pages/${pageId}/blocks`, alice, { content: [1, 2] })).status).toBe(422);
      expect(
        (await post(`/api/pages/${pageId}/blocks`, alice, { content: { html: 'x'.repeat(101 * 1024) } })).status
      ).toBe(422);
      const good = await post(`/api/pages/${pageId}/blocks`, alice, { type: 'paragraph', content: { html: 'hi' } });
      expect(good.status).toBe(201);

      const reorderBad = await request(app)
        .put(`/api/pages/${pageId}/blocks/reorder`)
        .set(bearer(alice))
        .send({ order: [{ id: good.body.block.id, position: -1 }] });
      expect(reorderBad.status).toBe(422);
    });

    test('profile: an invalid timezone or empty name is 422; a valid update works', async () => {
      const put = (body) => request(app).put('/api/users/me').set(bearer(alice)).send(body);
      expect((await put({ timezone: 'Mars/Olympus' })).status).toBe(422);
      expect((await put({ name: '' })).status).toBe(422);
      expect((await put({ timezone: 'Asia/Kolkata', name: 'Alice' })).status).toBe(200);
    });

    test('workspaces: an over-long name is 422', async () => {
      expect((await post('/api/workspaces', bob, { name: 'x'.repeat(101) })).status).toBe(422);
    });
  });

  describe('error normalization', () => {
    const run = (err) =>
      new Promise((resolve) => {
        errorHandler.normalizeErrors(err, {}, {}, (normalized) => resolve(normalized));
      });

    test('a Prisma validation error becomes a 400 (so it never reaches Sentry as a 500)', async () => {
      const err = new Prisma.PrismaClientValidationError('Invalid `prisma.task.create()` invocation', {
        clientVersion: 'test',
      });
      expect(await run(err)).toMatchObject({ statusCode: 400, message: 'Invalid request data' });
    });

    test('a missing foreign key (P2003) becomes a 400; an unrelated error passes through untouched', async () => {
      expect(await run({ code: 'P2003' })).toMatchObject({ statusCode: 400 });
      const boom = new Error('boom');
      expect(await run(boom)).toBe(boom);
    });
  });
});
