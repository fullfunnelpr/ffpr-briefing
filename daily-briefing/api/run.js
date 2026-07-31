// Manual same-day rerun. Protected by RUN_TOKEN (env secret preferred; falls
// back to settings.runToken in the private repo). Same code path as the schedule.
//   GET/POST /api/run?token=...    or header  x-run-token: ...
import { runBriefing, summarize } from '../lib/brief.js';
import { loadConfig } from '../lib/config.js';

export default async function handler(req, res) {
  const cfg = await loadConfig();
  const expected = process.env.RUN_TOKEN || cfg.settings.runToken || '';
  const provided = req.headers['x-run-token'] || req.query?.token || '';

  if (!expected || provided !== expected) {
    return res.status(401).json({ error: 'unauthorized' });
  }

  try {
    const record = await runBriefing({ trigger: 'manual' });
    return res.status(200).json({ ok: true, summary: summarize(record) });
  } catch (e) {
    return res.status(500).json({ ok: false, error: String(e?.message || e) });
  }
}
