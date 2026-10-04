// Client activity for the owner: when someone opens the client status page the owner can be
// told (in the app), and Settings shows when it was last opened and how many visits it had
// this week. Only real viewing counts: the owner's own preview and link-preview bots do not.
// The owner can switch the notification off, and a busy page does not become a flood.
process.env.FEEDBACK_RATE_MAX = '1000';

const request = require('supertest');
const app = require('../src/app');
const prisma = require('../src/config/prisma');
const workspaceService = require('../src/services/workspace.service');
const { accessTokenFor, makeUser, makeWorkspaceWithMembers, cleanupUsers } = require('./helpers/fixtures');

const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;
const BROWSER = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

describe('client activity', () => {
  let owner, editor, viewer, stranger, ws, ws2, token, token2;
  const as = async (u) => ({ Authorization: `Bearer ${await accessTokenFor(u)}` });
  const view = (t = token, ua = BROWSER, query = '') => request(app).get(`/api/status/${t}${query}`).set('User-Agent', ua);
  const notices = (userId = owner.id) => prisma.notification.findMany({ where: { userId, type: 'client_view' }, orderBy: { createdAt: 'asc' } });
  const settle = () => wait(400); // the notice is written after the response, so give it a moment
  const events = (workspaceId) => prisma.productEvent.count({ where: { workspaceId, name: 'status_page_viewed' } });

  beforeAll(async () => {
    owner = await makeUser('actOwner', { isPro: true, plan: 'agency' });
    editor = await makeUser('actEditor');
    viewer = await makeUser('actViewer');
    stranger = await makeUser('actStranger');
    ws = await makeWorkspaceWithMembers(owner, { editors: [editor], viewers: [viewer] });
    ws2 = await makeWorkspaceWithMembers(owner);
    await prisma.workspace.update({ where: { id: ws.id }, data: { name: 'Acme Redesign' } });
    await prisma.workspace.update({ where: { id: ws2.id }, data: { name: 'Beta Co' } });
    const share = async (w) => (await request(app).post(`/api/workspaces/${w.id}/share`).set(await as(owner))).body.share.token;
    token = await share(ws);
    token2 = await share(ws2);
  });
  beforeEach(async () => {
    workspaceService._internals.resetViewNoticeGuard();
    await prisma.notification.deleteMany({ where: { userId: owner.id, type: 'client_view' } });
    await prisma.productEvent.deleteMany({ where: { workspaceId: { in: [ws.id, ws2.id] } } });
    await prisma.workspace.updateMany({ where: { id: { in: [ws.id, ws2.id] } }, data: { statusNotifyViews: true } });
  });
  afterAll(async () => {
    await cleanupUsers(owner, editor, viewer, stranger);
    await prisma.$disconnect();
  });

  describe('automated visitors are not clients', () => {
    test.each([
      ['a Slack link preview', 'Slackbot-LinkExpanding 1.0 (+https://api.slack.com/robots)'],
      ['a WhatsApp preview', 'WhatsApp/2.23.20.0'],
      ['a script', 'curl/8.4.0'],
    ])('%s still gets the page, but is not counted and tells nobody', async (_l, ua) => {
      const res = await view(token, ua);
      expect(res.status).toBe(200);
      expect(res.body.status.workspace.name).toBe('Acme Redesign');
      await settle();
      expect(await events(ws.id)).toBe(0);
      expect(await notices()).toHaveLength(0);
    });

    test('the owner\'s own preview is not counted either', async () => {
      await view(token, BROWSER, '?preview=1');
      await settle();
      expect(await events(ws.id)).toBe(0);
      expect(await notices()).toHaveLength(0);
    });

    test('a person in a browser is counted', async () => {
      await view();
      await settle();
      expect(await events(ws.id)).toBe(1);
    });
  });

  describe('telling the owner', () => {
    test('the first real view makes one notice for the owner, naming the page and nothing about the visitor', async () => {
      await view();
      await settle();
      const [n] = await notices();
      expect(n).toMatchObject({ userId: owner.id, type: 'client_view', read: false });
      expect(n.title).toContain('Acme Redesign');
      const text = JSON.stringify(n);
      for (const leaked of ['Chrome', '127.0.0.1', '::1', 'Windows']) expect(text).not.toContain(leaked);
    });

    test('more views soon after do not make more notices', async () => {
      await view();
      await settle();
      workspaceService._internals.resetViewNoticeGuard(); // in real life more than a few seconds have passed
      await view();
      await settle();
      workspaceService._internals.resetViewNoticeGuard();
      await view();
      await settle();
      expect(await notices()).toHaveLength(1); // held back by the 12-hour quiet period, not by the short guard
      expect(await events(ws.id)).toBe(3); // every view is still counted
    });

    test('two views at the same moment still make one notice', async () => {
      // Called in the same tick, before any of them has written: only the short guard stops
      // the others (separate HTTP requests do not overlap enough to show this).
      const page = { id: ws.id, ownerId: owner.id, name: 'Acme Redesign', statusNotifyViews: true };
      await Promise.all([1, 2, 3].map(() => workspaceService._internals.notifyOwnerOfView(page)));
      expect(await notices()).toHaveLength(1);
    });

    test('after the quiet period the next view tells the owner again', async () => {
      await view();
      await settle();
      await prisma.notification.updateMany({ where: { userId: owner.id, type: 'client_view' }, data: { createdAt: new Date(Date.now() - 13 * HOUR) } });
      workspaceService._internals.resetViewNoticeGuard(); // in real life seconds have passed
      await view();
      await settle();
      expect(await notices()).toHaveLength(2);
    });

    test('each client page has its own quiet period', async () => {
      await view(token);
      await view(token2);
      await settle();
      const titles = (await notices()).map((n) => n.title);
      expect(titles).toHaveLength(2);
      expect(titles.some((t) => t.includes('Acme Redesign'))).toBe(true);
      expect(titles.some((t) => t.includes('Beta Co'))).toBe(true);
    });

    test('with the notice switched off nothing is sent, but the view is still counted', async () => {
      await prisma.workspace.update({ where: { id: ws.id }, data: { statusNotifyViews: false } });
      await view();
      await settle();
      expect(await notices()).toHaveLength(0);
      expect(await events(ws.id)).toBe(1);
    });

    test('a link that does not work tells nobody and counts nothing', async () => {
      expect((await view('0'.repeat(64))).status).toBe(404);
      await settle();
      expect(await notices()).toHaveLength(0);
    });

    test('only the owner is told, not an editor or a viewer', async () => {
      await view();
      await settle();
      expect(await notices(editor.id)).toHaveLength(0);
      expect(await notices(viewer.id)).toHaveLength(0);
    });

    test('a failure writing the notice never breaks the page', async () => {
      const spy = jest.spyOn(prisma.notification, 'create').mockRejectedValueOnce(new Error('db down'));
      const res = await view();
      expect(res.status).toBe(200);
      await settle();
      spy.mockRestore();
    });
  });

  describe('GET /api/workspaces/:id/engagement', () => {
    const get = async (user, id = ws.id) => request(app).get(`/api/workspaces/${id}/engagement`).set(await as(user));
    const addViews = (workspaceId, rows) => prisma.productEvent.createMany({ data: rows.map((r) => ({ name: 'status_page_viewed', workspaceId, ...r })) });
    // A view from an earlier test is recorded after its response, so let any such write land
    // before starting from an empty page; otherwise it can arrive after the cleanup above.
    beforeEach(async () => {
      await wait(600);
      await prisma.productEvent.deleteMany({ where: { workspaceId: { in: [ws.id, ws2.id] } } });
    });

    test('a page nobody has opened has no last view and zero views and visits', async () => {
      const res = await get(owner);
      expect(res.status).toBe(200);
      expect(res.body).toMatchObject({ success: true, lastViewedAt: null, views7d: 0, visits7d: 0 });
    });

    test('counts views and distinct visitors in the last 7 days, and reports the latest view', async () => {
      const latest = new Date(Date.now() - 2 * HOUR);
      await addViews(ws.id, [
        { visitor: 'aaaaaaaaaaaaaaaa', createdAt: new Date(Date.now() - 3 * DAY) },
        { visitor: 'aaaaaaaaaaaaaaaa', createdAt: new Date(Date.now() - 3 * DAY + HOUR) }, // same visitor, same day
        { visitor: 'bbbbbbbbbbbbbbbb', createdAt: new Date(Date.now() - 1 * DAY) },
        { visitor: 'cccccccccccccccc', createdAt: latest },
        { visitor: 'dddddddddddddddd', createdAt: new Date(Date.now() - 9 * DAY) }, // too old for the week
      ]);
      const res = await get(owner);
      expect(res.body.views7d).toBe(4);
      expect(res.body.visits7d).toBe(3);
      expect(new Date(res.body.lastViewedAt).getTime()).toBe(latest.getTime());
    });

    test('with only old views, the last view is still reported but the week is empty', async () => {
      const old = new Date(Date.now() - 20 * DAY);
      await addViews(ws.id, [{ visitor: 'eeeeeeeeeeeeeeee', createdAt: old }]);
      const res = await get(owner);
      expect(res.body).toMatchObject({ views7d: 0, visits7d: 0 });
      expect(new Date(res.body.lastViewedAt).getTime()).toBe(old.getTime());
    });

    test('is scoped to this page, and ignores other kinds of event', async () => {
      await addViews(ws2.id, [{ visitor: 'ffffffffffffffff', createdAt: new Date() }]);
      await prisma.productEvent.create({ data: { name: 'feedback_received', workspaceId: ws.id } });
      expect(await get(owner)).toMatchObject({ body: { views7d: 0, lastViewedAt: null } });
    });

    test('gives only numbers and a time: no visitor hashes or ids', async () => {
      await addViews(ws.id, [{ visitor: 'abcdefabcdefabcd', createdAt: new Date() }]);
      const res = await get(owner);
      expect(Object.keys(res.body).sort()).toEqual(['lastViewedAt', 'success', 'views7d', 'visits7d']);
      expect(JSON.stringify(res.body)).not.toContain('abcdefabcdefabcd');
    });

    test.each([['an editor', () => editor], ['a viewer', () => viewer], ['someone outside', () => stranger]])('%s of the workspace is refused', async (_l, who) => {
      expect((await get(who())).status).toBe(403);
    });

    test('needs a signed-in user, and an unknown workspace is refused the same way', async () => {
      expect((await request(app).get(`/api/workspaces/${ws.id}/engagement`)).status).toBe(401);
      expect((await get(owner, 'does-not-exist')).status).toBe(403);
    });
  });

  describe('the setting', () => {
    const patch = async (body) => request(app).patch(`/api/workspaces/${ws.id}/status-page`).set(await as(owner)).send(body);

    test('is on by default, and the owner can turn it off and on', async () => {
      expect((await prisma.workspace.findUnique({ where: { id: ws.id } })).statusNotifyViews).toBe(true);
      expect((await patch({ notifyViews: false })).body.page.statusNotifyViews).toBe(false);
      expect((await prisma.workspace.findUnique({ where: { id: ws.id } })).statusNotifyViews).toBe(false);
      expect((await patch({ notifyViews: true })).body.page.statusNotifyViews).toBe(true);
    });

    test.each([['"false"', 'false'], ['1', 1], ['null', null], ['"yes"', 'yes']])('a value that is not a real boolean (%s) is refused with 422', async (_l, value) => {
      expect((await patch({ notifyViews: value })).status).toBe(422);
      expect((await prisma.workspace.findUnique({ where: { id: ws.id } })).statusNotifyViews).toBe(true);
    });

    test('only the owner can change it', async () => {
      const res = await request(app).patch(`/api/workspaces/${ws.id}/status-page`).set(await as(editor)).send({ notifyViews: false });
      expect(res.status).toBe(403);
    });

    test('the setting is not part of the public page', async () => {
      const res = await view();
      expect(JSON.stringify(res.body)).not.toMatch(/notifyViews|statusNotifyViews/);
    });
  });
});
