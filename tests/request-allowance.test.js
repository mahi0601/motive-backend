// The monthly allowance on client requests: the owner includes N in-scope requests a
// month for a client; the public page shows how many are used, how many were extra work,
// and when it resets. It is computed from the rows, so these tests pin what counts, what
// does not, the month boundary, validation, and that the owner is never blocked.
process.env.REQUEST_RATE_MAX = '1000';

const request = require('supertest');
const app = require('../src/app');
const prisma = require('../src/config/prisma');
const requestService = require('../src/services/request.service');
const { accessTokenFor, makeUser, makeWorkspaceWithMembers, cleanupUsers } = require('./helpers/fixtures');

describe('request allowance', () => {
  let owner, editor, ws, token;
  const as = async (user) => ({ Authorization: `Bearer ${await accessTokenFor(user)}` });
  const settings = async (body, user = owner) =>
    request(app).patch(`/api/workspaces/${ws.id}/status-page`).set(await as(user)).send(body);
  const publicStatus = async () => (await request(app).get(`/api/status/${token}`)).body.status;
  const make = (extra = {}) =>
    prisma.clientRequest.create({ data: { workspaceId: ws.id, title: 'Ask', authorName: 'Ann', state: 'accepted', scope: 'in_scope', decidedAt: new Date(), ...extra } });

  beforeAll(async () => {
    owner = await makeUser('alOwner');
    editor = await makeUser('alEditor');
    ws = await makeWorkspaceWithMembers(owner, { editors: [editor] });
    token = (await request(app).post(`/api/workspaces/${ws.id}/share`).set(await as(owner))).body.share.token;
  });
  afterAll(async () => {
    await cleanupUsers(owner, editor);
    await prisma.$disconnect();
  });
  beforeEach(async () => {
    await prisma.clientRequest.deleteMany({ where: { workspaceId: ws.id } });
    await prisma.task.deleteMany({ where: { workspaceId: ws.id } });
    await settings({ allowRequests: true, requestAllowance: null });
  });

  describe('the setting', () => {
    test('is off by default: no allowance on the public page', async () => {
      expect((await publicStatus()).allowance).toBeUndefined();
    });

    test('only the owner can set it, and it is saved and returned', async () => {
      expect((await settings({ requestAllowance: 5 }, editor)).status).toBe(403);
      const res = await settings({ requestAllowance: 5 });
      expect(res.status).toBe(200);
      expect((await prisma.workspace.findUnique({ where: { id: ws.id } })).statusRequestAllowance).toBe(5);
    });

    test.each([['zero', 0], ['negative', -1], ['over 100', 101], ['a fraction', 2.5], ['text', '5'], ['a boolean', true]])(
      'refuses %s with 422 and changes nothing',
      async (_l, value) => {
        await settings({ requestAllowance: 3 });
        expect((await settings({ requestAllowance: value })).status).toBe(422);
        expect((await prisma.workspace.findUnique({ where: { id: ws.id } })).statusRequestAllowance).toBe(3);
      }
    );

    test('null turns it off again', async () => {
      await settings({ requestAllowance: 4 });
      expect((await settings({ requestAllowance: null })).status).toBe(200);
      expect((await publicStatus()).allowance).toBeUndefined();
    });

    test('it is not shown while requests themselves are switched off', async () => {
      await settings({ requestAllowance: 4, allowRequests: false });
      expect((await publicStatus()).allowance).toBeUndefined();
    });
  });

  describe('what counts', () => {
    beforeEach(async () => {
      await settings({ requestAllowance: 5 });
    });

    test('starts at zero used, with a reset date at the start of next month (UTC)', async () => {
      const a = (await publicStatus()).allowance;
      const now = new Date();
      expect(a).toMatchObject({ limit: 5, used: 0, extra: 0 });
      expect(a.resetsOn).toBe(new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1)).toISOString());
    });

    test('accepted in-scope and untagged requests are used; extra work is counted apart', async () => {
      await make({ scope: 'in_scope' });
      await make({ scope: null });
      await make({ scope: 'extra' });
      expect((await publicStatus()).allowance).toMatchObject({ limit: 5, used: 2, extra: 1 });
    });

    test('received and declined requests do not count', async () => {
      await make({ state: 'received', scope: null, decidedAt: null });
      await make({ state: 'declined', scope: null });
      expect((await publicStatus()).allowance).toMatchObject({ used: 0, extra: 0 });
    });

    test('last month\'s requests do not count; the first instant of this month does', async () => {
      const now = new Date('2026-10-15T12:00:00Z');
      await make({ decidedAt: new Date('2026-09-30T23:59:59Z') });
      await make({ decidedAt: new Date('2026-10-01T00:00:00Z') });
      expect(await requestService.allowanceUsage(ws.id, 5, now)).toEqual({ limit: 5, used: 1, extra: 0, resetsOn: new Date('2026-11-01T00:00:00Z') });
    });

    test('December rolls over to January of the next year', async () => {
      const a = await requestService.allowanceUsage(ws.id, 5, new Date('2026-12-20T00:00:00Z'));
      expect(a.resetsOn).toEqual(new Date('2027-01-01T00:00:00Z'));
    });

    test('re-tagging or deleting a request corrects the count at once', async () => {
      const r = await make({ scope: 'in_scope' });
      expect((await publicStatus()).allowance.used).toBe(1);
      await request(app).patch(`/api/workspaces/${ws.id}/requests/${r.id}`).set(await as(owner)).send({ scope: 'extra' });
      expect((await publicStatus()).allowance).toMatchObject({ used: 0, extra: 1 });
      await request(app).delete(`/api/workspaces/${ws.id}/requests/${r.id}`).set(await as(owner));
      expect((await publicStatus()).allowance).toMatchObject({ used: 0, extra: 0 });
    });

    test('accepting through the API moves the numbers', async () => {
      const send = (title) => request(app).post(`/api/status/${token}/requests`).send({ name: 'Ann', title });
      await send('One');
      await send('Two');
      const [one, two] = await prisma.clientRequest.findMany({ where: { workspaceId: ws.id }, orderBy: { createdAt: 'asc' } });
      await request(app).post(`/api/workspaces/${ws.id}/requests/${one.id}/accept`).set(await as(owner)).send({ scope: 'in_scope' });
      await request(app).post(`/api/workspaces/${ws.id}/requests/${two.id}/accept`).set(await as(owner)).send({ scope: 'extra' });
      expect((await publicStatus()).allowance).toMatchObject({ used: 1, extra: 1 });
    });

    test('other workspaces\' requests are not counted', async () => {
      const other = await makeUser('alOther');
      try {
        const ows = await makeWorkspaceWithMembers(other);
        await prisma.clientRequest.create({ data: { workspaceId: ows.id, title: 'x', authorName: 'a', state: 'accepted', scope: 'in_scope', decidedAt: new Date() } });
        expect((await publicStatus()).allowance.used).toBe(0);
      } finally {
        await cleanupUsers(other);
      }
    });

    test('the owner is never blocked: accepting past the allowance still works', async () => {
      await settings({ requestAllowance: 1 });
      await make();
      const row = await prisma.clientRequest.create({ data: { workspaceId: ws.id, title: 'Over', authorName: 'Ann' } });
      const res = await request(app).post(`/api/workspaces/${ws.id}/requests/${row.id}/accept`).set(await as(owner)).send({ scope: 'in_scope' });
      expect(res.status).toBe(201);
      expect((await publicStatus()).allowance).toMatchObject({ limit: 1, used: 2 });
    });
  });

  describe('what each side sees', () => {
    test('the public allowance has only the four fields and no ids or names', async () => {
      await settings({ requestAllowance: 5 });
      await make();
      const a = (await publicStatus()).allowance;
      expect(Object.keys(a).sort()).toEqual(['extra', 'limit', 'resetsOn', 'used']);
    });

    test('the owner\'s request list carries the same numbers; with no allowance it is null', async () => {
      const list = async () => (await request(app).get(`/api/workspaces/${ws.id}/requests`).set(await as(owner))).body.allowance;
      expect(await list()).toBeNull();
      await settings({ requestAllowance: 3 });
      await make();
      expect(await list()).toMatchObject({ limit: 3, used: 1, extra: 0 });
    });
  });
});
