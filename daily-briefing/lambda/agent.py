"""Daily Briefing agent core (Python, stdlib only).

Runs inside a Matagi lambda. Talks to the Matagi API with the injected
MATAGI_RESOURCE_API_KEY for: the connection proxy (Notion / Google Calendar /
Gmail — no OAuth token ever touches this code), storage presign (run history),
and optionally an LLM completion for the sign-off line.
"""

import base64
import copy
import datetime as dt
import json
import os
import re
import time
import urllib.error
import urllib.parse
import urllib.request

# --------------------------------------------------------------------------- #
# HTTP + Matagi client
# --------------------------------------------------------------------------- #

API = os.environ.get("MATAGI_API_BASE", "https://api.matagi.ai")
KEY = os.environ.get("MATAGI_RESOURCE_API_KEY", "")


def _http(method, url, headers=None, body=None, timeout=45):
    data = None
    if body is not None:
        data = body if isinstance(body, (bytes, bytearray)) else json.dumps(body).encode("utf-8")
    req = urllib.request.Request(url, data=data, method=method, headers=headers or {})
    try:
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            return resp.status, resp.read()
    except urllib.error.HTTPError as e:
        return e.code, e.read()


def _auth(extra=None):
    h = {"Authorization": f"Bearer {KEY}", "Content-Type": "application/json"}
    if extra:
        h.update(extra)
    return h


def get_connections():
    try:
        return json.loads(os.environ.get("MATAGI_CONNECTIONS_JSON", "[]"))
    except Exception:
        return []


def get_connection(app):
    for c in get_connections():
        if c.get("app") == app:
            return c
    return None


def get_storage():
    try:
        arr = json.loads(os.environ.get("MATAGI_STORAGE_JSON", "[]"))
        return arr[0] if arr else None
    except Exception:
        return None


def proxy(connection_id, method="GET", url=None, headers=None, body=None):
    """Call a third-party app through a shared connection. Returns {status, body}."""
    payload = {"connectionId": connection_id, "method": method, "url": url, "headers": headers or {}}
    if body is not None:
        payload["body"] = body
    status, raw = _http("POST", f"{API}/v1/connections/proxy", headers=_auth(), body=payload)
    if status != 200:
        raise RuntimeError(f"matagi proxy error {status}: {raw[:300]!r}")
    try:
        return json.loads(raw)
    except Exception:
        return {"status": status, "body": raw.decode("utf-8", "replace")}


def llm(messages, model="claude-haiku-4-5", max_tokens=80, temperature=0.4):
    status, raw = _http(
        "POST",
        f"{API}/v1/chat/completions",
        headers=_auth(),
        body={"model": model, "messages": messages, "max_tokens": max_tokens, "temperature": temperature},
    )
    if status != 200:
        raise RuntimeError(f"matagi llm error {status}: {raw[:200]!r}")
    data = json.loads(raw)
    return (data.get("choices") or [{}])[0].get("message", {}).get("content", "") or ""


def _presign(op, key, content_type=None):
    storage = get_storage()
    if not storage:
        raise RuntimeError("no storage bucket shared with this resource")
    body = {"storageResourceId": storage["storageResourceId"], "op": op, "key": key}
    if content_type:
        body["contentType"] = content_type
    status, raw = _http("POST", f"{API}/v1/storage/presign", headers=_auth(), body=body)
    if status != 200:
        raise RuntimeError(f"presign {op} failed {status}: {raw[:200]!r}")
    return json.loads(raw)


def storage_get(key):
    p = _presign("get", key)
    status, raw = _http("GET", p["url"], timeout=30)
    if status == 404:
        return None
    if status >= 300:
        raise RuntimeError(f"storage get failed {status}")
    try:
        return json.loads(raw)
    except Exception:
        return raw.decode("utf-8", "replace")


def storage_put(key, content, content_type="application/json"):
    p = _presign("put", key, content_type)
    body_str = content if isinstance(content, str) else json.dumps(content, indent=2, default=str)
    # multipart/form-data: fields first, then the file.
    boundary = "----matagiboundary" + base64.urlsafe_b64encode(os.urandom(9)).decode()
    parts = []
    for k, v in (p.get("fields") or {}).items():
        parts.append(f"--{boundary}\r\nContent-Disposition: form-data; name=\"{k}\"\r\n\r\n{v}\r\n")
    head = "".join(parts)
    head += (
        f"--{boundary}\r\nContent-Disposition: form-data; name=\"file\"; "
        f"filename=\"{key.split('/')[-1]}\"\r\nContent-Type: {content_type}\r\n\r\n"
    )
    data = head.encode("utf-8") + body_str.encode("utf-8") + f"\r\n--{boundary}--\r\n".encode("utf-8")
    status, raw = _http(
        "POST", p["url"], headers={"Content-Type": f"multipart/form-data; boundary={boundary}"}, body=data
    )
    if status >= 300:
        raise RuntimeError(f"storage upload failed {status}: {raw[:200]!r}")
    return {"key": key}


# --------------------------------------------------------------------------- #
# Time (Europe/London, DST-correct without external tz data)
# --------------------------------------------------------------------------- #

_MONTHS = ["January", "February", "March", "April", "May", "June", "July",
           "August", "September", "October", "November", "December"]
_WEEKDAYS = ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"]


def _last_sunday(year, month):
    if month == 12:
        d = dt.date(year, 12, 31)
    else:
        d = dt.date(year, month + 1, 1) - dt.timedelta(days=1)
    return d - dt.timedelta(days=(d.weekday() - 6) % 7)


def london_offset_minutes(instant_utc):
    """UK clocks: BST (+60) from 01:00 UTC last Sun March to 01:00 UTC last Sun October."""
    y = instant_utc.year
    start = dt.datetime.combine(_last_sunday(y, 3), dt.time(1, 0), tzinfo=dt.timezone.utc)
    end = dt.datetime.combine(_last_sunday(y, 10), dt.time(1, 0), tzinfo=dt.timezone.utc)
    return 60 if start <= instant_utc < end else 0


def london_local(instant_utc):
    return instant_utc + dt.timedelta(minutes=london_offset_minutes(instant_utc))


def date_str(instant_utc):
    return london_local(instant_utc).strftime("%Y-%m-%d")


def time_str(instant_utc):
    return london_local(instant_utc).strftime("%H:%M")


def pretty_date(instant_utc):
    d = london_local(instant_utc)
    return f"{_WEEKDAYS[d.weekday()]}, {d.day} {_MONTHS[d.month - 1]} {d.year}"


def london_wall_to_utc(ymd, hh, mm):
    y, m, d = (int(x) for x in ymd.split("-"))
    naive = dt.datetime(y, m, d, hh, mm, tzinfo=dt.timezone.utc)
    off = london_offset_minutes(naive)
    inst = naive - dt.timedelta(minutes=off)
    off2 = london_offset_minutes(inst)
    if off2 != off:
        inst = naive - dt.timedelta(minutes=off2)
    return inst


def days_between(a, b):
    da = dt.date(*(int(x) for x in a[:10].split("-")))
    db = dt.date(*(int(x) for x in b[:10].split("-")))
    return (db - da).days


def _parse_iso(s):
    if not s:
        return None
    s = s.replace("Z", "+00:00")
    try:
        d = dt.datetime.fromisoformat(s)
    except ValueError:
        return None
    if d.tzinfo is None:
        d = d.replace(tzinfo=dt.timezone.utc)
    return d.astimezone(dt.timezone.utc)


# --------------------------------------------------------------------------- #
# Notion (read-only queries + shared request helper)
# --------------------------------------------------------------------------- #

NOTION = "https://api.notion.com"

# Set per-run from config. When present, Notion is called with a direct
# integration token (we control the Notion-Version header). When absent, calls
# fall back to the Matagi connection proxy — which currently strips custom
# request headers, so Notion rejects them with `missing_version`. The token path
# is therefore the supported way to reach Notion from the lambda.
NOTION_TOKEN = None


def notion_request(conn, method, path, version="2022-06-28", body=None):
    last = None
    for attempt in range(4):
        if NOTION_TOKEN:
            status, raw = _http(
                method,
                f"{NOTION}{path}",
                headers={
                    "Authorization": f"Bearer {NOTION_TOKEN}",
                    "Notion-Version": version,
                    "Content-Type": "application/json",
                },
                body=body,
            )
            try:
                parsed = json.loads(raw)
            except Exception:
                parsed = {"raw": raw.decode("utf-8", "replace")}
            resp = {"status": status, "body": parsed}
        else:
            resp = proxy(
                conn["connectionId"],
                method=method,
                url=f"{NOTION}{path}",
                headers={"Notion-Version": version, "Content-Type": "application/json"},
                body=body,
            )
        st = resp.get("status", 0)
        if st == 429 or st >= 500:
            last = RuntimeError(f"notion {st}: {str(resp.get('body'))[:200]}")
            time.sleep(0.8 * (attempt + 1))
            continue
        return resp
    raise last or RuntimeError("notion request failed")


def map_priority(raw):
    if not raw:
        return "none"
    s = str(raw).strip()
    if s.startswith("1."):
        return "high"
    if s.startswith("2."):
        return "mid"
    if s.startswith("3."):
        return "low"
    return "none"


def _select_name(prop):
    if not prop:
        return None
    if prop.get("select"):
        return prop["select"].get("name")
    if prop.get("status"):
        return prop["status"].get("name")
    return None


def _title_text(prop):
    return "".join(t.get("plain_text", "") for t in (prop or {}).get("title", [])).strip()


def _normalize(page, board):
    props = page.get("properties", {})
    praw = _select_name(props.get("Priority"))
    deadline = props.get("Deadline", {})
    due = (deadline.get("date") or {}).get("start") if deadline else None
    return {
        "id": page.get("id"),
        "url": page.get("url"),
        "board": board["key"],
        "label": board["label"],
        "client_or_internal": board["client_or_internal"],
        "title": _title_text(props.get("Task")) or "(untitled)",
        "status": _select_name(props.get("Status")),
        "priority_raw": praw,
        "priority": map_priority(praw),
        "due": due,
        "last_edited": page.get("last_edited_time"),
    }


def _query_endpoint(conn, path, version, completed_status):
    filt = {"property": "Status", "select": {"does_not_equal": completed_status}}
    results, cursor = [], None
    for _ in range(25):
        body = {"filter": filt, "page_size": 100}
        if cursor:
            body["start_cursor"] = cursor
        resp = notion_request(conn, "POST", path, version, body)
        if resp.get("status", 0) >= 400:
            raise RuntimeError(f"notion query {resp.get('status')}: {str(resp.get('body'))[:200]}")
        data = resp.get("body") or {}
        results.extend(data.get("results") or [])
        if data.get("has_more") and data.get("next_cursor"):
            cursor = data["next_cursor"]
        else:
            break
    return results


def query_board(conn, board, completed_status):
    try:
        pages = _query_endpoint(conn, f"/v1/data_sources/{board['data_source_id']}/query",
                                "2025-09-03", completed_status)
    except Exception:
        if not board.get("database_id"):
            raise
        pages = _query_endpoint(conn, f"/v1/databases/{board['database_id']}/query",
                                "2022-06-28", completed_status)
    tasks = [_normalize(p, board) for p in pages]
    return [t for t in tasks if t["status"] != completed_status]


# --------------------------------------------------------------------------- #
# Calendar -> realistic free working time
# --------------------------------------------------------------------------- #

GCAL = "https://www.googleapis.com/calendar/v3"


def _starts_with_any(text, prefixes):
    t = (text or "").strip().lower()
    return any(t.startswith(str(p).strip().lower()) for p in prefixes)


def _merge(intervals):
    out = []
    for s, e in sorted(intervals):
        if out and s <= out[-1][1]:
            out[-1] = (out[-1][0], max(out[-1][1], e))
        else:
            out.append((s, e))
    return out


def compute_free_time(conn, settings, now_utc):
    tz_today = date_str(now_utc)
    sh, sm = (int(x) for x in settings["work_start"].split(":"))
    eh, em = (int(x) for x in settings["work_end"].split(":"))
    work_start = london_wall_to_utc(tz_today, sh, sm)
    work_end = london_wall_to_utc(tz_today, eh, em)
    window_min = max(0.0, (work_end - work_start).total_seconds() / 60)

    day_start = london_wall_to_utc(tz_today, 0, 0)
    day_end = day_start + dt.timedelta(hours=26)
    params = urllib.parse.urlencode({
        "timeMin": day_start.isoformat().replace("+00:00", "Z"),
        "timeMax": day_end.isoformat().replace("+00:00", "Z"),
        "singleEvents": "true",  # expand recurring events into today's instances
        "orderBy": "startTime",
        "maxResults": "250",
        "showDeleted": "false",
    })
    cal_id = urllib.parse.quote(settings["calendar_id"], safe="")
    resp = proxy(conn["connectionId"], method="GET",
                 url=f"{GCAL}/calendars/{cal_id}/events?{params}",
                 headers={"Content-Type": "application/json"})
    if resp.get("status", 0) >= 400:
        raise RuntimeError(f"calendar {resp.get('status')}: {str(resp.get('body'))[:200]}")

    events = (resp.get("body") or {}).get("items", [])
    buf = (settings.get("meeting_buffer_mins", 0) or 0) * 60
    ws, we = work_start.timestamp(), work_end.timestamp()
    busy, meetings, excluded = [], [], []

    for ev in events:
        summary = ev.get("summary") or "(no title)"
        if ev.get("status") == "cancelled":
            excluded.append({"summary": summary, "reason": "cancelled"}); continue
        self_att = next((a for a in ev.get("attendees", []) if a.get("self")), None)
        if self_att and self_att.get("responseStatus") == "declined":
            excluded.append({"summary": summary, "reason": "declined"}); continue
        start = ev.get("start", {})
        if not start.get("dateTime"):
            excluded.append({"summary": summary, "reason": "all-day"}); continue
        if _starts_with_any(summary, settings.get("admin_block_prefixes", [])):
            excluded.append({"summary": summary, "reason": "admin-block"}); continue
        s_dt = _parse_iso(start.get("dateTime"))
        e_dt = _parse_iso(ev.get("end", {}).get("dateTime"))
        if not s_dt or not e_dt:
            excluded.append({"summary": summary, "reason": "unparseable"}); continue
        clip_s = max(s_dt.timestamp() - buf, ws)
        clip_e = min(e_dt.timestamp() + buf, we)
        if clip_e <= clip_s:
            excluded.append({"summary": summary, "reason": "outside-window"}); continue
        busy.append((clip_s, clip_e))
        meetings.append({
            "summary": summary,
            "start": time_str(s_dt),
            "end": time_str(e_dt),
            "duration_mins": round((e_dt - s_dt).total_seconds() / 60),
        })

    busy_min = sum((e - s) / 60 for s, e in _merge(busy))
    free_min = max(0.0, window_min - busy_min)
    return {
        "window_label": f"{settings['work_start']}–{settings['work_end']}",
        "window_minutes": round(window_min),
        "busy_minutes": round(busy_min),
        "free_minutes": round(free_min),
        "free_hours": round(free_min / 60, 1),
        "meeting_count": len(meetings),
        "meetings": meetings,
        "excluded": excluded,
    }


# --------------------------------------------------------------------------- #
# Ranking
# --------------------------------------------------------------------------- #

_VAGUE = [re.compile(p, re.I) for p in [
    r"^follow[-\s]?ups?$", r"^review$", r"^chase$", r"^check$", r"^catch[-\s]?up$",
    r"^tidy(\s?up)?$", r"^sort(\s?out)?$", r"^prep$", r"^update$", r"^admin$",
]]
_PORDER = {"high": 0, "mid": 1, "low": 2, "none": 3}


def _is_vague(title):
    t = (title or "").strip()
    if not t or t == "(untitled)":
        return True
    return len(t.split()) <= 2 and any(r.match(t) for r in _VAGUE)


def rank_tasks(tasks, ranking, today):
    for t in tasks:
        t["flags"] = []
        t["needs_clarity"] = False
        t["clarity_reason"] = None
        if t["priority"] == "none":
            t["needs_clarity"] = True
            t["clarity_reason"] = "no priority set — what tier is this?"
        elif _is_vague(t["title"]) and not t["due"]:
            t["needs_clarity"] = True
            t["clarity_reason"] = "vague title, no due date — what is the concrete next action?"

        score = 0
        if t["client_or_internal"] == "client":
            score += ranking["client_boost"]; t["flags"].append("client")
        score += ranking["priority_weights"].get(t["priority"], 0)
        if t["priority"] != "none":
            t["flags"].append(t["priority"])

        t["due_in_days"] = None
        if t["due"]:
            days = days_between(today, t["due"])
            t["due_in_days"] = days
            if days < 0:
                score += ranking["overdue_boost"]; t["flags"].append("overdue")
            elif days <= ranking.get("due_soon_window_days", 0):
                score += ranking["due_soon_boost"]; t["flags"].append("due-soon")

        if ranking.get("stale_carryover_boost") and t["last_edited"]:
            age = days_between(t["last_edited"], today)
            if age >= ranking.get("stale_days", 10 ** 9):
                score += ranking["stale_carryover_boost"]; t["flags"].append("stale")

        t["score"] = score

    def sort_key(t):
        return (-t["score"], _PORDER[t["priority"]], t["due_in_days"] if t["due_in_days"] is not None else 9999)

    clear = sorted([t for t in tasks if not t["needs_clarity"]], key=sort_key)
    needs = sorted([t for t in tasks if t["needs_clarity"]], key=sort_key)
    top = clear[: ranking["top_n"]]
    rest = clear[ranking["top_n"]:]
    radar = [t for t in rest if t["priority"] in ("high", "mid")][: ranking["radar_max"]]
    radar_ids = {t["id"] for t in radar}
    lower_count = len([t for t in rest if t["id"] not in radar_ids])
    return {"top": top, "radar": radar, "lower_count": lower_count, "needs_clarity": needs, "all": tasks}


def reason_text(t):
    bits = []
    bits.append({"high": "High", "mid": "Mid", "low": "Low"}.get(t["priority"], "No priority"))
    bits.append("client" if t["client_or_internal"] == "client" else "internal")
    if "overdue" in t["flags"]:
        bits.append(f"overdue by {abs(t['due_in_days'])}d")
    elif "due-soon" in t["flags"]:
        bits.append("due today" if t["due_in_days"] == 0 else f"due in {t['due_in_days']}d")
    if "stale" in t["flags"]:
        bits.append("long-open")
    return " · ".join(bits)


# --------------------------------------------------------------------------- #
# Rendering (Notion blocks + pointer email)
# --------------------------------------------------------------------------- #

def _rt(text):
    return [{"type": "text", "text": {"content": str(text)[:1900]}}]


def _seg(content, url=None):
    t = {"content": str(content)[:1900]}
    if url:
        t["link"] = {"url": url}
    return {"type": "text", "text": t}


def _block(kind, text):
    return {"object": "block", "type": kind, kind: {"rich_text": _rt(text)}}


def _task_line(kind, t, tail):
    # The task title is a clickable link to its Notion page; the tail (label +
    # reason) follows as plain text.
    segs = [_seg(t["title"], t.get("url"))]
    if tail:
        segs.append(_seg(tail))
    return {"object": "block", "type": kind, kind: {"rich_text": segs}}


def _callout(text, emoji):
    return {"object": "block", "type": "callout",
            "callout": {"rich_text": _rt(text), "icon": {"type": "emoji", "emoji": emoji}}}


def _free_line(free):
    if not free or free.get("unavailable"):
        return "Free working time: unavailable (calendar could not be read)."
    mt = "1 meeting" if free["meeting_count"] == 1 else f"{free['meeting_count']} meetings"
    return f"{free['free_hours']}h free ({free['window_label']} window, {mt})"


def render_dashboard_blocks(cfg, now_utc, free, ranked, record):
    s, tpl = cfg["settings"], cfg["templates"]
    blocks = [
        _block("paragraph", f"{pretty_date(now_utc)} · updated {time_str(now_utc)} {s['timezone']}"),
        _callout(f"Estimated free working time — {_free_line(free)}", "⏱️"),
    ]
    if record["missing_sources"]:
        blocks.append(_callout(
            f"Partial brief: could not load {', '.join(record['missing_sources'])}. "
            f"Figures below exclude {'those boards' if len(record['missing_sources']) > 1 else 'that board'}.",
            "⚠️"))

    blocks.append(_block("heading_2", "\U0001f526 Top 3 priorities"))
    if not ranked["top"]:
        blocks.append(_block("paragraph", tpl["top_empty"]))
    else:
        for t in ranked["top"]:
            blocks.append(_task_line("numbered_list_item", t, f"  —  {t['label']}  ·  {reason_text(t)}"))

    blocks.append(_block("heading_2", "\U0001f4e1 Also on your radar"))
    if not ranked["radar"] and ranked["lower_count"] == 0:
        blocks.append(_block("paragraph", tpl["radar_empty"]))
    else:
        for t in ranked["radar"]:
            blocks.append(_task_line("bulleted_list_item", t, f"  —  {t['label']}  ·  {reason_text(t)}"))
        if ranked["lower_count"] > 0:
            plural = "" if ranked["lower_count"] == 1 else "s"
            blocks.append(_block("paragraph", f"Plus {ranked['lower_count']} lower-priority item{plural} parked for now."))

    blocks.append(_block("heading_2", "❓ Needs clarity"))
    if not ranked["needs_clarity"]:
        blocks.append(_block("paragraph", tpl["needs_clarity_empty"]))
    else:
        for t in ranked["needs_clarity"][:15]:
            blocks.append(_task_line("bulleted_list_item", t, f"  —  {t['label']}  ·  {t['clarity_reason']}"))
        if len(ranked["needs_clarity"]) > 15:
            blocks.append(_block("paragraph", f"Plus {len(ranked['needs_clarity']) - 15} more items missing a clear priority."))

    blocks.append({"object": "block", "type": "divider", "divider": {}})
    blocks.append(_block("paragraph", tpl["signoff"]))

    counts = "  ·  ".join(
        f"{b['label'].split(' / ')[0]} {_fmt_count(record['source_counts'].get(b['key']))}" for b in cfg["boards"]
    )
    blocks.append(_block("paragraph", f"Open tasks by board — {counts}  ·  run: {record['trigger']}"))
    return blocks


def _fmt_count(v):
    return "⚠️" if v is None else str(v)


def _ascii_safe(s):
    s = str(s)
    s = s.replace("–", "-").replace("—", "-")
    s = s.replace("‘", "'").replace("’", "'").replace("“", '"').replace("”", '"')
    s = re.sub(r"[^\x00-\x7F]", "", s)
    return re.sub(r"\s+", " ", s).strip()


def render_email(cfg, free, ranked, missing_sources):
    tpl = cfg["templates"]
    lines = [tpl["greeting"], ""]
    if free and not free.get("unavailable"):
        mt = f"{free['meeting_count']} meeting" + ("" if free["meeting_count"] == 1 else "s")
        lines.append(f"Free working time today: {free['free_hours']}h ({mt}).")
    else:
        lines.append("Free working time today: unavailable (calendar not read).")

    if ranked["top"]:
        lines.append("Top 3:")
        for i, t in enumerate(ranked["top"], 1):
            lines.append(f"{i}. {_ascii_safe(t['title'])} - {_ascii_safe(t['label'])}")
    else:
        lines.append(_ascii_safe(tpl["top_empty"]))

    if missing_sources:
        lines.append("")
        lines.append(f"Note: could not load {_ascii_safe(', '.join(missing_sources))} - this brief is partial.")

    lines.append("")
    url = cfg["settings"].get("dashboard_page_url")
    lines.append(f"Full brief: {url}" if url else "Full brief on the Daily Briefing dashboard in Notion.")
    return "\n".join(lines)


# --------------------------------------------------------------------------- #
# Dashboard write (update in place) + Gmail send
# --------------------------------------------------------------------------- #

_WRITE_SPACING = 0.32


def _list_children(conn, page_id):
    ids, cursor = [], None
    for _ in range(50):
        qs = f"?page_size=100&start_cursor={cursor}" if cursor else "?page_size=100"
        resp = notion_request(conn, "GET", f"/v1/blocks/{page_id}/children{qs}")
        if resp.get("status", 0) >= 400:
            raise RuntimeError(f"list children {resp.get('status')}: {str(resp.get('body'))[:200]}")
        data = resp.get("body") or {}
        ids.extend(b["id"] for b in data.get("results", []))
        if data.get("has_more") and data.get("next_cursor"):
            cursor = data["next_cursor"]
        else:
            break
    return ids


def update_dashboard(conn, page_id, blocks, title, icon):
    if not page_id:
        raise RuntimeError("dashboard_page_id not configured")
    existing = _list_children(conn, page_id)
    # Delete the old body concurrently (each notion_request retries on 429), so
    # clearing a full dashboard stays well within the lambda timeout.
    if existing:
        import concurrent.futures

        def _del(bid):
            return notion_request(conn, "DELETE", f"/v1/blocks/{bid}")

        with concurrent.futures.ThreadPoolExecutor(max_workers=6) as ex:
            for resp in ex.map(_del, existing):
                if resp.get("status", 0) >= 400 and resp.get("status") != 404:
                    raise RuntimeError(f"delete block {resp.get('status')}: {str(resp.get('body'))[:160]}")
    if title:
        body = {"properties": {"title": {"title": [{"type": "text", "text": {"content": title}}]}}}
        if icon:
            body["icon"] = {"type": "emoji", "emoji": icon}
        resp = notion_request(conn, "PATCH", f"/v1/pages/{page_id}", body=body)
        if resp.get("status", 0) >= 400:
            raise RuntimeError(f"patch page {resp.get('status')}: {str(resp.get('body'))[:200]}")
        time.sleep(_WRITE_SPACING)
    for i in range(0, len(blocks), 100):
        resp = notion_request(conn, "PATCH", f"/v1/blocks/{page_id}/children", body={"children": blocks[i:i + 100]})
        if resp.get("status", 0) >= 400:
            raise RuntimeError(f"append children {resp.get('status')}: {str(resp.get('body'))[:200]}")
        time.sleep(_WRITE_SPACING)
    return {"blocks": len(blocks), "cleared": len(existing)}


def send_email(conn, to, sender, subject, text):
    headers = [f"To: {to}"]
    if sender:
        headers.append(f"From: {sender}")
    headers += ["Subject: " + subject, "MIME-Version: 1.0",
                'Content-Type: text/plain; charset="UTF-8"', "Content-Transfer-Encoding: 7bit"]
    raw = ("\r\n".join(headers) + "\r\n\r\n" + text).encode("utf-8")
    encoded = base64.urlsafe_b64encode(raw).decode("ascii")
    resp = proxy(conn["connectionId"], method="POST",
                 url="https://gmail.googleapis.com/gmail/v1/users/me/messages/send",
                 headers={"Content-Type": "application/json"}, body={"raw": encoded})
    if resp.get("status", 0) >= 400:
        raise RuntimeError(f"gmail send {resp.get('status')}: {str(resp.get('body'))[:200]}")
    return resp.get("body")


# --------------------------------------------------------------------------- #
# Orchestrator
# --------------------------------------------------------------------------- #

def run_briefing(cfg, trigger="manual"):
    global NOTION_TOKEN
    NOTION_TOKEN = cfg["settings"].get("notion_token") or os.environ.get("NOTION_TOKEN") or None
    now = dt.datetime.now(dt.timezone.utc)
    today = date_str(now)
    record = {
        "run_at": now.isoformat(),
        "date_london": today,
        "trigger": trigger,
        "source_counts": {},
        "missing_sources": [],
        "errors": [],
        "dashboard_write_status": "pending",
        "email_send_status": "pending",
    }
    notion_conn = get_connection("notion")
    cal_conn = get_connection("google_calendar")
    gmail_conn = get_connection("gmail")

    # 1) Tasks per board (guarded independently).
    tasks = []
    for board in cfg["boards"]:
        if not notion_conn:
            record["missing_sources"].append(board["label"]); record["source_counts"][board["key"]] = None; continue
        try:
            bt = query_board(notion_conn, board, cfg["settings"]["completed_status"])
            tasks.extend(bt)
            record["source_counts"][board["key"]] = len(bt)
        except Exception as e:
            record["missing_sources"].append(board["label"])
            record["source_counts"][board["key"]] = None
            record["errors"].append({"where": f"notion:{board['key']}", "message": str(e)})

    # 2) Calendar / realistic free time (guarded).
    free = {"unavailable": True}
    try:
        if not cal_conn:
            raise RuntimeError("no google_calendar connection shared")
        free = compute_free_time(cal_conn, cfg["settings"], now)
    except Exception as e:
        record["errors"].append({"where": "calendar", "message": str(e)})
    record["free_time"] = free

    # 3) Rank.
    ranked = rank_tasks(tasks, cfg["ranking"], today)
    record["task_total"] = len(tasks)
    record["ranked"] = {
        "top": ranked["top"], "radar": ranked["radar"],
        "lower_count": ranked["lower_count"], "needs_clarity": ranked["needs_clarity"],
    }

    # 4) Optional LLM sign-off (never fatal).
    if cfg["settings"].get("llm_signoff"):
        try:
            top = "; ".join(f"{i+1}. {t['title']} ({t['label']})" for i, t in enumerate(ranked["top"]))
            msg = ("Write ONE short warm plain-text sign-off line (max 20 words, no markdown, no emoji) "
                   f"for a PR director's morning briefing. Free time: {free.get('free_hours', 'unknown')}h. "
                   f"Top priorities: {top or 'none'}.")
            out = llm([{"role": "user", "content": msg}], model=cfg["settings"]["llm_model"])
            if out.strip():
                cfg["templates"]["signoff"] = out.strip().strip('"\'')
        except Exception as e:
            record["errors"].append({"where": "llm-signoff", "message": str(e)})

    # 5) Render.
    blocks = render_dashboard_blocks(cfg, now, free, ranked, record)
    email_text = render_email(cfg, free, ranked, record["missing_sources"])
    record["email_body"] = email_text

    # Did any Notion board load? If not (e.g. no token yet), suppress the
    # dashboard write and the pointer email so no empty brief goes out — unless
    # explicitly allowed via settings.email_when_no_notion.
    notion_ok = any(c is not None for c in record["source_counts"].values())
    record["notion_ok"] = notion_ok
    allow_partial = notion_ok or cfg["settings"].get("email_when_no_notion", False)

    # 6) Write dashboard in place (guarded).
    if not notion_ok:
        record["dashboard_write_status"] = "skipped-no-notion"
    else:
        try:
            if not notion_conn and not NOTION_TOKEN:
                raise RuntimeError("no notion access (connection or token)")
            res = update_dashboard(notion_conn, cfg["settings"]["dashboard_page_id"], blocks,
                                   cfg["settings"]["dashboard_title"], cfg["settings"]["dashboard_icon"])
            record["dashboard_write_status"] = "ok"
            record["dashboard_blocks"] = res["blocks"]
        except Exception as e:
            record["dashboard_write_status"] = "failed"
            record["errors"].append({"where": "dashboard", "message": str(e)})

    # 7) Send pointer email (guarded).
    if not allow_partial:
        record["email_send_status"] = "skipped-no-notion"
    else:
        try:
            if not gmail_conn:
                raise RuntimeError("no gmail connection shared")
            info = send_email(gmail_conn, cfg["settings"]["recipient"], cfg["settings"]["sender"],
                              f"Your Morning Briefing - {today}", email_text)
            record["email_send_status"] = "ok"
            record["email_id"] = (info or {}).get("id") if isinstance(info, dict) else None
        except Exception as e:
            record["email_send_status"] = "failed"
            record["errors"].append({"where": "email", "message": str(e)})

    # 8) Persist snapshot (history + latest pointer).
    try:
        key = "runs/" + record["run_at"].replace(":", "-").replace(".", "-") + ".json"
        storage_put(key, record)
        storage_put("runs/latest.json", record)
        record["snapshot_key"] = key
    except Exception as e:
        record["errors"].append({"where": "persist", "message": str(e)})

    return record


def summarize(record):
    return {
        "date": record.get("date_london"),
        "trigger": record.get("trigger"),
        "free_hours": (record.get("free_time") or {}).get("free_hours"),
        "tasks": record.get("task_total"),
        "top": [f"{t['title']} ({t['label']})" for t in (record.get("ranked") or {}).get("top", [])],
        "needs_clarity": len((record.get("ranked") or {}).get("needs_clarity", [])),
        "source_counts": record.get("source_counts"),
        "missing_sources": record.get("missing_sources"),
        "dashboard": record.get("dashboard_write_status"),
        "email": record.get("email_send_status"),
        "errors": record.get("errors"),
    }
