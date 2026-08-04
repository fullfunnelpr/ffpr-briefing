# Daily Briefing

An autonomous weekday morning briefing agent for **Matt Phillips PR**, built on
**Matagi**. It replaces the Zapier "FFPR Morning Briefing Agent — 7:30am" Zap.

## Deployment status

Two implementations live in this repo:

- **`lambda/`** — Python, **this is what is provisioned on Matagi** (a lambda,
  because Matagi scheduling/HTTP for a from-scratch build in this workspace could
  only target a Vercel/Render project deployed from a `matagi-customers` repo,
  which this session's GitHub scope can't push to). This is the deployed agent.
- **root (`api/`, `lib/`, `config/`)** — the Node/Vercel variant, a drop-in for
  when a `matagi-customers`-scoped session can deploy it natively and wire a
  `register_schedule` trigger.

**What is live and verified (Matagi project `Daily Briefing`):**

- Lambda `daily-briefing-agent` (running the **token-ready** code), S3 bucket
  `daily-briefing-store`, Notion "Daily Briefing" dashboard page (created),
  Notion/Calendar/Gmail connections shared with the lambda.
- End-to-end run tested: **Google Calendar free-time, the Gmail pointer email,
  and the S3 run-history snapshot all work.** With no Notion token yet, the agent
  correctly **suppresses the email/dashboard** (`skipped-no-notion`) so no empty
  brief goes out.

**Deploy mechanism.** Large base64 zips transit unreliably through the
provisioning tools here (~14 KB+ often fails to unzip). So the lambda runs a tiny
**`loader.py`** that fetches the real code (`handler`/`agent`/`config`, as a zip)
from the storage bucket, uploaded in small, checksum-verified chunks. Every code
update is deterministic; `assemble` verifies the whole-zip SHA-256 before it goes
live.

**One thing left — the Notion token.** The Matagi connection proxy accepts a
`headers` dict but does **not** forward it upstream, so Notion rejects every call
with `missing_version` (the required `Notion-Version` header never arrives).
Calendar/Gmail are unaffected. The lambda is coded to call Notion with a **direct
integration token**; inject it (no redeploy) with:
```
lambda_execute daily-briefing-agent {"op":"set_config",
  "override":{"settings":{"notion_token":"secret_..."}}}
```
The integration must be granted access to the four task boards + the Daily
Briefing page (Notion → ••• → Connections). Once set, the full brief goes live.

**Then: scheduling.** Schedule a weekday cron that invokes the lambda with
`{"trigger":"schedule"}`; the handler gates on the London send-hour + a daily
guard so 07:30 Europe/London stays correct across BST/GMT.

---


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
