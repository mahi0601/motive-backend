// The daily digest used the server's local midnight to decide what is
// "overdue" and "due today". Now it uses the user's own timezone, so the same
// instant lands in different buckets for users in different zones.
const prisma = require('../src/config/prisma');
const digestService = require('../src/services/digest.service');
const { makeUser, cleanupUsers } = require('./helpers/fixtures');

describe('daily digest — user timezone', () => {
  let user;

  // 2026-09-30 20:00 UTC is already 2026-10-01 01:30 in Asia/Kolkata (UTC+5:30),
  // but still the afternoon of 2026-09-30 in America/Los_Angeles (UTC-7).
  const NOW = new Date('2026-09-30T20:00:00Z');

  beforeAll(async () => {
    user = await makeUser('digest');
    const mk = (title, dueDate) => prisma.task.create({ data: { title, dueDate: new Date(dueDate), userId: user.id } });
    await mk('Early Sep 30 (UTC)', '2026-09-30T03:00:00Z'); // Sep 30 08:30 IST · Sep 29 20:00 LA
    await mk('Midday Oct 1 (UTC)', '2026-10-01T10:00:00Z'); // Oct 1 15:30 IST · Oct 1 03:00 LA
  });

  afterAll(async () => {
    await cleanupUsers(user);
    await prisma.$disconnect();
  });

  const titles = (list) => list.map((t) => t.title);

  test('in Asia/Kolkata (already Oct 1) the Sep 30 task is overdue and the Oct 1 task is due today', async () => {
    const d = await digestService.getDailyDigest(user.id, { timezone: 'Asia/Kolkata', now: NOW });
    expect(titles(d.overdue)).toEqual(['Early Sep 30 (UTC)']);
    expect(titles(d.dueToday)).toEqual(['Midday Oct 1 (UTC)']);
    expect(d.headline).toBe('You have 1 overdue and 1 due today.');
  });

  test('in America/Los_Angeles (still Sep 30) the first task was due yesterday and the second is tomorrow', async () => {
    const d = await digestService.getDailyDigest(user.id, { timezone: 'America/Los_Angeles', now: NOW });
    expect(titles(d.overdue)).toEqual(['Early Sep 30 (UTC)']);
    expect(d.dueToday).toEqual([]);
    expect(d.headline).toBe('You have 1 overdue.');
  });

  test('in UTC the Sep 30 task is due today and the Oct 1 task is tomorrow', async () => {
    const d = await digestService.getDailyDigest(user.id, { timezone: 'UTC', now: NOW });
    expect(d.overdue).toEqual([]);
    expect(titles(d.dueToday)).toEqual(['Early Sep 30 (UTC)']);
  });

  test('defaults to UTC when no timezone is given', async () => {
    const d = await digestService.getDailyDigest(user.id, { now: NOW });
    expect(titles(d.dueToday)).toEqual(['Early Sep 30 (UTC)']);
  });
});
