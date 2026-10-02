// @mentions: the parser must be linear-time (CodeQL flagged the old regex as
// polynomial-ReDoS on user text), and a mention may only notify someone who is a
// member of THE TASK'S workspace, not anyone who shares some other workspace with
// the commenter. List endpoints that used to be unbounded now have a ceiling.
const prisma = require('../src/config/prisma');
const commentService = require('../src/services/comment.service');
const taskService = require('../src/services/task.service');
const templateService = require('../src/services/template.service');
const { makeUser, makeWorkspaceWithMembers, cleanupUsers } = require('./helpers/fixtures');

describe('mention parsing', () => {
  const { extractMentionedUserIds } = commentService._internals;

  test('extracts distinct ids from @[Name](id) mentions', () => {
    expect(extractMentionedUserIds('hi @[Ann Lee](cmu1abc) and @[Bo](cmu2def), again @[Ann Lee](cmu1abc)')).toEqual(['cmu1abc', 'cmu2def']);
  });

  test('ignores malformed or oversized mentions', () => {
    expect(extractMentionedUserIds('@[no id]() @[x](has space) @[](id) @[ok](' + 'a'.repeat(65) + ')')).toEqual([]);
  });

  test.each([
    ['many unclosed openers', '@['.repeat(2500)],
    ['one very long unclosed name', `@[${'a'.repeat(4900)}`],
    ['a name that never ends then a paren', `@[${'a'.repeat(2000)}(${'b'.repeat(2000)}`],
    ['nested brackets', '@[@[@[@['.repeat(600)],
  ])('stays fast on hostile input: %s', (_label, text) => {
    const start = process.hrtime.bigint();
    extractMentionedUserIds(text);
    const ms = Number(process.hrtime.bigint() - start) / 1e6;
    expect(ms).toBeLessThan(25);
  });
});

describe('mentions are scoped to the task\'s workspace', () => {
  let alice, bob, carol, ws1, task;
  beforeAll(async () => {
    [alice, bob, carol] = await Promise.all([makeUser('mnAlice'), makeUser('mnBob'), makeUser('mnCarol')]);
    ws1 = await makeWorkspaceWithMembers(alice, { editors: [bob] }); // alice + bob
    await makeWorkspaceWithMembers(alice, { editors: [carol] }); // alice + carol, a different team
    task = await taskService.create({ title: 'Shared task', workspaceId: ws1.id }, alice.id);
  });
  afterAll(async () => {
    await cleanupUsers(alice, bob, carol);
    await prisma.$disconnect();
  });
  const notified = async (id) => prisma.notification.count({ where: { userId: id, type: 'mention' } });

  test('a member of the task\'s workspace is notified', async () => {
    await commentService.addComment(task.id, alice.id, `ping @[Bob](${bob.id})`);
    expect(await notified(bob.id)).toBe(1);
  });

  test('someone who only shares a DIFFERENT workspace with the commenter is not, and learns nothing', async () => {
    const { notifications } = await commentService.addComment(task.id, alice.id, `ping @[Carol](${carol.id})`);
    expect(await notified(carol.id)).toBe(0);
    expect(notifications).toEqual([]);
  });

  test('a mention of a made-up id does nothing and does not error', async () => {
    await expect(commentService.addComment(task.id, alice.id, 'hello @[Nobody](cmu_does_not_exist)')).resolves.toBeDefined();
  });

  test('comments come back oldest first and with a ceiling', async () => {
    const spy = jest.spyOn(prisma.comment, 'findMany');
    await commentService.getComments(task.id, alice.id);
    const args = spy.mock.calls[0][0];
    spy.mockRestore();
    expect(args.orderBy).toEqual({ createdAt: 'asc' });
    expect(args.take).toBeGreaterThan(0);
    expect(args.take).toBeLessThanOrEqual(1000);
  });
});

describe('other list queries have a ceiling', () => {
  test('custom templates are capped', async () => {
    const user = await makeUser('capTemplates');
    const spy = jest.spyOn(prisma.template, 'findMany');
    try {
      await templateService.list(user.id);
      expect(spy.mock.calls[0][0].take).toBeGreaterThan(0);
      expect(spy.mock.calls[0][0].take).toBeLessThanOrEqual(500);
    } finally {
      spy.mockRestore();
      await cleanupUsers(user);
    }
  });

  test('the daily digest queries are capped', async () => {
    const digestService = require('../src/services/digest.service');
    const user = await makeUser('capDigest');
    const spy = jest.spyOn(prisma.task, 'findMany');
    try {
      await digestService.getDailyDigest(user.id, { timezone: 'UTC' });
      expect(spy.mock.calls.length).toBeGreaterThanOrEqual(2);
      for (const [args] of spy.mock.calls) expect(args.take).toBeGreaterThan(0);
    } finally {
      spy.mockRestore();
      await cleanupUsers(user);
    }
  });
});
