// A status page can carry several milestones, in order. Each one has its own
// sign-off: a client approves a specific milestone, changing that milestone's name
// or date starts a clean slate for it alone, and reordering or re-saving changes
// nothing. The old single-milestone fields on the status-page PATCH keep working
// and mean "the first milestone", so a frontend that predates this still works.
process.env.FEEDBACK_RATE_MAX = '1000'; // this file posts many times from one ip

const request = require('supertest');
const app = require('../src/app');
const prisma = require('../src/config/prisma');
const { accessTokenFor, makeUser, makeWorkspaceWithMembers, cleanupUsers } = require('./helpers/fixtures');

describe('milestones', () => {
  let owner, editor, other, ws, otherWs, token, otherToken;
  const as = async (u) => ({ Authorization: `Bearer ${await accessTokenFor(u)}` });
  const put = async (workspace, user, milestones) =>
    request(app).put(`/api/workspaces/${workspace.id}/milestones`).set(await as(user)).send({ milestones });
  const patchPage = async (workspace, user, body) =>
    request(app).patch(`/api/workspaces/${workspace.id}/status-page`).set(await as(user)).send(body);
  const pageOf = async (t = token) => (await request(app).get(`/api/status/${t}`)).body.status.page;
  const approve = (body = {}, t = token) => request(app).post(`/api/status/${t}/feedback`).send({ kind: 'approve', name: 'Ann', ...body });
  const idsOf = async () => (await pageOf()).milestones.map((m) => m.id);
  const titlesOf = async () => (await pageOf()).milestones.map((m) => m.title);

  const three = [
    { title: 'Design sign-off', date: '2026-12-01' },
    { title: 'Build complete', date: '2027-01-15' },
    { title: 'Launch', date: null },
  ];

  beforeAll(async () => {
    owner = await makeUser('msOwner', { isPro: true });
    editor = await makeUser('msEditor');
    other = await makeUser('msOther', { isPro: true });
    ws = await makeWorkspaceWithMembers(owner, { editors: [editor] });
    otherWs = await makeWorkspaceWithMembers(other);
    const share = async (w, u) => (await request(app).post(`/api/workspaces/${w.id}/share`).set(await as(u))).body.share.token;
    token = await share(ws, owner);
    otherToken = await share(otherWs, other);
    await patchPage(ws, owner, { allowFeedback: true });
    await patchPage(otherWs, other, { allowFeedback: true });
  });
  beforeEach(async () => {
    await put(ws, owner, []);
    await put(otherWs, other, []);
    await prisma.clientFeedback.deleteMany({ where: { workspaceId: { in: [ws.id, otherWs.id] } } });
  });
  afterAll(async () => {
    await cleanupUsers(owner, editor, other);
    await prisma.$disconnect();
  });

  describe('saving the list', () => {
    test('the owner saves an ordered list and the public page shows it in that order', async () => {
      const res = await put(ws, owner, three);
      expect(res.status).toBe(200);
      expect(res.body.milestones.map((m) => m.title)).toEqual(['Design sign-off', 'Build complete', 'Launch']);
      const page = await pageOf();
      expect(page.milestones.map((m) => m.title)).toEqual(['Design sign-off', 'Build complete', 'Launch']);
      expect(page.milestones[0]).toEqual({ id: expect.any(String), title: 'Design sign-off', date: '2026-12-01T00:00:00.000Z', approvedAt: null });
      expect(page.milestones[2].date).toBeNull();
    });

    test('`milestone` stays as the first one, for a frontend that predates the list', async () => {
      await put(ws, owner, three);
      const page = await pageOf();
      expect(page.milestone).toEqual(page.milestones[0]);
    });

    test('an empty list clears everything, and the page has no milestone', async () => {
      await put(ws, owner, three);
      expect((await put(ws, owner, [])).status).toBe(200);
      const page = await pageOf();
      expect(page.milestones).toEqual([]);
      expect(page.milestone).toBeNull();
    });

    test('only the owner can save: an editor, another account and a signed-out caller cannot', async () => {
      expect((await put(ws, editor, three)).status).toBe(403);
      expect((await put(ws, other, three)).status).toBe(403);
      expect((await request(app).put(`/api/workspaces/${ws.id}/milestones`).send({ milestones: three })).status).toBe(401);
      expect(await titlesOf()).toEqual([]);
    });

    test.each([
      ['milestones is missing', {}],
      ['milestones is not a list', { milestones: 'Launch' }],
      ['more than 12 milestones', { milestones: Array.from({ length: 13 }, (_, i) => ({ title: `M${i}` })) }],
      ['a title is empty', { milestones: [{ title: '   ' }] }],
      ['a title is missing', { milestones: [{ date: '2026-12-01' }] }],
      ['a title is over 100 characters', { milestones: [{ title: 'x'.repeat(101) }] }],
      ['a title is not text', { milestones: [{ title: 5 }] }],
      ['a date is not a date', { milestones: [{ title: 'A', date: 'next tuesday' }] }],
      ['an id is not text', { milestones: [{ id: 5, title: 'A' }] }],
      ['an item is not an object', { milestones: ['A'] }],
    ])('rejects it with 422 when %s, and changes nothing', async (_label, body) => {
      await put(ws, owner, [{ title: 'Keep me' }]);
      const res = await request(app).put(`/api/workspaces/${ws.id}/milestones`).set(await as(owner)).send(body);
      expect(res.status).toBe(422);
      expect(await titlesOf()).toEqual(['Keep me']);
    });

    test('exactly 12 is allowed', async () => {
      const res = await put(ws, owner, Array.from({ length: 12 }, (_, i) => ({ title: `M${i}` })));
      expect(res.status).toBe(200);
      expect((await titlesOf())).toHaveLength(12);
    });

    test('text is only ever text: HTML in a title comes back as the same characters', async () => {
      await put(ws, owner, [{ title: '<img src=x onerror=alert(1)>' }]);
      expect(await titlesOf()).toEqual(['<img src=x onerror=alert(1)>']);
    });

    test('an id from another workspace, or one that does not exist, is refused and nothing changes', async () => {
      await put(otherWs, other, [{ title: 'Theirs' }]);
      const foreign = (await pageOf(otherToken)).milestones[0].id;
      await put(ws, owner, [{ title: 'Mine' }]);
      for (const id of [foreign, 'does-not-exist']) {
        expect((await put(ws, owner, [{ id, title: 'Hijack' }])).status).toBe(422);
      }
      expect(await titlesOf()).toEqual(['Mine']);
      expect((await pageOf(otherToken)).milestones.map((m) => m.title)).toEqual(['Theirs']);
    });

    test('the same id twice in one list is refused', async () => {
      await put(ws, owner, [{ title: 'One' }]);
      const [id] = await idsOf();
      expect((await put(ws, owner, [{ id, title: 'One' }, { id, title: 'Again' }])).status).toBe(422);
    });

    test('the change is recorded in the audit trail with a count, never the titles', async () => {
      await put(ws, owner, three);
      const rows = await prisma.securityEvent.findMany({ where: { type: 'milestones_updated', workspaceId: ws.id }, orderBy: { createdAt: 'desc' }, take: 1 });
      expect(rows[0].meta).toEqual({ count: 3 });
      expect(JSON.stringify(rows[0])).not.toMatch(/Design sign-off/);
    });
  });

  describe('sign-offs are per milestone', () => {
    beforeEach(async () => {
      await put(ws, owner, three);
    });
    const approvedOf = async () => (await pageOf()).milestones.map((m) => !!m.approvedAt);

    test('approving one milestone approves only that one', async () => {
      const ids = await idsOf();
      expect((await approve({ milestoneId: ids[1] })).status).toBe(201);
      expect(await approvedOf()).toEqual([false, true, false]);
    });

    test('approving with no milestone chosen means the first one, as before there were several', async () => {
      expect((await approve()).status).toBe(201);
      expect(await approvedOf()).toEqual([true, false, false]);
    });

    test('requesting changes on an approved milestone makes it unapproved again, and leaves the others', async () => {
      const ids = await idsOf();
      await approve({ milestoneId: ids[0] });
      await approve({ milestoneId: ids[1] });
      await request(app).post(`/api/status/${token}/feedback`).send({ kind: 'changes', name: 'Ann', message: 'No', milestoneId: ids[0] });
      expect(await approvedOf()).toEqual([false, true, false]);
    });

    test('the stored feedback records which milestone, with a snapshot of its title and version', async () => {
      const ids = await idsOf();
      await approve({ milestoneId: ids[1] });
      const row = await prisma.clientFeedback.findFirst({ where: { workspaceId: ws.id } });
      expect(row).toMatchObject({ milestoneId: ids[1], milestoneTitle: 'Build complete', milestoneVersion: 0 });
    });

    test('a milestone id from ANOTHER workspace is refused and nothing is stored', async () => {
      await put(otherWs, other, [{ title: 'Theirs' }]);
      const foreign = (await pageOf(otherToken)).milestones[0].id;
      const res = await approve({ milestoneId: foreign });
      expect(res.status).toBe(422);
      expect(await prisma.clientFeedback.count({ where: { workspaceId: { in: [ws.id, otherWs.id] } } })).toBe(0);
    });

    test.each([[5], [{}], ['x'.repeat(65)], ['has space']])('a malformed milestone id (%j) is refused', async (bad) => {
      expect((await approve({ milestoneId: bad })).status).toBe(422);
    });

    test('changing one milestone\'s title or date resets only its own approval', async () => {
      const ids = await idsOf();
      await approve({ milestoneId: ids[0] });
      await approve({ milestoneId: ids[1] });
      await put(ws, owner, [
        { id: ids[0], title: 'Design sign-off', date: '2026-12-15' }, // date moved
        { id: ids[1], title: 'Build complete', date: '2027-01-15' }, // untouched
        { id: ids[2], title: 'Launch', date: null },
      ]);
      expect(await approvedOf()).toEqual([false, true, false]);
      await put(ws, owner, [
        { id: ids[0], title: 'Design sign-off', date: '2026-12-15' },
        { id: ids[1], title: 'Build finished', date: '2027-01-15' }, // renamed
        { id: ids[2], title: 'Launch', date: null },
      ]);
      expect(await approvedOf()).toEqual([false, false, false]);
    });

    test('re-saving the identical list changes nothing', async () => {
      const ids = await idsOf();
      await approve({ milestoneId: ids[2] });
      await put(ws, owner, three.map((m, i) => ({ id: ids[i], ...m })));
      expect(await approvedOf()).toEqual([false, false, true]);
      expect(await idsOf()).toEqual(ids);
    });

    test('reordering keeps every approval with its milestone', async () => {
      const ids = await idsOf();
      await approve({ milestoneId: ids[0] });
      await put(ws, owner, [
        { id: ids[2], title: 'Launch', date: null },
        { id: ids[0], title: 'Design sign-off', date: '2026-12-01' },
        { id: ids[1], title: 'Build complete', date: '2027-01-15' },
      ]);
      const page = await pageOf();
      expect(page.milestones.map((m) => m.title)).toEqual(['Launch', 'Design sign-off', 'Build complete']);
      expect(page.milestones.map((m) => !!m.approvedAt)).toEqual([false, true, false]);
    });

    test('reusing an old title on a different milestone does not revive an old approval', async () => {
      const ids = await idsOf();
      await approve({ milestoneId: ids[1] });
      await put(ws, owner, [{ id: ids[0], title: 'Design sign-off', date: '2026-12-01' }, { title: 'Build complete', date: '2027-01-15' }]);
      expect(await approvedOf()).toEqual([false, false]);
    });

    test('adding a milestone gives it a clean slate and leaves the others approved', async () => {
      const ids = await idsOf();
      await approve({ milestoneId: ids[0] });
      await put(ws, owner, [...three.map((m, i) => ({ id: ids[i], ...m })), { title: 'Handover' }]);
      expect(await approvedOf()).toEqual([true, false, false, false]);
    });

    test('removing a milestone keeps its sign-off history, with the title it had', async () => {
      const ids = await idsOf();
      await approve({ milestoneId: ids[1] });
      await put(ws, owner, [{ id: ids[0], ...three[0] }, { id: ids[2], ...three[2] }]);
      expect(await titlesOf()).toEqual(['Design sign-off', 'Launch']);
      const row = await prisma.clientFeedback.findFirst({ where: { workspaceId: ws.id } });
      expect(row.milestoneId).toBeNull();
      expect(row.milestoneTitle).toBe('Build complete');
    });

    test('approving a milestone that was just removed is refused', async () => {
      const ids = await idsOf();
      await put(ws, owner, [{ id: ids[0], ...three[0] }]);
      expect((await approve({ milestoneId: ids[1] })).status).toBe(422);
    });
  });

  describe('compatibility with the single-milestone fields', () => {
    test('milestoneTitle and milestoneDate on the status-page PATCH create and edit the first milestone', async () => {
      await patchPage(ws, owner, { milestoneTitle: 'Design sign-off', milestoneDate: '2026-12-01' });
      expect((await pageOf()).milestones).toEqual([{ id: expect.any(String), title: 'Design sign-off', date: '2026-12-01T00:00:00.000Z', approvedAt: null }]);
      await patchPage(ws, owner, { milestoneDate: '2026-12-15' });
      expect((await pageOf()).milestone.date).toBe('2026-12-15T00:00:00.000Z');
    });

    test('with several milestones, those fields touch only the first', async () => {
      await put(ws, owner, three);
      await patchPage(ws, owner, { milestoneTitle: 'Renamed first' });
      expect(await titlesOf()).toEqual(['Renamed first', 'Build complete', 'Launch']);
    });

    test('clearing the title removes the first milestone', async () => {
      await put(ws, owner, three);
      await patchPage(ws, owner, { milestoneTitle: '', milestoneDate: null });
      expect(await titlesOf()).toEqual(['Build complete', 'Launch']);
    });

    test('a date alone, with no milestone to put it on, does nothing', async () => {
      await patchPage(ws, owner, { milestoneDate: '2026-12-15' });
      expect(await titlesOf()).toEqual([]);
    });

    test('the status-page PATCH answer still carries milestoneTitle and milestoneDate', async () => {
      const res = await patchPage(ws, owner, { milestoneTitle: 'Design sign-off', milestoneDate: '2026-12-01' });
      expect(res.body.page).toMatchObject({ milestoneTitle: 'Design sign-off' });
      expect(String(res.body.page.milestoneDate)).toMatch(/^2026-12-01/);
    });
  });

  describe('what the owner and the public can see', () => {
    test('the workspace list carries the ordered milestones, plus milestoneTitle and milestoneDate for an older frontend', async () => {
      await put(ws, owner, three);
      const res = await request(app).get('/api/workspaces').set(await as(owner));
      const mine = res.body.workspaces.find((w) => w.id === ws.id);
      expect(mine.milestones.map((m) => m.title)).toEqual(['Design sign-off', 'Build complete', 'Launch']);
      expect(mine.milestones[0]).toMatchObject({ id: expect.any(String), title: 'Design sign-off' });
      expect(mine.milestoneTitle).toBe('Design sign-off');
      expect(String(mine.milestoneDate)).toMatch(/^2026-12-01/);
    });

    test('a workspace with no milestones reports none, not a leftover', async () => {
      const res = await request(app).get('/api/workspaces').set(await as(owner));
      const mine = res.body.workspaces.find((w) => w.id === ws.id);
      expect(mine.milestones).toEqual([]);
      expect(mine.milestoneTitle).toBeNull();
    });

    test('the public page exposes exactly id, title, date and approvedAt for a milestone, and nothing internal', async () => {
      // The fixture's workspace name contains the owner id; give it a neutral one so the
      // leak check below tests the response, not the fixture.
      await prisma.workspace.update({ where: { id: ws.id }, data: { name: 'Acme Redesign' } });
      await put(ws, owner, three);
      await approve({ name: 'Ann Secret' });
      const res = await request(app).get(`/api/status/${token}`);
      for (const m of res.body.status.page.milestones) expect(Object.keys(m).sort()).toEqual(['approvedAt', 'date', 'id', 'title']);
      const text = JSON.stringify(res.body);
      for (const secret of [owner.id, owner.email, editor.id, ws.id, 'shareTokenHash', 'Ann Secret', 'milestoneVersion', 'workspaceId']) {
        expect(text).not.toContain(secret);
      }
    });

    test('the data export includes the milestones of workspaces the person owns', async () => {
      const exporter = await makeUser('msExporter', { isPro: true });
      try {
        const w = await makeWorkspaceWithMembers(exporter);
        await put(w, exporter, [{ title: 'Exported milestone', date: '2026-12-01' }]);
        const data = await require('../src/services/user.service').exportData(exporter.id);
        const mine = data.workspaces.find((x) => x.id === w.id);
        expect(mine.milestones.map((m) => m.title)).toEqual(['Exported milestone']);
      } finally {
        await cleanupUsers(exporter);
      }
    });
  });
});
