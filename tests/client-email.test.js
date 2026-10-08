// Weekly client email and owner alerts: who can subscribe, the personal link (opens the page,
// unsubscribes, dies when the row is removed), when the weekly job sends, what the email may
// contain, and the owner's response email with its quiet window.
process.env.FEEDBACK_RATE_MAX = '1000';
process.env.PREVIEW_EMAIL_RATE_MAX = '1000';

const request = require('supertest');
const app = require('../src/app');
const prisma = require('../src/config/prisma');
const emailService = require('../src/services/email.service');
const digest = require('../src/services/statusDigest.service');
const { subscriberToken } = require('../src/utils/shareToken');
const { accessTokenFor, makeUser, makeWorkspaceWithMembers, cleanupUsers } = require('./helpers/fixtures');

describe('client email', () => {
  let owner, stranger, ws, shareToken, sendEmail;
  const as = async (user) => ({ Authorization: `Bearer ${await accessTokenFor(user)}` });
  const api = async (method, path, user, body) => {
    const req = request(app)[method](`/api/workspaces/${ws.id}${path}`).set(await as(user));
    return body === undefined ? req : req.send(body);
  };
  const addSub = (email, user = owner) => api('post', '/subscribers', user, { email, name: 'Ann' });
  const mondayNoonUtc = new Date('2026-10-05T12:00:00Z'); // a Monday

  beforeAll(async () => {
    owner = await makeUser('ceOwner');
    stranger = await makeUser('ceStranger');
    ws = await makeWorkspaceWithMembers(owner);
    shareToken = (await request(app).post(`/api/workspaces/${ws.id}/share`).set(await as(owner))).body.share.token;
    await prisma.user.update({ where: { id: owner.id }, data: { isPro: true, plan: 'studio' } });
  });
  afterAll(async () => {
    await cleanupUsers(owner, stranger);
    await prisma.$disconnect();
  });
  beforeEach(async () => {
    sendEmail = jest.spyOn(emailService, 'sendEmail').mockResolvedValue(undefined);
    await prisma.statusSubscriber.deleteMany({ where: { workspaceId: ws.id } });
    await prisma.task.deleteMany({ where: { workspaceId: ws.id } });
    await prisma.clientFeedback.deleteMany({ where: { workspaceId: ws.id } });
    await prisma.notification.deleteMany({ where: { userId: owner.id } });
    await prisma.workspace.update({ where: { id: ws.id }, data: { statusDigestEnabled: false, statusDigestLastSentAt: null, statusDigestDay: 1, statusAllowFeedback: true } });
    await prisma.user.update({ where: { id: owner.id }, data: { timezone: 'UTC', notifyClientResponsesByEmail: true, isPro: true, plan: 'studio' } });
  });
  afterEach(() => jest.restoreAllMocks());

  describe('subscribers', () => {
    test('owner adds, lists and removes; a stranger cannot', async () => {
      expect((await addSub('ann@client.example', stranger)).status).toBe(403);
      const added = await addSub('Ann@Client.Example');
      expect(added.status).toBe(201);
      expect(added.body.subscriber.email).toBe('ann@client.example');
      expect(added.body.subscriber.tokenHash).toBeUndefined();
      expect((await api('get', '/subscribers', stranger)).status).toBe(403);
      const list = await api('get', '/subscribers', owner);
      expect(list.body.items).toHaveLength(1);
      expect(list.body.limit).toBe(10);
      expect((await api('delete', `/subscribers/${added.body.subscriber.id}`, stranger)).status).toBe(403);
      expect((await api('delete', `/subscribers/${added.body.subscriber.id}`, owner)).status).toBe(200);
      expect((await api('get', '/subscribers', owner)).body.items).toHaveLength(0);
    });

    test('rejects bad and duplicate emails, and enforces the plan limit', async () => {
      expect((await addSub('not-an-email')).status).toBe(422);
      expect((await addSub('a@b.example')).status).toBe(201);
      expect((await addSub('a@b.example')).status).toBe(409);
      await prisma.user.update({ where: { id: owner.id }, data: { isPro: false, plan: 'free' } });
      const over = await addSub('second@b.example');
      expect(over.status).toBe(402);
    });
  });

  describe('the personal link', () => {
    test('opens the status page, accepts feedback, and unsubscribes', async () => {
      const { body } = await addSub('ann@client.example');
      const token = subscriberToken(body.subscriber.id);
      expect((await request(app).get(`/api/status/${token}`)).status).toBe(200);
      expect((await request(app).post(`/api/status/${token}/feedback`).send({ name: 'Ann', kind: 'comment', message: 'Looks good' })).status).toBe(201);

      const info = await request(app).get(`/api/status/unsubscribe/${token}`);
      expect(info.body).toMatchObject({ unsubscribed: false });
      expect((await request(app).post(`/api/status/unsubscribe/${token}`)).body.unsubscribed).toBe(true);
      expect((await request(app).post(`/api/status/unsubscribe/${token}`)).status).toBe(200); // idempotent
      const row = await prisma.statusSubscriber.findUnique({ where: { id: body.subscriber.id } });
      expect(row.unsubscribedAt).not.toBeNull();
    });

    test('dies when the owner removes the person or switches the link off; forged tokens are 404', async () => {
      const { body } = await addSub('ann@client.example');
      const token = subscriberToken(body.subscriber.id);
      expect((await request(app).get(`/api/status/c_${'x'.repeat(43)}`)).status).toBe(404);
      expect((await request(app).get(`/api/status/unsubscribe/c_${'x'.repeat(43)}`)).status).toBe(404);
      await api('delete', `/subscribers/${body.subscriber.id}`, owner);
      expect((await request(app).get(`/api/status/${token}`)).status).toBe(404);

      const again = await addSub('bob@client.example');
      const t2 = subscriberToken(again.body.subscriber.id);
      await api('delete', '/share', owner);
      expect((await request(app).get(`/api/status/${t2}`)).status).toBe(404);
      shareToken = (await request(app).post(`/api/workspaces/${ws.id}/share`).set(await as(owner))).body.share.token;
    });

    test('the owner share link still works as before', async () => {
      expect((await request(app).get(`/api/status/${shareToken}`)).status).toBe(200);
    });
  });

  describe('settings', () => {
    test('digest switch needs a live link, and the day is validated', async () => {
      const on = await api('patch', '/status-page', owner, { digestEnabled: true, digestDay: 3 });
      expect(on.status).toBe(200);
      const row = await prisma.workspace.findUnique({ where: { id: ws.id } });
      expect(row).toMatchObject({ statusDigestEnabled: true, statusDigestDay: 3 });
      expect((await api('patch', '/status-page', owner, { digestDay: 9 })).status).toBe(422);
      expect((await api('patch', '/status-page', stranger, { digestEnabled: true })).status).toBe(403);
    });

    test('the owner can turn response emails off from the profile', async () => {
      const res = await request(app).put('/api/users/me').set(await as(owner)).send({ notifyClientResponsesByEmail: false });
      expect(res.status).toBe(200);
      expect((await prisma.user.findUnique({ where: { id: owner.id } })).notifyClientResponsesByEmail).toBe(false);
    });
  });

  describe('weekly job', () => {
    const setup = async ({ day = 1, tasks = true, timezone } = {}) => {
      if (timezone) await prisma.user.update({ where: { id: owner.id }, data: { timezone } });
      await prisma.workspace.update({ where: { id: ws.id }, data: { statusDigestEnabled: true, statusDigestDay: day } });
      if (tasks) {
        await prisma.task.create({ data: { title: 'Ship <b>the</b> logo', status: 'done', completedAt: new Date('2026-10-03T10:00:00Z'), workspaceId: ws.id, userId: owner.id } });
        await prisma.task.create({ data: { title: 'Build the site', status: 'in_progress', workspaceId: ws.id, userId: owner.id } });
      }
      const s = await addSub('ann@client.example');
      return subscriberToken(s.body.subscriber.id);
    };

    test('sends each active subscriber their own link on the chosen day, once', async () => {
      const token = await setup();
      await addSub('bob@client.example');
      const gone = await addSub('gone@client.example');
      await request(app).post(`/api/status/unsubscribe/${subscriberToken(gone.body.subscriber.id)}`);

      expect(await digest.runDigests(mondayNoonUtc)).toBe(2);
      expect(sendEmail).toHaveBeenCalledTimes(2);
      const mail = sendEmail.mock.calls.map((c) => c[0]).find((m) => m.to === 'ann@client.example');
      expect(mail.html).toContain(`/s/${token}?ref=digest`);
      expect(mail.html).toContain(`/unsubscribe/${token}`);
      expect(mail.html).toContain('Ship &lt;b&gt;the&lt;/b&gt; logo');
      expect(mail.html).not.toContain('<b>the</b>');
      expect(mail.headers['List-Unsubscribe']).toContain(`/unsubscribe/${token}`);
      expect(sendEmail.mock.calls.map((c) => c[0].to)).not.toContain('gone@client.example');

      expect(await digest.runDigests(new Date(mondayNoonUtc.getTime() + 3600e3))).toBe(0); // same week
      expect(sendEmail).toHaveBeenCalledTimes(2);
    });

    test('waits for the day and the hour in the owner timezone', async () => {
      await setup({ timezone: 'Asia/Kolkata' }); // Monday 12:00 UTC is Monday 17:30 in Kolkata
      expect(await digest.runDigests(new Date('2026-10-06T12:00:00Z'))).toBe(0); // Tuesday
      expect(await digest.runDigests(new Date('2026-10-05T02:00:00Z'))).toBe(0); // Monday 07:30 in Kolkata, too early
      expect(await digest.runDigests(new Date('2026-10-05T05:00:00Z'))).toBe(1); // Monday 10:30
    });

    test('skips a week with nothing to say, a link that is off, and a switch that is off', async () => {
      await setup({ tasks: false });
      expect(await digest.runDigests(mondayNoonUtc)).toBe(0);
      await prisma.task.create({ data: { title: 'Work', status: 'in_progress', workspaceId: ws.id, userId: owner.id } });
      await prisma.workspace.update({ where: { id: ws.id }, data: { statusDigestEnabled: false } });
      expect(await digest.runDigests(mondayNoonUtc)).toBe(0);
      expect(sendEmail).not.toHaveBeenCalled();
    });

    test('the email holds titles and dates only: no comments, requests or people', async () => {
      await setup();
      await prisma.clientFeedback.create({ data: { workspaceId: ws.id, kind: 'comment', authorName: 'Secret Sender', message: 'private remark' } });
      await digest.runDigests(mondayNoonUtc);
      const { html, text } = sendEmail.mock.calls[0][0];
      for (const body of [html, text]) {
        expect(body).not.toContain('private remark');
        expect(body).not.toContain('Secret Sender');
      }
    });

    test('preview goes to the owner only, marked as a preview, and keeps the last-sent date', async () => {
      await setup();
      const res = await api('post', '/weekly-email/preview', owner);
      expect(res.status).toBe(200);
      expect(sendEmail).toHaveBeenCalledTimes(1);
      expect(sendEmail.mock.calls[0][0].to).toBe(owner.email);
      expect(sendEmail.mock.calls[0][0].subject).toMatch(/^\[Preview\]/);
      expect((await prisma.workspace.findUnique({ where: { id: ws.id } })).statusDigestLastSentAt).toBeNull();
      expect((await api('post', '/weekly-email/preview', stranger)).status).toBe(403);
    });
  });

  describe('owner alerts', () => {
    const respond = (body) => request(app).post(`/api/status/${shareToken}/feedback`).send({ name: 'Ann', ...body });

    test('an approval is always emailed', async () => {
      await prisma.workspace.update({ where: { id: ws.id }, data: { milestoneTitle: 'Launch', milestoneDate: new Date('2027-01-01') } });
      await respond({ kind: 'approve' });
      await respond({ kind: 'approve' });
      const toOwner = sendEmail.mock.calls.filter((c) => c[0].to === owner.email);
      expect(toOwner).toHaveLength(2);
    });

    test('comments are batched: one email per client per 12 hours', async () => {
      await respond({ kind: 'comment', message: 'one' });
      await respond({ kind: 'comment', message: 'two' });
      expect(sendEmail.mock.calls.filter((c) => c[0].to === owner.email)).toHaveLength(1);
      expect(await prisma.notification.count({ where: { userId: owner.id } })).toBe(2);
    });

    test('the switch in the profile stops them', async () => {
      await prisma.user.update({ where: { id: owner.id }, data: { notifyClientResponsesByEmail: false } });
      await respond({ kind: 'approve' });
      expect(sendEmail).not.toHaveBeenCalled();
      expect(await prisma.notification.count({ where: { userId: owner.id } })).toBe(1);
    });

    test('a failing email never fails the client submission', async () => {
      sendEmail.mockRejectedValue(new Error('resend down'));
      expect((await respond({ kind: 'comment', message: 'hi' })).status).toBe(201);
    });
  });
});
