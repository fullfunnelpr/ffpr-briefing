// Reads today's Google Calendar (via the Matagi proxy) and computes REALISTIC
// free working time: the working window minus merged busy intervals, after
// dropping cancelled/declined events, all-day items, and the auto-generated
// "Inbox review" / "Meeting prep" admin blocks.
import { proxy } from './matagi.js';
import { dateStr, wallToInstant, parseHM, timeStr } from './time.js';

const GCAL = 'https://www.googleapis.com/calendar/v3';

function startsWithAny(text, prefixes) {
  const t = (text || '').trim().toLowerCase();
  return prefixes.some((p) => t.startsWith(String(p).trim().toLowerCase()));
}

function mergeIntervals(intervals) {
  const sorted = intervals.slice().sort((a, b) => a.start - b.start);
  const merged = [];
  for (const iv of sorted) {
    const last = merged[merged.length - 1];
    if (last && iv.start <= last.end) last.end = Math.max(last.end, iv.end);
    else merged.push({ ...iv });
  }
  return merged;
}

export async function computeFreeTime(conn, settings, now) {
  const tz = settings.timezone;
  const today = dateStr(now, tz);
  const { h: sh, m: sm } = parseHM(settings.workStart);
  const { h: eh, m: em } = parseHM(settings.workEnd);
  const workStart = wallToInstant(today, sh, sm, tz);
  const workEnd = wallToInstant(today, eh, em, tz);
  const windowMinutes = Math.max(0, (workEnd - workStart) / 60000);

  // Fetch the whole London day so we don't miss events partly outside the window.
  const dayStart = wallToInstant(today, 0, 0, tz);
  const dayEnd = new Date(dayStart.getTime() + 26 * 3600 * 1000); // generous upper bound

  const params = new URLSearchParams({
    timeMin: dayStart.toISOString(),
    timeMax: dayEnd.toISOString(),
    singleEvents: 'true', // expand recurring events into today's instances
    orderBy: 'startTime',
    maxResults: '250',
    showDeleted: 'false',
  });
  const resp = await proxy(conn.connectionId, {
    method: 'GET',
    url: `${GCAL}/calendars/${encodeURIComponent(settings.calendarId)}/events?${params.toString()}`,
    headers: { 'Content-Type': 'application/json' },
  });
  if (resp.status >= 400) {
    throw new Error(`calendar ${resp.status}: ${JSON.stringify(resp.body).slice(0, 200)}`);
  }

  const events = resp.body?.items || [];
  const buffer = (settings.meetingBufferMins || 0) * 60000;
  const busy = [];
  const meetings = [];
  const excluded = [];

  for (const ev of events) {
    const summary = ev.summary || '(no title)';
    if (ev.status === 'cancelled') { excluded.push({ summary, reason: 'cancelled' }); continue; }
    const self = (ev.attendees || []).find((a) => a.self);
    if (self && self.responseStatus === 'declined') { excluded.push({ summary, reason: 'declined' }); continue; }
    if (!ev.start?.dateTime) { excluded.push({ summary, reason: 'all-day' }); continue; }
    if (startsWithAny(summary, settings.adminBlockPrefixes || [])) { excluded.push({ summary, reason: 'admin-block' }); continue; }

    const evStart = new Date(ev.start.dateTime).getTime();
    const evEnd = new Date(ev.end.dateTime).getTime();
    // Clip to the working window (with optional buffer around the meeting).
    const start = Math.max(evStart - buffer, workStart.getTime());
    const end = Math.min(evEnd + buffer, workEnd.getTime());
    if (end <= start) { excluded.push({ summary, reason: 'outside-window' }); continue; }

    busy.push({ start, end });
    meetings.push({
      summary,
      start: timeStr(new Date(evStart), tz),
      end: timeStr(new Date(evEnd), tz),
      durationMins: Math.round((evEnd - evStart) / 60000),
    });
  }

  const merged = mergeIntervals(busy);
  const busyMinutes = merged.reduce((sum, iv) => sum + (iv.end - iv.start) / 60000, 0);
  const freeMinutes = Math.max(0, windowMinutes - busyMinutes);

  return {
    windowLabel: `${settings.workStart}–${settings.workEnd}`,
    windowMinutes,
    busyMinutes: Math.round(busyMinutes),
    freeMinutes: Math.round(freeMinutes),
    freeHours: Math.round((freeMinutes / 60) * 10) / 10,
    meetingCount: meetings.length,
    meetings,
    excluded,
  };
}
