// Promotes three manual `node -e` verifications done by hand earlier this
// session into permanent tests (PLAN's regression-debt item 4) — each of
// these caught or confirmed a real bug (the original week-start/timezone
// bug this endpoint replaced, and the at-risk boundary correctness) and
// deserves to be more than tribal knowledge living only in a conversation.
const { getZonedParts, getPeriodBounds, bucketKey } = require('../src/utils/timezone.util');
const momentumService = require('../src/services/momentum.service');
const { makeUser, cleanupUsers } = require('./helpers/fixtures');

describe('timezone.util — period boundaries', () => {
  test('a week in UTC starts Monday, not Sunday (the original bug this replaced)', () => {
    // 2026-09-10 is a Thursday.
    const bounds = getPeriodBounds('week', 'UTC', new Date('2026-09-10T12:00:00Z'));
    expect(bounds.currentStart.toISOString()).toBe('2026-09-07T00:00:00.000Z'); // Monday
    expect(bounds.currentEnd.toISOString()).toBe('2026-09-14T00:00:00.000Z'); // next Monday
  });

  test('a Sunday-night completion in a non-UTC zone still lands in the current week, bucketed as Sun', () => {
    // 2026-09-13 23:00 NZST (Pacific/Auckland) — a Sunday night.
    const instant = new Date('2026-09-13T23:00:00+12:00');
    const bounds = getPeriodBounds('week', 'Pacific/Auckland', instant);
    // The week that Sunday belongs to should already have started (Monday
    // 2026-09-07 local) and not yet ended (next Monday 2026-09-14 local).
    expect(instant.getTime()).toBeGreaterThanOrEqual(bounds.currentStart.getTime());
    expect(instant.getTime()).toBeLessThan(bounds.currentEnd.getTime());

    const key = bucketKey('week', getZonedParts(instant, 'Pacific/Auckland'));
    expect(key).toBe('Sun');
  });

  test('getZonedParts reports the correct ISO weekday regardless of the host machine\'s own timezone', () => {
    // 2026-09-10 is a Thursday (ISO weekday 4) everywhere it's still the 10th.
    const parts = getZonedParts(new Date('2026-09-10T12:00:00Z'), 'UTC');
    expect(parts).toMatchObject({ year: 2026, month: 9, day: 10, isoWeekday: 4 });
  });
});

describe('momentum.service — median and delta math', () => {
  test('median barely moves for one stale outlier among many fast completions — a mean would not', () => {
    const mostlyFast = [2, 2, 2, 2, 2, 2, 2, 2, 2, 180]; // 9 tasks in ~2 days, one in 180
    expect(momentumService.median(mostlyFast)).toBe(2);
    // Documents the bug this replaces: a plain mean here would be 19.8,
    // dragged nearly 10x by a single stale task.
    const mean = mostlyFast.reduce((a, b) => a + b, 0) / mostlyFast.length;
    expect(mean).toBeCloseTo(19.8, 1);
    expect(momentumService.median(mostlyFast)).toBeLessThan(mean / 5);
  });

  test('median of an empty array is null, not NaN or a thrown error', () => {
    expect(momentumService.median([])).toBeNull();
  });

  test('pctDelta reports "new" (null) rather than a fabricated percentage when there was no baseline', () => {
    expect(momentumService.pctDelta(5, 0)).toBeNull();
  });

  test('pctDelta reports 0%, not "new", when both periods are genuinely zero', () => {
    expect(momentumService.pctDelta(0, 0)).toBe(0);
  });

  test('pctDelta computes a normal percentage change when there is a real baseline', () => {
    expect(momentumService.pctDelta(9, 6)).toBe(50); // up 50%
    expect(momentumService.pctDelta(3, 6)).toBe(-50); // down 50%
  });
});

describe('momentum.service.getMomentum — end-to-end sanity on a fresh account', () => {
  let user;

  afterEach(async () => {
    if (user) await cleanupUsers(user);
    user = null;
  });

  test('an account with zero tasks gets an all-zero response, not a crash or a null-reference', async () => {
    user = await makeUser('momentum-empty');
    const data = await momentumService.getMomentum(user.id, { period: 'week', timezone: 'UTC' });

    expect(data.scope).toBe('me');
    expect(data.tiles.shipped.value).toBe(0);
    expect(data.tiles.overdue.value).toBe(0);
    expect(data.cycleTimeDays).toBeNull();
    expect(data.throughput).toHaveLength(7); // Mon..Sun, zero-filled, never sparse
    expect(data.insights.length).toBeGreaterThan(0); // positive states render too
  });
});
