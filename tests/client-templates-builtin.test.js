// Starter client templates ship with the app. Everyone sees them, nobody can change or delete
// them, they do not count against the 20-template limit, and using one builds a normal client.
process.env.CLIENT_TEMPLATE_RATE_MAX = '1000';

const request = require('supertest');
const app = require('../src/app');
const prisma = require('../src/config/prisma');
const { accessTokenFor, makeUser, cleanupUsers } = require('./helpers/fixtures');
const { listBuiltin } = require('../src/data/builtinClientTemplates');
const { cleanStructure } = require('../src/services/workspaceCopy.service');

describe('starter client templates', () => {
  let owner;
  const made = [];
  const as = async (u) => ({ Authorization: `Bearer ${await accessTokenFor(u)}` });

  beforeAll(async () => {
    owner = await makeUser('builtinOwner');
  });
  afterAll(async () => {
    await prisma.workspace.deleteMany({ where: { id: { in: made } } });
    delete process.env.CLIENT_TEMPLATE_RATE_MAX;
    await cleanupUsers(owner);
    await prisma.$disconnect();
  });

  test('every user sees the four starters first, flagged as built in, with counts', async () => {
    const res = await request(app).get('/api/client-templates').set(await as(owner));
    expect(res.status).toBe(200);
    const starters = res.body.templates.filter((t) => t.builtin);
    expect(starters.map((t) => t.id)).toEqual(['builtin:website-project', 'builtin:seo-retainer', 'builtin:social-media-month', 'builtin:video-production']);
    for (const t of starters) {
      expect(t.counts.tasks).toBeGreaterThanOrEqual(8);
      expect(t.counts.milestones).toBeGreaterThanOrEqual(2);
      expect(t.snapshot).toBeUndefined();
    }
    expect(res.body.templates.slice(0, 4).every((t) => t.builtin)).toBe(true);
  });

  test('each starter survives the same sanitising as a saved template, unchanged', () => {
    for (const t of listBuiltin()) {
      const clean = cleanStructure(t.snapshot);
      expect(clean.tasks).toHaveLength(t.snapshot.tasks.length);
      expect(clean.milestones).toEqual(t.snapshot.milestones);
      expect(clean.status.accent).toBe(t.snapshot.status.accent);
    }
  });

  test('using a starter builds a client with its tasks, milestones and wording, dated from the start day', async () => {
    const res = await request(app).post('/api/client-templates/builtin:video-production/use').set(await as(owner)).send({ name: 'Acme video', startDate: '2027-03-01' });
    expect(res.status).toBe(201);
    made.push(res.body.workspace.id);
    const ws = await prisma.workspace.findUnique({ where: { id: res.body.workspace.id }, include: { milestones: { orderBy: { position: 'asc' } } } });
    expect(ws.name).toBe('Acme video');
    expect(ws.ownerId).toBe(owner.id);
    expect(ws.statusHeadline).toBe('Your video project');
    expect(await prisma.task.count({ where: { workspaceId: ws.id, status: 'todo' } })).toBe(res.body.counts.tasks);
    expect(ws.milestones[0].date.toISOString().slice(0, 10)).toBe('2027-03-08'); // script approved, day 7
  });

  test('a starter cannot be deleted, an unknown starter is not found', async () => {
    expect((await request(app).delete('/api/client-templates/builtin:seo-retainer').set(await as(owner))).status).toBe(409);
    expect((await request(app).post('/api/client-templates/builtin:nope/use').set(await as(owner)).send({ name: 'x' })).status).toBe(404);
  });

  test('starters do not count towards the 20 saved templates', async () => {
    const before = await prisma.clientTemplate.count({ where: { ownerId: owner.id } });
    expect(before).toBe(0);
    const res = await request(app).get('/api/client-templates').set(await as(owner));
    expect(res.body.templates.length).toBe(4);
  });
});
