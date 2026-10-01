// Sign-off records. A client's approval used to be just a message. Now an
// approval of the CURRENT milestone shows on the public page as "approved on
// <date>" (never with the client's typed name: that text is unverified and the
// page is public), is cleared if the client later asks for changes or the owner
// deletes it, and stops applying the moment the milestone itself changes.
process.env.FEEDBACK_RATE_MAX = '1000'; // this file posts many times from one ip

const request = require('supertest');
const app = require('../src/app');
const prisma = require('../src/config/prisma');
const { accessTokenFor, makeUser, makeWorkspaceWithMembers, cleanupUsers } = require('./helpers/fixtures');

describe('sign-off records', () => {
  let owner, ws, token;
  const as = async () => ({ Authorization: `Bearer ${await accessTokenFor(owner)}` });
  const patch = async (body) => request(app).patch(`/api/workspaces/${ws.id}/status-page`).set(await as()).send(body);
  const post = (body) => request(app).post(`/api/status/${token}/feedback`).send(body);
  const milestone = async () => (await request(app).get(`/api/status/${token}`)).body.status.page.milestone;

  beforeAll(async () => {
    owner = await makeUser('soOwner');
    ws = await makeWorkspaceWithMembers(owner);
    token = (await request(app).post(`/api/workspaces/${ws.id}/share`).set(await as())).body.share.token;
  });
  afterAll(async () => {
    await cleanupUsers(owner);
    await prisma.$disconnect();
  });
  beforeEach(async () => {
    await prisma.clientFeedback.deleteMany({ where: { workspaceId: ws.id } });
    await patch({ allowFeedback: true, milestoneTitle: 'Design sign-off', milestoneDate: '2026-12-01' });
  });

  test('a milestone starts unapproved', async () => {
    expect(await milestone()).toMatchObject({ title: 'Design sign-off', approvedAt: null });
  });

  test('an approval marks the current milestone approved, with the date and nothing about who', async () => {
    expect((await post({ kind: 'approve', name: 'Ann Secret', message: 'Looks good' })).status).toBe(201);
    const m = await milestone();
    expect(m.approvedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    const publicBody = JSON.stringify((await request(app).get(`/api/status/${token}`)).body);
    expect(publicBody).not.toContain('Ann Secret');
    expect(publicBody).not.toContain('Looks good');
  });

  test('a later request for changes withdraws the approval; a later approval restores it', async () => {
    await post({ kind: 'approve', name: 'Ann' });
    await post({ kind: 'changes', name: 'Ann', message: 'Actually, one more thing' });
    expect((await milestone()).approvedAt).toBeNull();
    await post({ kind: 'approve', name: 'Ann' });
    expect((await milestone()).approvedAt).not.toBeNull();
  });

  test('a plain comment does not change the approval either way', async () => {
    await post({ kind: 'approve', name: 'Ann' });
    await post({ kind: 'comment', name: 'Bo', message: 'thanks all' });
    expect((await milestone()).approvedAt).not.toBeNull();
  });

  test('the approval stops applying when the milestone name or date changes', async () => {
    await post({ kind: 'approve', name: 'Ann' });
    await patch({ milestoneDate: '2026-12-15' });
    expect((await milestone()).approvedAt).toBeNull();
    await post({ kind: 'approve', name: 'Ann' });
    await patch({ milestoneTitle: 'Build complete' });
    expect((await milestone()).approvedAt).toBeNull();
  });

  test('re-saving the same milestone, or changing other fields, does not reset the approval', async () => {
    await post({ kind: 'approve', name: 'Ann' });
    await patch({ milestoneTitle: 'Design sign-off', milestoneDate: '2026-12-01' });
    await patch({ headline: 'New headline', accent: 'rose' });
    expect((await milestone()).approvedAt).not.toBeNull();
  });

  test('reusing an old milestone name later does not resurrect an old approval', async () => {
    await post({ kind: 'approve', name: 'Ann' });
    await patch({ milestoneTitle: 'Something else' });
    await patch({ milestoneTitle: 'Design sign-off' });
    expect((await milestone()).approvedAt).toBeNull();
  });

  test('the owner deleting the approval removes the approved state', async () => {
    await post({ kind: 'approve', name: 'Ann' });
    const [row] = await prisma.clientFeedback.findMany({ where: { workspaceId: ws.id } });
    expect((await request(app).delete(`/api/workspaces/${ws.id}/feedback/${row.id}`).set(await as())).status).toBe(200);
    expect((await milestone()).approvedAt).toBeNull();
  });

  test('with no milestone there is nothing to approve, and the public page has no milestone', async () => {
    await patch({ milestoneTitle: '', milestoneDate: null });
    await post({ kind: 'approve', name: 'Ann' });
    expect(await milestone()).toBeNull();
  });

  test('each approval records which milestone version it was for', async () => {
    await post({ kind: 'approve', name: 'Ann' });
    await patch({ milestoneTitle: 'Launch' });
    await post({ kind: 'approve', name: 'Bo' });
    const rows = await prisma.clientFeedback.findMany({ where: { workspaceId: ws.id }, orderBy: { createdAt: 'asc' } });
    expect(rows[0].milestoneVersion).toBeLessThan(rows[1].milestoneVersion);
    expect(rows.map((r) => r.milestoneTitle)).toEqual(['Design sign-off', 'Launch']);
  });

  describe('the owner lists only the sign-offs', () => {
    test('?kind=approve returns approvals only; an unknown kind is 422', async () => {
      await post({ kind: 'approve', name: 'Ann' });
      await post({ kind: 'comment', name: 'Bo', message: 'hello' });
      const res = await request(app).get(`/api/workspaces/${ws.id}/feedback?kind=approve`).set(await as());
      expect(res.status).toBe(200);
      expect(res.body.items.map((i) => i.kind)).toEqual(['approve']);
      expect(res.body.pagination.total).toBe(1);
      expect((await request(app).get(`/api/workspaces/${ws.id}/feedback?kind=bogus`).set(await as())).status).toBe(422);
    });

    test('items carry the milestone they were for, so the list works as a record', async () => {
      await post({ kind: 'approve', name: 'Ann' });
      const { body } = await request(app).get(`/api/workspaces/${ws.id}/feedback?kind=approve`).set(await as());
      expect(body.items[0]).toMatchObject({ authorName: 'Ann', milestoneTitle: 'Design sign-off', kind: 'approve' });
    });
  });
});
