/**
 * Dependency-free timezone helpers, used only to bucket the Momentum
 * endpoint's week/month/quarter ranges in the *user's* local day instead of
 * the database server's timezone (the bug this replaces — see
 * momentum.service.js). No date library is added; `Intl` already ships with
 * Node and covers everything needed here.
 *
 * These intentionally work in whole-day granularity (period boundaries are
 * always midnight-to-midnight in the user's zone) — good enough for
 * week/month/quarter buckets, and it sidesteps the one edge case double
 * conversion can get wrong (a boundary landing on the exact second of a DST
 * transition), which never happens at midnight in practice.
 */

// Local wall-clock parts of `date` as seen in `timeZone`.
function getZonedParts(date, timeZone) {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    weekday: 'short',
  }).formatToParts(date);
  const map = Object.fromEntries(parts.map((p) => [p.type, p.value]));
  const WEEKDAY_INDEX = { Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6, Sun: 7 }; // ISO, Monday = 1
  return {
    year: Number(map.year),
    month: Number(map.month), // 1-12
    day: Number(map.day),
    isoWeekday: WEEKDAY_INDEX[map.weekday],
  };
}

// The UTC instant corresponding to local midnight (00:00:00) on
// {year, month, day} in `timeZone`. Standard "double conversion" trick, done
// carefully: format the same guessed instant as both a UTC wall-clock string
// and a `timeZone` wall-clock string, then diff the two *parsed* results.
// Both parses go through `new Date(string)`, which reads a string with no
// zone info in the *host* system's timezone — but since that host-zone bias
// applies identically to both strings, it cancels out in the subtraction,
// leaving exactly `timeZone`'s UTC offset at that instant. (An earlier
// version diffed the formatted string against the raw `guess` instant
// instead of against an equally-parsed UTC string — the host bias didn't
// cancel, so on a host whose own TZ wasn't UTC, every boundary silently
// picked up that host's offset. Caught by manually testing a few zones
// against a fixed instant, since there's no test suite to catch it for us.)
function zonedMidnightToUtc({ year, month, day }, timeZone) {
  const guess = new Date(Date.UTC(year, month - 1, day, 0, 0, 0));
  const asUtc = new Date(guess.toLocaleString('en-US', { timeZone: 'UTC' }));
  const asTz = new Date(guess.toLocaleString('en-US', { timeZone }));
  const offsetMs = asUtc.getTime() - asTz.getTime();
  return new Date(guess.getTime() + offsetMs);
}

function addDays({ year, month, day }, n) {
  const d = new Date(Date.UTC(year, month - 1, day));
  d.setUTCDate(d.getUTCDate() + n);
  return { year: d.getUTCFullYear(), month: d.getUTCMonth() + 1, day: d.getUTCDate() };
}

/**
 * Current-period and previous-period [start, end) boundaries, as UTC Date
 * instants, for `period` ('week' | 'month' | 'quarter') in `timezone`.
 * Weeks start Monday (ISO) — the boundary itself is what fixes the old
 * Sunday-labeled-first-but-actually-last bug; bucketing by day afterward
 * (see momentum.service.js) means there's no separate DOW/date_trunc
 * mismatch left to reintroduce.
 */
function getPeriodBounds(period, timezone, now = new Date()) {
  const zoned = getZonedParts(now, timezone);

  let currentStartLocal;
  let daysInPeriod; // used to size the previous period for 'week'; month/quarter compute their own end

  if (period === 'month') {
    currentStartLocal = { year: zoned.year, month: zoned.month, day: 1 };
    const currentEndLocal = addDays(
      { year: zoned.year, month: zoned.month, day: 1 },
      daysInMonth(zoned.year, zoned.month)
    );
    const prevMonth = zoned.month === 1 ? { year: zoned.year - 1, month: 12 } : { year: zoned.year, month: zoned.month - 1 };
    const previousStartLocal = { year: prevMonth.year, month: prevMonth.month, day: 1 };
    return {
      currentStart: zonedMidnightToUtc(currentStartLocal, timezone),
      currentEnd: zonedMidnightToUtc(currentEndLocal, timezone),
      previousStart: zonedMidnightToUtc(previousStartLocal, timezone),
      previousEnd: zonedMidnightToUtc(currentStartLocal, timezone),
    };
  }

  if (period === 'quarter') {
    const qStartMonth = Math.floor((zoned.month - 1) / 3) * 3 + 1;
    currentStartLocal = { year: zoned.year, month: qStartMonth, day: 1 };
    let endMonth = qStartMonth + 3;
    let endYear = zoned.year;
    if (endMonth > 12) { endMonth -= 12; endYear += 1; }
    const currentEndLocal = { year: endYear, month: endMonth, day: 1 };
    let prevStartMonth = qStartMonth - 3;
    let prevStartYear = zoned.year;
    if (prevStartMonth < 1) { prevStartMonth += 12; prevStartYear -= 1; }
    const previousStartLocal = { year: prevStartYear, month: prevStartMonth, day: 1 };
    return {
      currentStart: zonedMidnightToUtc(currentStartLocal, timezone),
      currentEnd: zonedMidnightToUtc(currentEndLocal, timezone),
      previousStart: zonedMidnightToUtc(previousStartLocal, timezone),
      previousEnd: zonedMidnightToUtc(currentStartLocal, timezone),
    };
  }

  // 'week' (default) — Monday start.
  daysInPeriod = 7;
  const backToMonday = zoned.isoWeekday - 1; // 0 if already Monday
  currentStartLocal = addDays(zoned, -backToMonday);
  const currentEndLocal = addDays(currentStartLocal, daysInPeriod);
  const previousStartLocal = addDays(currentStartLocal, -daysInPeriod);
  return {
    currentStart: zonedMidnightToUtc(currentStartLocal, timezone),
    currentEnd: zonedMidnightToUtc(currentEndLocal, timezone),
    previousStart: zonedMidnightToUtc(previousStartLocal, timezone),
    previousEnd: zonedMidnightToUtc(currentStartLocal, timezone),
  };
}

function daysInMonth(year, month) {
  return new Date(Date.UTC(year, month, 0)).getUTCDate();
}

// Day-bucket label for the throughput chart — 'week' by weekday name,
// 'month' by week-of-month, 'quarter' by ISO week number relative to the
// quarter start. Bucketing is done by walking whole local days (via
// getZonedParts on each completedAt), not via the server's date_trunc, so
// there's no timezone or week-start mismatch to reintroduce.
function bucketKey(period, localDate, periodStartLocal) {
  if (period === 'week') {
    return ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'][localDate.isoWeekday - 1];
  }
  const start = new Date(Date.UTC(periodStartLocal.year, periodStartLocal.month - 1, periodStartLocal.day));
  const cur = new Date(Date.UTC(localDate.year, localDate.month - 1, localDate.day));
  const dayIndex = Math.round((cur - start) / 86400000);
  if (period === 'month') return `Week ${Math.floor(dayIndex / 7) + 1}`;
  return `Week ${Math.floor(dayIndex / 7) + 1}`; // quarter: relative week number within it
}

module.exports = { getZonedParts, getPeriodBounds, bucketKey };
