// Date arithmetic for copying a client: every date moves by the same whole number of
// days, so the gaps between them are kept. Done in UTC on whole days, so the result
// never depends on the server's timezone or on daylight saving.
const DAY_MS = 24 * 60 * 60 * 1000;
const utcDay = (d) => Math.floor(new Date(d).getTime() / DAY_MS);

// Whole days from `anchor` to `start` (negative when `start` is earlier).
exports.dayShift = (anchor, start) => utcDay(start) - utcDay(anchor);

// `date` moved by `days`, keeping its time of day.
exports.shiftDate = (date, days) => new Date(new Date(date).getTime() + days * DAY_MS);

// The earliest of the dates that exist, or null when there are none.
exports.earliest = (dates) => {
  const real = dates.filter(Boolean).map((d) => new Date(d));
  return real.length ? new Date(Math.min(...real.map((d) => d.getTime()))) : null;
};
