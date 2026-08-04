// Scheduled-trigger receiver. Matagi delivers a signed POST here every weekday
// morning. We verify the HMAC signature + timestamp, dedupe on the event id,
// then run the briefing. Always responds 200 so at-least-once delivery does not
// retry-storm (duplicates are absorbed by the dedupe marker).
import { createHmac, timingSafeEqual } from 'node:crypto';
import { runBriefing, summarize } from '../../lib/brief.js';
import { storageGet, storagePut } from '../../lib/matagi.js';

export const config = { api: { bodyParser: false } };

async function readRawBody(req) {
  const chunks = [];
  try {
    for await (const chunk of req) chunks.push(typeof chunk === 'string' ? Buffer.from(chunk) : chunk);
  } catch {
    /* stream may already be consumed */
  }
  if (chunks.length) return Buffer.concat(chunks).toString('utf8');
  if (typeof req.body === 'string') return req.body;
  if (Buffer.isBuffer(req.body)) return req.body.toString('utf8');
  if (req.body && typeof req.body === 'object') return JSON.stringify(req.body);
  return '';
}

function verify(raw, ts, sig, secret) {
  if (!secret || !sig || !ts) return false;
  const expected = 'v0=' + createHmac('sha256', secret).update(`v0:${ts}:${raw}`).digest('hex');
  if (expected.length !== sig.length) return false;
  let ok = false;
  try {
    ok = timingSafeEqual(Buffer.from(expected), Buffer.from(sig));
  } catch {
    return false;
  }
  return ok && Math.abs(Date.now() / 1000 - Number(ts)) <= 300;
}

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'method not allowed' });

  const raw = await readRawBody(req);
  const ts = req.headers['x-matagi-timestamp'] || '';
  const sig = req.headers['x-matagi-signature'] || '';
  const eventId = req.headers['x-matagi-event-id'] || '';
  const secret = process.env.MATAGI_SIGNING_SECRET || '';

  if (!verify(raw, ts, sig, secret)) {
    return res.status(401).json({ error: 'unauthorized' });
  }

  // Best-effort dedupe (delivery is at-least-once).
  if (eventId) {
    try {
      const seen = await storageGet(`events/${eventId}.json`);
      if (seen) return res.status(200).json({ ok: true, deduped: true });
      await storagePut(`events/${eventId}.json`, { at: new Date().toISOString() });
    } catch {
      /* dedupe is best-effort */
    }
  }

  try {
    const record = await runBriefing({ trigger: 'schedule' });
    return res.status(200).json({ ok: true, summary: summarize(record) });
  } catch (e) {
    // Swallow to 200 so the schedule does not retry-storm; the error is logged.
    console.error('briefing failed', e);
    return res.status(200).json({ ok: false, error: String(e?.message || e) });
  }
}
