// Client feedback on the public status page: approve / request changes /
// comment, from someone who holds only the link. It is an UNAUTHENTICATED WRITE,
// so the tests pin everything that keeps it from becoming an abuse channel:
// opt-in per workspace, indistinguishable 404s, bounded plain text, a honeypot,
// a daily cap, owner-only reading, and that the public read still exposes
// nothing it did not before.
// The route limits each client to 10 posts per 15 minutes (tested in
// client-feedback-ratelimit.test.js). This file makes many posts from one ip, so
// it raises the limit; everything else about the route is unchanged.
process.env.FEEDBACK_RATE_MAX = '1000';

const request = require('supertest');
const app = require('../src/app');
const prisma = require('../src/config/prisma');
const feedbackService = require('../src/services/feedback.service');
const { accessTokenFor, makeUser, makeWorkspaceWithMembers, cleanupUsers } = require('./helpers/fixtures');

describe('client feedback', () => {
  let owner, editor, stranger, ws;
  let token;
  const as = async (user) => ({ Authorization: `Bearer ${await accessTokenFor(user)}` });
  const enable = async (workspace, user, allow = true) =>
    request(app).patch(`/api/workspaces/${workspace.id}/status-page`).set(await as(user)).send({ allowFeedback: allow });
  const post = (t, body) => request(app).post(`/api/status/${t}/feedback`).send(body);
  const rows = (workspaceId = ws.id) => prisma.clientFeedback.findMany({ where: { workspaceId }, orderBy: { createdAt: 'asc' } });

  beforeAll(async () => {
    owner = await makeUser('fbOwner');
    editor = await makeUser('fbEditor');
    stranger = await makeUser('fbStranger');
    ws = await makeWorkspaceWithMembers(owner, { editors: [editor] });
    token = (await request(app).post(`/api/workspaces/${ws.id}/share`).set(await as(owner))).body.share.token;
  });
  afterAll(async () => {
    await cleanupUsers(owner, editor, stranger);
    await prisma.$disconnect();
  });
  beforeEach(async () => {
    await prisma.clientFeedback.deleteMany({ where: { workspaceId: ws.id } });
    await prisma.notification.deleteMany({ where: { userId: owner.id } });
  });

  describe('it is opt-in and indistinguishable when unavailable', () => {
    test('off by default: the public page says so and posting is a 404', async () => {
      const view = await request(app).get(`/api/status/${token}`);
      expect(view.body.status.page.allowFeedback).toBe(false);
      expect((await post(token, { kind: 'comment', name: 'Ann', message: 'hi' })).status).toBe(404);
      expect(await rows()).toHaveLength(0);
    });

    test('only the owner can switch it on', async () => {
      expect((await enable(ws, editor)).status).toBe(403);
      expect((await enable(ws, owner)).status).toBe(200);
      expect((await request(app).get(`/api/status/${token}`)).body.status.page.allowFeedback).toBe(true);
    });

    test('an unknown token and a rotated token are the same 404 as "off"', async () => {
      await enable(ws, owner);
      const unknown = await post('0'.repeat(64), { kind: 'comment', name: 'Ann', message: 'hi' });
      expect(unknown.status).toBe(404);
      const rotated = (await request(app).post(`/api/workspaces/${ws.id}/share`).set(await as(owner))).body.share.token;
      const old = await post(token, { kind: 'comment', name: 'Ann', message: 'hi' });
      expect(old.status).toBe(404);
      expect(old.body).toEqual(unknown.body);
      token = rotated;
    });
  });

  describe('submitting', () => {
    beforeEach(async () => {
      await enable(ws, owner);
    });

    test('stores the feedback with the milestone it was about, and answers 201', async () => {
      await request(app).patch(`/api/workspaces/${ws.id}/status-page`).set(await as(owner)).send({ milestoneTitle: 'Design sign-off' });
      const res = await post(token, { kind: 'changes', name: 'Ann from Acme', message: 'Please make the logo bigger.' });
      expect(res.status).toBe(201);
      const [row] = await rows();
      expect(row).toMatchObject({ kind: 'changes', authorName: 'Ann from Acme', message: 'Please make the logo bigger.', milestoneTitle: 'Design sign-off', readAt: null });
    });

    test('an approval needs no message; a comment and a change request do', async () => {
      expect((await post(token, { kind: 'approve', name: 'Ann' })).status).toBe(201);
      expect((await post(token, { kind: 'comment', name: 'Ann', message: '' })).status).toBe(422);
      expect((await post(token, { kind: 'changes', name: 'Ann' })).status).toBe(422);
    });

    test.each([
      ['an unknown kind', { kind: 'delete', name: 'Ann', message: 'x' }],
      ['no name', { kind: 'comment', message: 'x' }],
      ['a name over 60 characters', { kind: 'comment', name: 'n'.repeat(61), message: 'x' }],
      ['a message over 1000 characters', { kind: 'comment', name: 'Ann', message: 'm'.repeat(1001) }],
      ['a non-string message', { kind: 'comment', name: 'Ann', message: { $ne: null } }],
    ])('rejects %s with 422 and stores nothing', async (_l, body) => {
      expect((await post(token, body)).status).toBe(422);
      expect(await rows()).toHaveLength(0);
    });

    test('a filled honeypot looks like success but stores nothing and notifies nobody', async () => {
      const res = await post(token, { kind: 'comment', name: 'Bot', message: 'buy now', website: 'http://spam.example' });
      expect(res.status).toBe(201);
      expect(await rows()).toHaveLength(0);
      expect(await prisma.notification.count({ where: { userId: owner.id } })).toBe(0);
    });

    test('markup is stored as plain text and control characters are stripped', async () => {
      await post(token, { kind: 'comment', name: 'Ann', message: '<img src=x onerror=alert(1)>\u0000\u0007line two\nline three' });
      const [row] = await rows();
      expect(row.message).toBe('<img src=x onerror=alert(1)>line two\nline three');
    });

    test('the owner gets a notification with a short preview, and a security event records it without the text', async () => {
      await post(token, { kind: 'changes', name: 'Ann', message: 'x'.repeat(500) });
      const notes = await prisma.notification.findMany({ where: { userId: owner.id } });
      expect(notes).toHaveLength(1);
      expect(notes[0]).toMatchObject({ type: 'client_feedback' });
      expect(notes[0].message.length).toBeLessThanOrEqual(160);
      const events = await prisma.securityEvent.findMany({ where: { type: 'client_feedback_received', workspaceId: ws.id } });
      expect(events.length).toBeGreaterThan(0);
      expect(JSON.stringify(events)).not.toContain('xxxxx');
    });

    test('a workspace is capped at 200 pieces of feedback a day', async () => {
      await prisma.clientFeedback.createMany({
        data: Array.from({ length: 200 }, (_, i) => ({ workspaceId: ws.id, kind: 'comment', authorName: `n${i}`, message: 'm' })),
      });
      const res = await post(token, { kind: 'comment', name: 'Ann', message: 'one too many' });
      expect(res.status).toBe(429);
    });

    test('older feedback does not count toward today\'s cap', async () => {
      await prisma.clientFeedback.createMany({
        data: Array.from({ length: 200 }, (_, i) => ({ workspaceId: ws.id, kind: 'comment', authorName: `n${i}`, message: 'm', createdAt: new Date(Date.now() - 2 * 86400000) })),
      });
      expect((await post(token, { kind: 'comment', name: 'Ann', message: 'fine' })).status).toBe(201);
    });
  });

  describe('the owner reads and manages it', () => {
    let first;
    beforeEach(async () => {
      await enable(ws, owner);
      await feedbackService.submit(token, { kind: 'comment', name: 'Ann', message: 'first' });
      await feedbackService.submit(token, { kind: 'approve', name: 'Bo', message: '' });
      first = (await rows())[0];
    });
    const list = async (user, workspace = ws) => request(app).get(`/api/workspaces/${workspace.id}/feedback`).set(await as(user));

    test('the owner lists it, newest first, with an unread count', async () => {
      const res = await list(owner);
      expect(res.status).toBe(200);
      expect(res.body.items.map((i) => i.authorName)).toEqual(['Bo', 'Ann']);
      expect(res.body.unread).toBe(2);
      expect(res.body.pagination.total).toBe(2);
    });

    test('an editor, a stranger and an anonymous caller cannot read it', async () => {
      expect((await list(editor)).status).toBe(403);
      expect((await list(stranger)).status).toBe(403);
      expect((await request(app).get(`/api/workspaces/${ws.id}/feedback`)).status).toBe(401);
    });

    test('marking one read lowers the unread count', async () => {
      const res = await request(app).patch(`/api/workspaces/${ws.id}/feedback/${first.id}/read`).set(await as(owner));
      expect(res.status).toBe(200);
      expect((await list(owner)).body.unread).toBe(1);
    });

    test('the owner can delete one; nobody else can, and ids from another workspace do nothing', async () => {
      const other = await makeWorkspaceWithMembers(stranger);
      expect((await request(app).delete(`/api/workspaces/${ws.id}/feedback/${first.id}`).set(await as(editor))).status).toBe(403);
      expect((await request(app).delete(`/api/workspaces/${other.id}/feedback/${first.id}`).set(await as(stranger))).status).toBe(404);
      expect(await rows()).toHaveLength(2);
      expect((await request(app).delete(`/api/workspaces/${ws.id}/feedback/${first.id}`).set(await as(owner))).status).toBe(200);
      expect(await rows()).toHaveLength(1);
    });
  });

  test('turning feedback off again stops new posts but keeps what was received', async () => {
    await enable(ws, owner);
    await post(token, { kind: 'comment', name: 'Ann', message: 'kept' });
    await enable(ws, owner, false);
    expect((await post(token, { kind: 'comment', name: 'Ann', message: 'rejected' })).status).toBe(404);
    expect(await rows()).toHaveLength(1);
  });

  test('the public read still exposes no ids or names, and feedback never appears in it', async () => {
    // The fixture names workspaces after their owner's id; use a real-looking name
    // so the id check below tests the payload, not the fixture.
    await prisma.workspace.update({ where: { id: ws.id }, data: { name: 'Acme Redesign' } });
    await enable(ws, owner);
    await post(token, { kind: 'comment', name: 'Ann Secret', message: 'private words' });
    const body = JSON.stringify((await request(app).get(`/api/status/${token}`)).body);
    for (const leak of ['Ann Secret', 'private words', owner.id, editor.id, ws.id]) expect(body).not.toContain(leak);
  });
});
