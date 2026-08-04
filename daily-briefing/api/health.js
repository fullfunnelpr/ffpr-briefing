// Liveness + last-run summary (no auth; returns only non-sensitive metadata).
import { lastRun, summarize } from '../lib/brief.js';

export default async function handler(req, res) {
  let last = null;
  try {
    const record = await lastRun();
    if (record) last = summarize(record);
  } catch {
    /* storage may be empty before the first run */
  }
  return res.status(200).json({
    ok: true,
    service: 'daily-briefing',
    now: new Date().toISOString(),
    lastRun: last,
  });
}
