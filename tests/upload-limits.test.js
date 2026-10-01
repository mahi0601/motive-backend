// Uploads are the only endpoint that writes arbitrary bytes, so each account has
// a storage quota (free vs Pro), and the process caps how many uploads it holds
// in memory at once (multer buffers each file fully before it is stored).
const mockSaveFile = jest.fn();
jest.mock('../src/services/storage.service', () => ({
  saveFile: (...a) => mockSaveFile(...a),
  deleteFile: jest.fn().mockResolvedValue(undefined),
  isR2Enabled: false,
}));

const prisma = require('../src/config/prisma');
const fileService = require('../src/services/file.service');
const { limitConcurrentUploads } = require('../src/middlewares/uploadConcurrency.middleware');
const { makeUser, cleanupUsers } = require('./helpers/fixtures');

const MB = 1024 * 1024;
const upload = (user, bytes, name = 'a.png') =>
  fileService.upload({ originalname: name, buffer: Buffer.alloc(0), size: bytes }, undefined, user.id);

describe('storage quota', () => {
  const users = [];
  beforeEach(() => mockSaveFile.mockReset().mockImplementation(async () => ({ url: `https://cdn.test/${Math.random()}.png` })));
  afterAll(async () => {
    await cleanupUsers(...users);
    await prisma.$disconnect();
  });
  const mk = async (label, overrides) => {
    const u = await makeUser(label, overrides);
    users.push(u);
    return u;
  };

  test('records the size of each upload', async () => {
    const u = await mk('quotaSize');
    const { file } = await upload(u, 3 * MB);
    expect(file.size).toBe(3 * MB);
  });

  test('a free account is stopped at its quota with a 413, before anything is stored', async () => {
    const u = await mk('quotaFree');
    await prisma.file.create({ data: { name: 'big.png', url: 'https://cdn.test/big.png', uploadedBy: u.id, size: 99 * MB } });

    await expect(upload(u, 2 * MB)).rejects.toMatchObject({ statusCode: 413 });
    expect(mockSaveFile).not.toHaveBeenCalled();
    await expect(upload(u, 1 * MB)).resolves.toBeDefined(); // exactly at the limit is fine
  });

  test('a Pro account has a much higher quota', async () => {
    const u = await mk('quotaPro', { isPro: true });
    await prisma.file.create({ data: { name: 'big.png', url: 'https://cdn.test/big2.png', uploadedBy: u.id, size: 500 * MB } });
    await expect(upload(u, 5 * MB)).resolves.toBeDefined();
  });

  test('deleting a file frees its space', async () => {
    const u = await mk('quotaFree2');
    const { file } = await prisma.file.create({ data: { name: 'x.png', url: 'https://cdn.test/x.png', uploadedBy: u.id, size: 100 * MB } }).then((f) => ({ file: f }));
    await expect(upload(u, 1 * MB)).rejects.toMatchObject({ statusCode: 413 });
    await fileService.remove(file.id, u.id);
    await expect(upload(u, 1 * MB)).resolves.toBeDefined();
  });
});

describe('limitConcurrentUploads', () => {
  const fakeRes = () => {
    const handlers = {};
    return { on: (e, f) => (handlers[e] = f), finish: () => handlers.finish?.(), close: () => handlers.close?.() };
  };

  test('lets N through, refuses the next with 503, and frees a slot when a response finishes', () => {
    const mw = limitConcurrentUploads(2);
    const [r1, r2, r3] = [fakeRes(), fakeRes(), fakeRes()];
    const next = jest.fn();
    mw({}, r1, next);
    mw({}, r2, next);
    expect(next).toHaveBeenCalledTimes(2);
    expect(next.mock.calls.every((c) => c.length === 0)).toBe(true);

    mw({}, r3, next);
    expect(next.mock.calls[2][0]).toMatchObject({ statusCode: 503 });

    r1.finish();
    const next4 = jest.fn();
    mw({}, fakeRes(), next4);
    expect(next4).toHaveBeenCalledWith();
  });

  test('a response that is closed without finishing also frees its slot, and only once', () => {
    const mw = limitConcurrentUploads(1);
    const r1 = fakeRes();
    mw({}, r1, jest.fn());
    r1.close();
    r1.finish(); // both events fire in practice; must not double-release
    const a = jest.fn();
    const b = jest.fn();
    mw({}, fakeRes(), a);
    mw({}, fakeRes(), b);
    expect(a).toHaveBeenCalledWith();
    expect(b.mock.calls[0][0]).toMatchObject({ statusCode: 503 });
  });
});
