"""Matagi lambda entrypoint for the Daily Briefing agent.

Invoked directly (lambda_execute) with a small payload:
    {"trigger": "manual"}                  -> always runs now (manual rerun)
    {"trigger": "schedule"}                -> runs only at the London send hour,
                                              once per London day (BST/GMT-safe)
    {"trigger": "schedule", "force": true} -> schedule path, ignore the time gate

    {"op": "set_config", "override": {...}} -> deep-merge {...} into the storage
        override (config/override.json). Used to inject the Notion token without
        a redeploy, e.g. {"settings": {"notion_token": "secret_..."}}.

The scheduler (a weekday cron that fires in UTC) is deliberately dumb: it may
fire more than once around the target time and does not know about BST/GMT.
This handler makes the decision so the 07:30 Europe/London slot stays correct
year-round: it runs only when London local time is in the configured send hour
and a per-day guard in storage has not already fired.
"""

import datetime as dt

import agent
from config import load_config, _deep_merge


def handler(event, context=None):
    event = event or {}
    op = event.get("op")

    if op == "set_config":
        override = event.get("override") or {}
        existing = {}
        try:
            existing = agent.storage_get("config/override.json") or {}
        except Exception:
            existing = {}
        merged = _deep_merge(existing, override)
        agent.storage_put("config/override.json", merged)
        return {"ok": True, "stored_keys": list(override.keys()),
                "connections": [c.get("app") for c in agent.get_connections()]}

    trigger = event.get("trigger", "manual")
    force = bool(event.get("force"))
    cfg = load_config(agent.storage_get)
    now = dt.datetime.now(dt.timezone.utc)

    if trigger == "schedule" and not force:
        local = agent.london_local(now)
        today = agent.date_str(now)
        target_hour = cfg["settings"].get("send_hour_london", 7)
        if local.hour != target_hour:
            return {"ok": True, "skipped": "outside-send-hour",
                    "london_time": agent.time_str(now), "target_hour": target_hour}
        guard = {}
        try:
            guard = agent.storage_get("state/last-run-date.json") or {}
        except Exception:
            guard = {}
        if guard.get("date") == today:
            return {"ok": True, "skipped": "already-ran-today", "date": today}
        # Claim the day up-front so a second same-hour fire is a no-op.
        try:
            agent.storage_put("state/last-run-date.json", {"date": today, "at": now.isoformat()})
        except Exception:
            pass

    record = agent.run_briefing(cfg, trigger=trigger)
    return {"ok": True, "summary": agent.summarize(record)}
