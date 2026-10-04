// Copying a client shifts every date by the same whole number of days, so the gaps
// between them (kickoff to first review to launch) are kept. All in UTC, so the answer
// never depends on the server's timezone or on daylight saving.
const { dayShift, shiftDate, earliest } = require('../src/utils/dateShift');

const iso = (d) => d.toISOString();

describe('dayShift', () => {
  test('is the number of whole days from the anchor to the new start', () => {
    expect(dayShift('2026-10-01', '2026-10-11')).toBe(10);
    expect(dayShift('2026-10-01', '2027-03-01')).toBe(151);
  });
  test('is negative when the new start is earlier, and zero for the same day', () => {
    expect(dayShift('2026-10-11', '2026-10-01')).toBe(-10);
    expect(dayShift('2026-10-01', '2026-10-01')).toBe(0);
  });
  test('only the calendar day matters, not the time of day', () => {
    expect(dayShift('2026-10-01T23:59:00Z', '2026-10-02T00:01:00Z')).toBe(1);
    expect(dayShift('2026-10-01T00:00:00Z', '2026-10-01T23:59:59Z')).toBe(0);
  });
  test('is exact across a daylight-saving change and a leap day', () => {
    expect(dayShift('2026-03-01', '2026-04-01')).toBe(31);
    expect(dayShift('2028-02-28', '2028-03-01')).toBe(2); // 2028 is a leap year
    expect(dayShift('2027-02-28', '2027-03-01')).toBe(1);
  });
});

describe('shiftDate', () => {
  test('moves a date by whole days and keeps its time of day', () => {
    expect(iso(shiftDate('2026-10-01T09:30:00.000Z', 10))).toBe('2026-10-11T09:30:00.000Z');
    expect(iso(shiftDate('2026-10-11T00:00:00.000Z', -10))).toBe('2026-10-01T00:00:00.000Z');
  });
  test('works across month and year ends', () => {
    expect(iso(shiftDate('2026-12-31T00:00:00.000Z', 1))).toBe('2027-01-01T00:00:00.000Z');
  });
  test('keeps the gaps between dates the same', () => {
    const shift = dayShift('2026-10-01', '2027-03-01');
    const a = shiftDate('2026-10-01T00:00:00.000Z', shift);
    const b = shiftDate('2026-10-11T00:00:00.000Z', shift);
    expect((b - a) / 86400000).toBe(10);
    expect(iso(a)).toBe('2027-03-01T00:00:00.000Z');
  });
});

describe('earliest', () => {
  test('is the earliest real date, ignoring empty ones', () => {
    expect(iso(earliest([null, '2026-10-11', undefined, '2026-10-01', '2026-12-01']))).toBe('2026-10-01T00:00:00.000Z');
  });
  test('is null when there are none', () => {
    expect(earliest([])).toBeNull();
    expect(earliest([null, undefined])).toBeNull();
  });
});
