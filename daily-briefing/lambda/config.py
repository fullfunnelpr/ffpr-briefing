"""Editable configuration for the Daily Briefing agent (Python lambda).

Everything tunable lives here as plain dicts — no logic buried in a prompt. A
runtime override can be uploaded to the storage bucket as config/override.json
(deep-merged over these defaults) so rules/templates can change without a
redeploy.
"""

# The four Notion task boards (READ-ONLY).
#   data_source_id -> POST /v1/data_sources/{id}/query  (Notion-Version 2025-09-03)
#   database_id    -> fallback POST /v1/databases/{id}/query (Notion-Version 2022-06-28)
BOARDS = [
    {
        "key": "ffpr",
        "label": "Full Funnel PR",
        "client_or_internal": "internal",
        "data_source_id": "ea287192-3942-47c6-bb4a-8f344bafcc9c",
        "database_id": "9b632bf3-0547-4d41-b431-1a602ea93102",
    },
    {
        "key": "axate",
        "label": "Axate",
        "client_or_internal": "client",
        "data_source_id": "af6fc7e2-4961-436e-b9ea-f5e77cc41529",
        "database_id": "2a05251f-072f-49f3-a67e-a9c85142e7ee",
    },
    # DoubleVerify / ModOp removed Aug 2026 — engagement ended, no longer a client.
    # (data_source ea… 7ce6aff2-bbb3-4868-8330-7d49dd738cf7 if it needs re-adding.)
    {
        "key": "ogp",
        "label": "Oxford Global Projects",
        "client_or_internal": "client",
        "data_source_id": "141b1c67-4378-4341-be9a-f54d8d8a57f5",
        "database_id": "18a2a1fd-5e62-4af2-8baa-3334c1baa48c",
    },
]

# Ranking rules. Score = client_boost (if client) + priority weight
#   + overdue_boost | due_soon_boost (within due_soon_window_days)
#   + stale_carryover_boost (open and untouched for >= stale_days).
RANKING = {
    "client_boost": 100,
    "priority_weights": {"high": 40, "mid": 20, "low": 5, "none": 0},
    "overdue_boost": 60,
    "due_soon_boost": 30,
    "due_soon_window_days": 3,
    "stale_carryover_boost": 10,
    "stale_days": 14,
    "top_n": 3,
    "radar_max": 12,
}

SETTINGS = {
    "timezone": "Europe/London",
    "work_start": "09:00",
    "work_end": "17:30",
    "meeting_buffer_mins": 0,
    "calendar_id": "primary",
    "completed_status": "✅ Completed",  # exact Notion option to exclude
    "admin_block_prefixes": ["Inbox review", "Meeting prep"],
    "recipient": "matt@mattphillipspr.com",
    "sender": "matt@mattphillipspr.com",

    # Notion access. The Matagi connection proxy strips the required
    # Notion-Version header, so the lambda reaches Notion with a direct
    # integration token instead. Leave blank and inject at runtime via the
    # handler `set_config` op (stored in the storage bucket, not in code):
    #   lambda_execute {"op":"set_config","override":{"settings":{"notion_token":"secret_..."}}}
    # The integration must be granted access to the four task boards + the
    # Daily Briefing page (Notion → ••• → Connections).
    "notion_token": "",
    # If true, still send the pointer email when Notion is unavailable
    # (calendar/free-time only). Default false so no empty brief goes out.
    "email_when_no_notion": False,
    "dashboard_title": "Daily Briefing",
    "dashboard_icon": "\U0001f5d3️",
    "dashboard_parent_page_id": "32cf0472-9880-802e-b90c-ef7559a2ce56",  # Finance & Admin
    "dashboard_page_id": "3aef0472-9880-8109-b4be-c87e2fb8d286",
    "dashboard_page_url": "https://app.notion.com/p/3aef047298808109b4bec87e2fb8d286",
    # Scheduled fires only run when London local hour matches this hour (a daily
    # S3 guard prevents double-runs). Manual runs ignore both. This keeps the
    # 07:30 London slot correct across the BST/GMT switch even though the outer
    # cron fires in UTC.
    "send_hour_london": 7,
    "llm_signoff": False,
    "llm_model": "claude-haiku-4-5",
}

TEMPLATES = {
    "greeting": "Good morning Matt,",
    "email_intro": "Here is your focus for today.",
    "signoff": "That is the shape of today. Protect the deep-work gaps and start at the top.",
    "needs_clarity_empty": "Nothing ambiguous today — every open task has a clear priority.",
    "radar_empty": "Nothing else on the radar.",
    "top_empty": "No open priorities across the boards today. Enjoy the space.",
}


def _deep_merge(base, over):
    if not isinstance(over, dict) or not isinstance(base, dict):
        return over
    out = dict(base)
    for k, v in over.items():
        out[k] = _deep_merge(base.get(k), v) if isinstance(v, dict) else v
    return out


def load_config(storage_get=None):
    """Return config, deep-merging config/override.json from storage if present."""
    import copy

    cfg = {
        "boards": copy.deepcopy(BOARDS),
        "ranking": copy.deepcopy(RANKING),
        "settings": copy.deepcopy(SETTINGS),
        "templates": copy.deepcopy(TEMPLATES),
    }
    if storage_get is not None:
        try:
            override = storage_get("config/override.json")
            if isinstance(override, dict):
                cfg = _deep_merge(cfg, override)
        except Exception:
            pass  # override is optional
    return cfg
