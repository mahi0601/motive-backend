// Deleting an account must not leave behind (a) a Stripe subscription that keeps
// billing a user whose account no longer exists, or (b) their uploaded files in
// the bucket. The database cascade removes rows only; both of these are
// external side effects that have to be done explicitly, in a safe order:
// cancel billing first (and refuse to delete if that fails), delete the rows,
// then remove the objects (best effort, since the rows are already gone).
const mockCancel = jest.fn();
const mockDeleteFile = jest.fn();
jest.mock('../src/services/payment.service', () => ({ cancelSubscriptionForUser: (...a) => mockCancel(...a) }));
jest.mock('../src/services/storage.service', () => ({
  deleteFile: (...a) => mockDeleteFile(...a),
  saveFile: jest.fn(),
  isR2Enabled: false,
}));

const prisma = require('../src/config/prisma');
const userService = require('../src/services/user.service');
const taskService = require('../src/services/task.service');
const AppError = require('../src/utils/AppError');
const { hashPassword } = require('../src/utils/password.util');
const { makeUser, makeWorkspaceWithMembers, cleanupUsers } = require('./helpers/fixtures');

const PASSWORD = 'correct horse battery staple 1';

describe('deleteAccount — external side effects', () => {
  beforeEach(() => {
    mockCancel.mockReset().mockResolvedValue(undefined);
    mockDeleteFile.mockReset().mockResolvedValue(undefined);
  });

  test('cancels the Stripe subscription, then removes the account and its uploaded files', async () => {
    const user = await makeUser('delFiles', { password: await hashPassword(PASSWORD) });
    const ws = await makeWorkspaceWithMembers(user);
    const task = await taskService.create({ title: 't', workspaceId: ws.id }, user.id);
    await prisma.file.createMany({
      data: [
        { name: 'a.png', url: 'https://cdn.test/a.png', uploadedBy: user.id, taskId: task.id },
        { name: 'b.pdf', url: 'https://cdn.test/b.pdf', uploadedBy: user.id },
      ],
    });

    await expect(userService.deleteAccount(user.id, PASSWORD)).resolves.toEqual({ deleted: true });

    expect(mockCancel).toHaveBeenCalledWith(user.id);
    expect(await prisma.user.findUnique({ where: { id: user.id } })).toBeNull();
    expect(mockDeleteFile.mock.calls.map((c) => c[0]).sort()).toEqual(['https://cdn.test/a.png', 'https://cdn.test/b.pdf']);
  });

  test('fails closed: if the subscription cannot be cancelled, nothing is deleted', async () => {
    const user = await makeUser('delStripeFail', { password: await hashPassword(PASSWORD) });
    mockCancel.mockRejectedValue(AppError.badRequest('Could not cancel your subscription'));

    await expect(userService.deleteAccount(user.id, PASSWORD)).rejects.toThrow(/cancel/i);

    expect(await prisma.user.findUnique({ where: { id: user.id } })).toBeTruthy();
    expect(mockDeleteFile).not.toHaveBeenCalled();
    await cleanupUsers(user);
  });

  test('a storage failure after the rows are gone does not fail the deletion', async () => {
    const user = await makeUser('delStorageFail', { password: await hashPassword(PASSWORD) });
    await prisma.file.create({ data: { name: 'c.png', url: 'https://cdn.test/c.png', uploadedBy: user.id } });
    mockDeleteFile.mockRejectedValue(new Error('bucket unreachable'));

    await expect(userService.deleteAccount(user.id, PASSWORD)).resolves.toEqual({ deleted: true });
    expect(await prisma.user.findUnique({ where: { id: user.id } })).toBeNull();
  });

  test('a refused deletion (owner of a shared workspace) never touches billing or files', async () => {
    const owner = await makeUser('delRefused', { password: await hashPassword(PASSWORD) });
    const mate = await makeUser('delRefusedMate');
    await makeWorkspaceWithMembers(owner, { editors: [mate] });

    await expect(userService.deleteAccount(owner.id, PASSWORD)).rejects.toThrow(/other members/i);
    expect(mockCancel).not.toHaveBeenCalled();
    await cleanupUsers(owner, mate);
  });
});

describe('task deletion removes its attachments from storage', () => {
  test('files attached to a deleted task are deleted from the bucket', async () => {
    mockDeleteFile.mockReset().mockResolvedValue(undefined);
    const user = await makeUser('delTaskFiles');
    const ws = await makeWorkspaceWithMembers(user);
    const task = await taskService.create({ title: 't', workspaceId: ws.id }, user.id);
    await prisma.file.create({ data: { name: 'd.png', url: 'https://cdn.test/d.png', uploadedBy: user.id, taskId: task.id } });

    await taskService.remove(task.id, user.id);
    expect(mockDeleteFile).toHaveBeenCalledWith('https://cdn.test/d.png');
    await cleanupUsers(user);
  });
});
