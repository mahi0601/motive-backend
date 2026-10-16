// A paid studio can show its own logo on the public client page. The tests pin who may set it,
// that only a real PNG or JPEG under the size cap is accepted (judged by its first bytes, never its
// name), that the public image follows the link and the plan, and that nothing leaks.
process.env.LOGO_RATE_MAX = '1000';

const request = require('supertest');
const app = require('../src/app');
const prisma = require('../src/config/prisma');
const { accessTokenFor, makeUser, makeWorkspaceWithMembers, cleanupUsers } = require('./helpers/fixtures');

const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.from('fake png body')]);
const JPG = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.from('fake jpeg body')]);

describe('status page logo', () => {
  let freeOwner, proOwner, editor, stranger, freeWs, proWs, token;
  const as = async (user) => ({ Authorization: `Bearer ${await accessTokenFor(user)}` });
  const put = async (ws, user, buf, name = 'logo.png') =>
    request(app).put(`/api/workspaces/${ws.id}/status-logo`).set(await as(user)).attach('logo', buf, name);
  const del = async (ws, user) => request(app).delete(`/api/workspaces/${ws.id}/status-logo`).set(await as(user));
  const page = () => request(app).get(`/api/status/${token}`);
  const image = (t = token) => request(app).get(`/api/status/${t}/logo`).buffer(true).parse((res, cb) => {
    const chunks = [];
    res.on('data', (c) => chunks.push(c));
    res.on('end', () => cb(null, Buffer.concat(chunks)));
  });

  beforeAll(async () => {
    freeOwner = await makeUser('lgFree');
    proOwner = await makeUser('lgPro', { isPro: true, plan: 'studio' });
    editor = await makeUser('lgEditor', { isPro: true });
    stranger = await makeUser('lgStranger', { isPro: true });
    freeWs = await makeWorkspaceWithMembers(freeOwner);
    proWs = await makeWorkspaceWithMembers(proOwner, { editors: [editor] });
    token = (await request(app).post(`/api/workspaces/${proWs.id}/share`).set(await as(proOwner))).body.share.token;
  });
  afterAll(async () => {
    delete process.env.LOGO_RATE_MAX;
    await cleanupUsers(freeOwner, proOwner, editor, stranger);
    await prisma.$disconnect();
  });

  test('without a logo the page says so and the image is not found', async () => {
    const res = await page();
    expect(res.body.status.page.hasLogo).toBe(false);
    expect(res.body.status.page.logoVersion).toBeUndefined();
    expect((await image()).status).toBe(404);
  });

  describe('who may set it', () => {
    test('an owner on the free plan is asked to upgrade (402) and nothing is stored', async () => {
      const res = await put(freeWs, freeOwner, PNG);
      expect(res.status).toBe(402);
      expect(await prisma.workspaceLogo.count({ where: { workspaceId: freeWs.id } })).toBe(0);
    });
    test('an editor and a stranger are refused (403) and no login is 401', async () => {
      expect((await put(proWs, editor, PNG)).status).toBe(403);
      expect((await put(proWs, stranger, PNG)).status).toBe(403);
      expect((await request(app).put(`/api/workspaces/${proWs.id}/status-logo`).attach('logo', PNG, 'logo.png')).status).toBe(401);
      expect((await del(proWs, editor)).status).toBe(403);
    });
  });

  describe('what is accepted', () => {
    test.each([
      ['an SVG, even named .png', Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>'), 'logo.png'],
      ['a GIF', Buffer.from('GIF89a....'), 'logo.gif'],
      ['a PDF named .jpg', Buffer.from('%PDF-1.4 ...'), 'logo.jpg'],
      ['an empty file', Buffer.alloc(0), 'logo.png'],
    ])('refuses %s (400)', async (_label, buf, name) => {
      const res = await put(proWs, proOwner, buf, name);
      expect(res.status).toBe(400);
      expect(await prisma.workspaceLogo.count({ where: { workspaceId: proWs.id } })).toBe(0);
    });
    test('refuses a file over 256 KB', async () => {
      const big = Buffer.concat([PNG, Buffer.alloc(300 * 1024)]);
      expect((await put(proWs, proOwner, big)).status).toBe(400);
      expect(await prisma.workspaceLogo.count({ where: { workspaceId: proWs.id } })).toBe(0);
    });
    test('refuses a request with no file', async () => {
      expect((await request(app).put(`/api/workspaces/${proWs.id}/status-logo`).set(await as(proOwner))).status).toBe(400);
    });
  });

  describe('showing it', () => {
    test('a PNG is saved, the owner sees it on the workspace, and the public page and image follow the link', async () => {
      const res = await put(proWs, proOwner, PNG);
      expect(res.status).toBe(200);
      const list = await request(app).get('/api/workspaces').set(await as(proOwner));
      const mine = (list.body.workspaces || list.body).find((w) => w.id === proWs.id);
      expect(mine.statusLogoUpdatedAt).toBeTruthy();

      const status = (await page()).body.status;
      expect(status.page.hasLogo).toBe(true);
      expect(typeof status.page.logoVersion).toBe('number');

      const img = await image();
      expect(img.status).toBe(200);
      expect(img.headers['content-type']).toMatch(/^image\/png/);
      expect(img.headers['x-content-type-options']).toBe('nosniff');
      expect(img.headers['cross-origin-resource-policy']).toBe('cross-origin');
      expect(img.headers['content-security-policy']).toMatch(/default-src 'none'/);
      expect(Buffer.compare(img.body, PNG)).toBe(0);
    });

    test('a different link, an unknown link and a rotated link are not found', async () => {
      expect((await image('f'.repeat(64))).status).toBe(404);
      const old = token;
      token = (await request(app).post(`/api/workspaces/${proWs.id}/share`).set(await as(proOwner))).body.share.token;
      expect((await image(old)).status).toBe(404);
      expect((await image()).status).toBe(200);
    });

    test('replacing it with a JPEG serves the new image and a new version', async () => {
      const before = (await page()).body.status.page.logoVersion;
      await new Promise((r) => setTimeout(r, 5));
      expect((await put(proWs, proOwner, JPG, 'logo.jpg')).status).toBe(200);
      const after = (await page()).body.status.page.logoVersion;
      expect(after).toBeGreaterThan(before);
      const img = await image();
      expect(img.headers['content-type']).toMatch(/^image\/jpeg/);
      expect(Buffer.compare(img.body, JPG)).toBe(0);
      expect(await prisma.workspaceLogo.count({ where: { workspaceId: proWs.id } })).toBe(1);
    });

    test('a lapsed plan hides the logo again, without deleting it', async () => {
      await prisma.user.update({ where: { id: proOwner.id }, data: { isPro: false } });
      expect((await page()).body.status.page.hasLogo).toBe(false);
      expect((await image()).status).toBe(404);
      expect(await prisma.workspaceLogo.count({ where: { workspaceId: proWs.id } })).toBe(1);
      await prisma.user.update({ where: { id: proOwner.id }, data: { isPro: true } });
      expect((await image()).status).toBe(200);
    });

    test('removing it clears the image and the flag', async () => {
      expect((await del(proWs, proOwner)).status).toBe(200);
      expect((await page()).body.status.page.hasLogo).toBe(false);
      expect((await image()).status).toBe(404);
      expect(await prisma.workspaceLogo.count({ where: { workspaceId: proWs.id } })).toBe(0);
      expect((await prisma.workspace.findUnique({ where: { id: proWs.id } })).statusLogoUpdatedAt).toBeNull();
    });
  });

  test('a copy of a client does not carry the logo', async () => {
    await put(proWs, proOwner, PNG);
    const copy = await request(app).post(`/api/workspaces/${proWs.id}/duplicate`).set(await as(proOwner)).send({ name: 'Copy' });
    expect(copy.status).toBe(201);
    const id = copy.body.workspace.id;
    expect(await prisma.workspaceLogo.count({ where: { workspaceId: id } })).toBe(0);
    expect((await prisma.workspace.findUnique({ where: { id } })).statusLogoUpdatedAt).toBeNull();
    await prisma.workspace.deleteMany({ where: { id } });
  });
});
