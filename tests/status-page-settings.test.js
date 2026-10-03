// The owner can brand the public client status page: a headline, a summary, the
// next milestone, an accent colour from a fixed preset list, and (Pro only)
// hiding the "Powered by Clientglass" footer. Everything here becomes PUBLIC, so the
// tests pin who may set it, what is accepted, that it is only ever text, and
// that the public response still exposes nothing internal.
const request = require('supertest');
const app = require('../src/app');
const prisma = require('../src/config/prisma');
const { ACCENTS } = require('../src/utils/statusAccents');
const { accessTokenFor, makeUser, makeWorkspaceWithMembers, cleanupUsers } = require('./helpers/fixtures');

describe('status page details', () => {
  let owner, proOwner, editor, ws, proWs;
  const as = async (user) => ({ Authorization: `Bearer ${await accessTokenFor(user)}` });
  const patch = async (workspace, user, body) =>
    request(app).patch(`/api/workspaces/${workspace.id}/status-page`).set(await as(user)).send(body);
  const publicView = async (workspace, user) => {
    const { body } = await request(app).post(`/api/workspaces/${workspace.id}/share`).set(await as(user));
    return request(app).get(`/api/status/${body.share.token}`);
  };

  beforeAll(async () => {
    owner = await makeUser('spOwner');
    proOwner = await makeUser('spProOwner', { isPro: true });
    editor = await makeUser('spEditor');
    ws = await makeWorkspaceWithMembers(owner, { editors: [editor] });
    proWs = await makeWorkspaceWithMembers(proOwner);
  });
  afterAll(async () => {
    await cleanupUsers(owner, proOwner, editor);
    await prisma.$disconnect();
  });

  test('only the workspace owner can change it; an editor and a stranger get nothing', async () => {
    expect((await patch(ws, editor, { headline: 'x' })).status).toBe(403);
    expect((await patch(ws, proOwner, { headline: 'x' })).status).toBe(403);
    expect((await request(app).patch(`/api/workspaces/${ws.id}/status-page`).send({ headline: 'x' })).status).toBe(401);
  });

  test('saves the details, and the public page shows them under `page`, leaving `workspace` unchanged', async () => {
    const res = await patch(ws, owner, {
      headline: 'Acme website redesign',
      summary: 'Phase 2 of 3: build and review.',
      milestoneTitle: 'Design sign-off',
      milestoneDate: '2026-12-01',
      accent: 'violet',
    });
    expect(res.status).toBe(200);

    const view = await publicView(ws, owner);
    expect(view.status).toBe(200);
    expect(view.body.status.workspace).toEqual({ name: expect.any(String), icon: expect.any(String) });
    expect(view.body.status.page).toEqual({
      headline: 'Acme website redesign',
      summary: 'Phase 2 of 3: build and review.',
      // The first milestone (`milestone`, for a frontend that predates the list) and the list.
      milestone: { id: expect.any(String), title: 'Design sign-off', date: '2026-12-01T00:00:00.000Z', approvedAt: null },
      milestones: [{ id: expect.any(String), title: 'Design sign-off', date: '2026-12-01T00:00:00.000Z', approvedAt: null }],
      accent: 'violet',
      hideBranding: false,
      allowFeedback: false,
    });
  });

  test('an empty page has sensible nulls and the default accent', async () => {
    // Its own owner: a free account runs one active client page, and `owner`
    // already has one live (see plan-limits.test.js).
    const other = await makeUser('spFresh');
    try {
      const fresh = await makeWorkspaceWithMembers(other);
      const view = await publicView(fresh, other);
      expect(view.body.status.page).toEqual({ headline: null, summary: null, milestones: [], milestone: null, accent: 'teal', hideBranding: false, allowFeedback: false });
    } finally {
      await cleanupUsers(other);
    }
  });

  test('sending an empty string clears a field', async () => {
    await patch(ws, owner, { headline: 'To clear' });
    await patch(ws, owner, { headline: '', milestoneTitle: '', milestoneDate: null });
    const view = await publicView(ws, owner);
    expect(view.body.status.page.headline).toBeNull();
    expect(view.body.status.page.milestone).toBeNull();
  });

  test.each([
    ['a headline over 120 characters', { headline: 'x'.repeat(121) }],
    ['a summary over 600 characters', { summary: 'x'.repeat(601) }],
    ['a milestone title over 100 characters', { milestoneTitle: 'x'.repeat(101) }],
    ['an unknown accent', { accent: 'hotpink' }],
    ['a free-form hex accent', { accent: '#ff0000' }],
    ['a non-date milestone date', { milestoneDate: 'next tuesday' }],
    ['a non-string headline', { headline: { $ne: null } }],
    ['a non-boolean hideBranding', { hideBranding: 'yes' }],
  ])('rejects %s with 422', async (_label, body) => {
    expect((await patch(ws, owner, body)).status).toBe(422);
  });

  test('HTML in the text is stored and served as inert text, never interpreted', async () => {
    const payload = '<img src=x onerror="alert(1)"><script>alert(1)</script>';
    const res = await patch(ws, owner, { headline: payload, summary: payload });
    expect(res.status).toBe(200);
    const view = await publicView(ws, owner);
    expect(view.headers['content-type']).toMatch(/application\/json/);
    expect(view.body.status.page.headline).toBe(payload); // returned verbatim as a JSON string; the page renders it as text
  });

  test('every accent offered is a known preset key', () => {
    expect(ACCENTS).toEqual(['teal', 'blue', 'violet', 'rose', 'amber', 'slate']);
  });

  describe('hiding "Powered by Clientglass" is a Pro feature', () => {
    test('a free owner is refused with 402 and the setting does not change', async () => {
      const res = await patch(ws, owner, { hideBranding: true });
      expect(res.status).toBe(402);
      expect((await publicView(ws, owner)).body.status.page.hideBranding).toBe(false);
    });

    test('a Pro owner can hide it, and it shows on the public page', async () => {
      expect((await patch(proWs, proOwner, { hideBranding: true })).status).toBe(200);
      expect((await publicView(proWs, proOwner)).body.status.page.hideBranding).toBe(true);
    });

    test('when Pro lapses the footer comes back by itself, without any write', async () => {
      await prisma.user.update({ where: { id: proOwner.id }, data: { isPro: false } });
      const view = await publicView(proWs, proOwner);
      expect(view.body.status.page.hideBranding).toBe(false);
      await prisma.user.update({ where: { id: proOwner.id }, data: { isPro: true } });
    });

    test('a free owner may turn it off again (false is always allowed)', async () => {
      expect((await patch(ws, owner, { hideBranding: false })).status).toBe(200);
    });
  });

  test('the public response still exposes nothing internal', async () => {
    // The fixture names workspaces after their owner's id; use a real-looking
    // name so the id check below tests the payload, not the fixture.
    await prisma.workspace.update({ where: { id: ws.id }, data: { name: 'Acme Redesign' } });
    await patch(ws, owner, { headline: 'Public headline', summary: 'Public summary' });
    const view = await publicView(ws, owner);
    const body = JSON.stringify(view.body);
    for (const secret of [owner.id, owner.email, editor.id, editor.email, ws.id, 'shareTokenHash', 'isPro', 'stripe']) {
      expect(body).not.toContain(secret);
    }
  });

  test('changing the page is recorded as a security event, without the text', async () => {
    await patch(ws, owner, { headline: 'Secret-ish headline text' });
    const rows = await prisma.securityEvent.findMany({ where: { type: 'status_page_updated', workspaceId: ws.id } });
    expect(rows.length).toBeGreaterThan(0);
    expect(JSON.stringify(rows)).not.toContain('Secret-ish headline text');
  });

  test('an unknown workspace id is a 404, not a leak', async () => {
    const res = await request(app).patch('/api/workspaces/nope/status-page').set(await as(owner)).send({ headline: 'x' });
    expect([403, 404]).toContain(res.status);
  });
});
