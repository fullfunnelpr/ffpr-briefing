# Daily Briefing

An autonomous weekday morning briefing agent for **Matt Phillips PR**, built on
**Matagi**. It replaces the Zapier "FFPR Morning Briefing Agent — 7:30am" Zap.

Each weekday morning it:

1. Reads open tasks from four Notion boards (Axate, DoubleVerify/ModOp, Oxford
   Global Projects, and internal Full Funnel PR) — **read-only**, excluding the
   exact `✅ Completed` status.
2. Reads today's Google Calendar and computes **realistic** free working time
   (working window minus real busy intervals; cancelled/declined/all-day events
   and auto-generated `Inbox review` / `Meeting prep` blocks are ignored).
3. Ranks everything with explicit, editable rules (client > internal, then
   priority, boosted for overdue/due-soon/stale; ambiguous items are routed to a
   "needs clarity" section).
4. **Updates the Notion "Daily Briefing" dashboard in place** (rebuilds the whole
   page body each run — never leaves a section blank).
5. Sends a **short pointer email** (free time + top 3 + link to the dashboard) to
   `matt@mattphillipspr.com`, subject `Your Morning Briefing - YYYY-MM-DD`.
6. Persists a full snapshot of every run for history and observability.

## Architecture (all provisioned via the Matagi MCP)

- **Vercel project** `Daily Briefing` — this code. Node ESM serverless functions.
- **S3 bucket** `daily-briefing-store` — run history + optional config override.
- **Schedule** — `cron(30 7 ? * MON-FRI *)`, timezone `Europe/London` (the BST/GMT
  switch is handled automatically) → signed POST to `/api/matagi/events`.
- **Connections** (shared, no tokens in code): Notion, Google Calendar, Gmail.

At runtime the resource talks to `https://api.matagi.ai` with its injected
`MATAGI_RESOURCE_API_KEY`: the connection proxy for Notion/Calendar/Gmail, storage
presign for history, and (optionally) an LLM completion for the sign-off line.

## Endpoints

| Endpoint | Purpose |
| --- | --- |
| `POST /api/matagi/events` | Scheduled trigger. Verifies the Matagi HMAC signature, dedupes on event id, runs the briefing. |
| `GET/POST /api/run?token=…` | **Manual same-day rerun.** Auth via `RUN_TOKEN` (env) or `settings.runToken`. Same code path as the schedule. Also accepts `x-run-token` header. |
| `GET /api/health` | Liveness + last-run summary. |

## Configuration (`config/`)

Everything tunable lives in `config/` as plain objects — no logic buried in a
prompt:

- `boards.js` — the four boards + their client/internal flag and Notion IDs.
- `ranking.js` — scoring weights (`clientBoost`, `priorityWeights`, `overdueBoost`,
  `dueSoonBoost`, `staleCarryoverBoost`, `topN`, `radarMax`, …).
- `settings.js` — working window, timezone, calendar id, recipient, dashboard page,
  admin-block prefixes, run token.
- `templates.js` — greeting, sign-off, empty-state copy.

**Edit without a redeploy:** upload `config/override.json` to the storage bucket;
it is deep-merged over the defaults at runtime. Example:

```json
{ "ranking": { "clientBoost": 120 }, "settings": { "workEnd": "18:00" } }
```

## Maintenance

- **New client / offboard** — add or remove an entry in `config/boards.js`.
- **Change ranking or copy** — edit `config/ranking.js` / `config/templates.js`
  (or the S3 override).
- **Change send time** — update the schedule (`register_schedule`).
- **Pause** — disable the schedule (`unregister_schedule` / Matagi console).

## Reliability & observability

- Each Notion board and the calendar are fetched independently; a failure yields a
  **partial brief** with an explicit "⚠️ couldn't load X" note rather than a silent
  failure.
- Every run is persisted to `runs/<ISO>.json` (+ `runs/latest.json`) in the bucket:
  email body, ranked task list, source counts by board, missing sources, free-time
  figure, calendar summary, and dashboard-write / email-send statuses.

## Notes / follow-ups

- The four task databases are strictly **read-only**. The only Notion write target
  is the Daily Briefing dashboard page.
- The old Zapier Zap is **not** deleted by this agent — switch it off once this is
  confirmed working.
- **Inbox noise filter:** if the overnight inbox routine is still live, whitelist
  the subject `Your Morning Briefing` so the pointer email is never archived as
  noise. (Left as a manual step — this agent does not modify Gmail filters.)
