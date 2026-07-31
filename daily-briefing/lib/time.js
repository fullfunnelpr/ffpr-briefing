// Timezone-correct helpers for a single IANA zone (Europe/London), so the
// BST/GMT switch is handled without any hard-coded offset.

function partsIn(date, timeZone) {
  const dtf = new Intl.DateTimeFormat('en-GB', {
    timeZone,
    hour12: false,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    weekday: 'long',
  });
  const out = {};
  for (const p of dtf.formatToParts(date)) out[p.type] = p.value;
  return out;
}

// Minutes the zone is ahead of UTC at the given instant (London: 0 or +60).
function offsetMinutes(date, timeZone) {
  const p = partsIn(date, timeZone);
  const asUTC = Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour, +p.minute, +p.second);
  return (asUTC - date.getTime()) / 60000;
}

// "YYYY-MM-DD" for the given instant in the zone.
export function dateStr(date, timeZone) {
  const p = partsIn(date, timeZone);
  return `${p.year}-${p.month}-${p.day}`;
}

// Human weekday + date, e.g. "Friday, 31 July 2026".
export function prettyDate(date, timeZone) {
  return new Intl.DateTimeFormat('en-GB', {
    timeZone,
    weekday: 'long',
    day: 'numeric',
    month: 'long',
    year: 'numeric',
  }).format(date);
}

// "HH:MM" wall-clock time in the zone.
export function timeStr(date, timeZone) {
  const p = partsIn(date, timeZone);
  return `${p.hour}:${p.minute}`;
}

// Convert a wall-clock time (YYYY-MM-DD + hh:mm) in the zone to a UTC instant.
// Corrects once for DST so it is exact across the year (our windows never sit
// on the 01:00/02:00 transition, but the correction keeps it robust).
export function wallToInstant(ymd, hh, mm, timeZone) {
  const [Y, M, D] = ymd.split('-').map(Number);
  const naive = Date.UTC(Y, M - 1, D, hh, mm, 0);
  let instant = new Date(naive - offsetMinutes(new Date(naive), timeZone) * 60000);
  const off2 = offsetMinutes(instant, timeZone);
  instant = new Date(naive - off2 * 60000);
  return instant;
}

export function parseHM(hm) {
  const [h, m] = String(hm).split(':').map(Number);
  return { h: h || 0, m: m || 0 };
}

// Whole days from date-only string a to b (b - a), calendar days.
export function daysBetween(a, b) {
  const [ay, am, ad] = a.split('-').map(Number);
  const [by, bm, bd] = b.split('-').map(Number);
  return Math.round((Date.UTC(by, bm - 1, bd) - Date.UTC(ay, am - 1, ad)) / 86400000);
}
