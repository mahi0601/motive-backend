const prisma = require('../config/prisma');
const { getZonedParts, getPeriodBounds, bucketKey } = require('../utils/timezone.util');

const VALID_PERIODS = ['week', 'month', 'quarter'];
// Motive Pro's gate: This week is free for everyone; a longer view (and the
// deeper insight history that comes with it — the same buildInsights() logic,
// just running over a bigger window) is the paid perk. Enforced in
// momentum.controller.js, which is the only place req.user.isPro is known —
// exported here so the controller and this service agree on exactly one
// definition of "which periods are free."
const PRO_ONLY_PERIODS = ['month', 'quarter'];
const AT_RISK_WINDOW_MS = 48 * 60 * 60 * 1000;

function median(numbers) {
  if (!numbers.length) return null;
  const sorted = [...numbers].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

function daysBetween(a, b) {
  return (b.getTime() - a.getTime()) / 86400000;
}

function emptyBuckets(period, bounds) {
  if (period === 'week') return ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'].map((name) => ({ name, current: 0, previous: 0 }));
  const dayCount = Math.round((bounds.currentEnd - bounds.currentStart) / 86400000);
  const weekCount = Math.ceil(dayCount / 7);
  return Array.from({ length: weekCount }, (_, i) => ({ name: `Week ${i + 1}`, current: 0, previous: 0 }));
}

// Snapshot ("as of right now") queries — inFlight/atRisk/overdue describe
// current state, not a completion event, so they can't be bucketed by
// completedAt the way `shipped`/throughput can.
async function getSnapshot(userId, now) {
  const [inFlightCount, oldestInFlight, atRisk, overdue] = await Promise.all([
    prisma.task.count({ where: { userId, status: 'in_progress' } }),
    prisma.task.findFirst({
      where: { userId, status: 'in_progress' },
      orderBy: { createdAt: 'asc' },
      select: { createdAt: true },
    }),
    prisma.task.count({
      where: { userId, status: { not: 'done' }, dueDate: { gte: now, lt: new Date(now.getTime() + AT_RISK_WINDOW_MS) } },
    }),
    prisma.task.count({ where: { userId, status: { not: 'done' }, dueDate: { lt: now } } }),
  ]);
  const oldestInFlightDays = oldestInFlight ? Math.max(0, Math.round(daysBetween(oldestInFlight.createdAt, now))) : null;
  return { inFlightCount, oldestInFlightDays, atRisk, overdue };
}

// Approximates "as of the end of the previous period" for the two tiles that
// admit a reasonable reconstruction from the fields already on Task
// (dueDate/completedAt) without a status-history table. `completedAt` is
// nulled on an "un-complete" (see task.service.js#withCompletedAt), so a task
// that was completed, reopened, then completed again later reads as "not
// done yet" at `asOf` even if it briefly was — a known, low-impact
// approximation, not a defect introduced here.
async function getSnapshotAsOf(userId, asOf) {
  const notDoneAsOf = { OR: [{ completedAt: null }, { completedAt: { gt: asOf } }] };
  const [atRisk, overdue] = await Promise.all([
    prisma.task.count({
      where: { userId, ...notDoneAsOf, dueDate: { gte: asOf, lt: new Date(asOf.getTime() + AT_RISK_WINDOW_MS) } },
    }),
    prisma.task.count({ where: { userId, ...notDoneAsOf, dueDate: { lt: asOf } } }),
  ]);
  return { atRisk, overdue };
}

// One completed-task fetch covers `shipped`, the throughput chart, median
// cycle time, and on-time rate for both the current and previous period —
// deliberately not four separate SQL shapes per period type the way the
// endpoint this replaces had (see statistics.service.js).
async function getCompletedTasks(userId, previousStart, currentEnd) {
  return prisma.task.findMany({
    where: { userId, status: 'done', completedAt: { gte: previousStart, lt: currentEnd } },
    select: { completedAt: true, createdAt: true, dueDate: true },
  });
}

function summarizeCompleted(tasks) {
  const cycleTimes = tasks.map((t) => daysBetween(t.createdAt, t.completedAt));
  const withDueDate = tasks.filter((t) => t.dueDate);
  const onTime = withDueDate.filter((t) => t.completedAt <= t.dueDate);
  return {
    count: tasks.length,
    cycleTimeDays: median(cycleTimes),
    onTimeRate: withDueDate.length ? Math.round((onTime.length / withDueDate.length) * 100) : null,
  };
}

async function getByCategory(userId) {
  const rows = await prisma.task.groupBy({
    by: ['category'],
    where: { userId, status: { not: 'done' } },
    _count: { _all: true },
  });
  return rows.map((r) => ({ name: r.category, value: r._count._all })).sort((a, b) => b.value - a.value);
}

const STATUS_LABELS = { todo: 'To do', in_progress: 'In progress' };
// Deliberately excludes 'done' — this is "where OPEN work sits," the same
// framing as getByCategory above; a completed-work breakdown belongs with
// the period-scoped `shipped` tile, not here.
async function getByStatus(userId) {
  const rows = await prisma.task.groupBy({
    by: ['status'],
    where: { userId, status: { not: 'done' } },
    _count: { _all: true },
  });
  return rows
    .map((r) => ({ name: STATUS_LABELS[r.status] || r.status, status: r.status, value: r._count._all }))
    .sort((a, b) => b.value - a.value);
}

function pctDelta(current, previous) {
  if (previous === 0) return current === 0 ? 0 : null; // null = "new", not a percentage
  return Math.round(((current - previous) / previous) * 100);
}

// Rules-based (not LLM-generated, same philosophy as digest.service.js): a
// handful of templated statements, each carrying a `filter` the frontend can
// turn into a click-through to the underlying task list. Positive states are
// deliberately included — an insight strip that only ever lists problems
// reads as broken once nothing is wrong.
function buildInsights({ tiles, cycleTimeDays, previousCycleTimeDays, byCategory }) {
  const insights = [];

  const overdueDelta = pctDelta(tiles.overdue.value, tiles.overdue.previous);
  if (tiles.overdue.value === 0) {
    insights.push({ severity: 'good', text: 'Nothing overdue right now.', filter: { status: 'overdue' } });
  } else if (overdueDelta > 0) {
    insights.push({
      severity: 'warning',
      text: `Overdue is up ${overdueDelta}% (${tiles.overdue.value} vs ${tiles.overdue.previous}).`,
      filter: { status: 'overdue' },
    });
  } else {
    // overdueDelta is null (previous was 0 — no baseline) or <= 0 (flat/down):
    // still worth surfacing that overdue work exists, just without a false delta.
    insights.push({
      severity: 'warning',
      text: `${tiles.overdue.value} task${tiles.overdue.value === 1 ? '' : 's'} overdue.`,
      filter: { status: 'overdue' },
    });
  }

  if (tiles.atRisk.value > 0) {
    insights.push({
      severity: 'warning',
      text: `${tiles.atRisk.value} task${tiles.atRisk.value === 1 ? '' : 's'} due in the next 48 hours.`,
      filter: { status: 'at-risk' },
    });
  } else {
    insights.push({ severity: 'good', text: 'Nothing at risk this week.', filter: { status: 'at-risk' } });
  }

  if (cycleTimeDays != null && previousCycleTimeDays != null && previousCycleTimeDays > 0) {
    const cycleDelta = Math.round(((cycleTimeDays - previousCycleTimeDays) / previousCycleTimeDays) * 100);
    if (Math.abs(cycleDelta) >= 15) {
      insights.push({
        severity: cycleDelta > 0 ? 'warning' : 'good',
        text: `Cycle time ${cycleDelta > 0 ? 'rose' : 'fell'} to ${cycleTimeDays.toFixed(1)}d from ${previousCycleTimeDays.toFixed(1)}d.`,
        filter: null,
      });
    }
  }

  if (byCategory[0] && byCategory[0].value >= 5) {
    insights.push({
      severity: 'info',
      text: `Most open work is in ${byCategory[0].name} (${byCategory[0].value} tasks).`,
      filter: { category: byCategory[0].name },
    });
  }

  return insights.slice(0, 5);
}

exports.VALID_PERIODS = VALID_PERIODS;
exports.PRO_ONLY_PERIODS = PRO_ONLY_PERIODS;
// Exported purely so tests/timezone-momentum.test.js can unit-test this pure
// math directly (median resisting an outlier, pctDelta's "no baseline"
// case) instead of engineering fragile date-boundary fixtures to exercise
// the same logic indirectly through getMomentum. Not used anywhere outside
// this module otherwise.
exports.median = median;
exports.pctDelta = pctDelta;

exports.getMomentum = async (userId, { period = 'week', timezone = 'UTC' } = {}) => {
  const safePeriod = VALID_PERIODS.includes(period) ? period : 'week';
  const now = new Date();
  const bounds = getPeriodBounds(safePeriod, timezone, now);

  const [snapshot, snapshotAsOfPrevious, completedTasks, byCategory, byStatus] = await Promise.all([
    getSnapshot(userId, now),
    getSnapshotAsOf(userId, bounds.previousEnd),
    getCompletedTasks(userId, bounds.previousStart, bounds.currentEnd),
    getByCategory(userId),
    getByStatus(userId),
  ]);

  const currentCompleted = completedTasks.filter((t) => t.completedAt >= bounds.currentStart);
  const previousCompleted = completedTasks.filter((t) => t.completedAt < bounds.currentStart);
  const currentSummary = summarizeCompleted(currentCompleted);
  const previousSummary = summarizeCompleted(previousCompleted);

  const startLocal = getZonedParts(bounds.currentStart, timezone);
  const buckets = emptyBuckets(safePeriod, bounds);
  const bucketIndex = Object.fromEntries(buckets.map((b, i) => [b.name, i]));
  currentCompleted.forEach((t) => {
    const key = bucketKey(safePeriod, getZonedParts(t.completedAt, timezone), startLocal);
    if (key in bucketIndex) buckets[bucketIndex[key]].current += 1;
  });
  const previousStartLocal = getZonedParts(bounds.previousStart, timezone);
  previousCompleted.forEach((t) => {
    const key = bucketKey(safePeriod, getZonedParts(t.completedAt, timezone), previousStartLocal);
    if (key in bucketIndex) buckets[bucketIndex[key]].previous += 1;
  });

  const tiles = {
    shipped: { value: currentSummary.count, previous: previousSummary.count },
    // No historical status-transition timestamp exists for "entered
    // in_progress" (see comment on getSnapshotAsOf), so this is reported as
    // a snapshot with context rather than a fabricated delta — an honest
    // "we don't know" beats a number that looks precise but isn't.
    inFlight: { value: snapshot.inFlightCount, oldestDays: snapshot.oldestInFlightDays },
    atRisk: { value: snapshot.atRisk, previous: snapshotAsOfPrevious.atRisk },
    overdue: { value: snapshot.overdue, previous: snapshotAsOfPrevious.overdue },
  };

  const insights = buildInsights({
    tiles,
    cycleTimeDays: currentSummary.cycleTimeDays,
    previousCycleTimeDays: previousSummary.cycleTimeDays,
    byCategory,
  });

  return {
    period: safePeriod,
    scope: 'me', // 'team' arrives with the workspace/assignee schema addition (Phase 2)
    tiles,
    // ISO instant, in the *user's* timezone-aware period math (see
    // timezone.util.js), not recomputed. Exists so the frontend's "Shipped"
    // click-through can filter completedAt >= this instant instead of
    // re-deriving week/month/quarter boundaries client-side — which would
    // risk reintroducing the exact timezone/week-start bug this endpoint
    // was built to fix (see PLAN §3).
    periodStart: bounds.currentStart.toISOString(),
    throughput: buckets,
    cycleTimeDays: currentSummary.cycleTimeDays,
    onTimeRate: currentSummary.onTimeRate,
    byCategory,
    byStatus,
    insights,
  };
};
