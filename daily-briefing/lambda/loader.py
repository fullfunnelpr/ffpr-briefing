"""Tiny bootstrap loader for the Daily Briefing lambda.

Large base64 zips transit unreliably through the provisioning tools in this
workspace (~14 KB+ frequently fails to unzip). This loader is small enough to
deploy reliably, and it fetches the *real* agent code (handler.py + agent.py +
config.py, as a zip) from the shared storage bucket, uploaded in small,
checksum-verified chunks. That makes every code update deterministic.

Ops (via lambda_execute):
  {"op":"put_chunk","i":<int>,"data":"<b64-of-zip slice>","sha":"<sha256 of data>"}
      -> store one chunk; rejected if the sha doesn't match (resend just that one).
  {"op":"assemble","n":<count>,"sha256":"<sha256 of the whole zip>"}
      -> concat chunks, base64-decode, verify, store boot/app.zip.
  anything else (e.g. {"trigger":"manual"}) -> extract boot/app.zip to /tmp and
      delegate to the real handler.handler(event).
"""

import base64
import hashlib
import importlib
import io
import json
import os
import sys
import urllib.error
import urllib.request
import zipfile

API = os.environ.get("MATAGI_API_BASE", "https://api.matagi.ai")
KEY = os.environ.get("MATAGI_RESOURCE_API_KEY", "")


def _presign(op, key, ct=None):
    sid = json.loads(os.environ["MATAGI_STORAGE_JSON"])[0]["storageResourceId"]
    body = {"storageResourceId": sid, "op": op, "key": key}
    if ct:
        body["contentType"] = ct
    r = urllib.request.Request(API + "/v1/storage/presign", data=json.dumps(body).encode(),
                               method="POST", headers={"Authorization": "Bearer " + KEY,
                                                       "Content-Type": "application/json"})
    return json.loads(urllib.request.urlopen(r).read())


def sget(key):
    p = _presign("get", key)
    try:
        return urllib.request.urlopen(p["url"]).read()
    except urllib.error.HTTPError as e:
        if e.code == 404:
            return None
        raise


def sput(key, data, ct="application/octet-stream"):
    p = _presign("put", key, ct)
    boundary = "----b" + base64.urlsafe_b64encode(os.urandom(9)).decode()
    body = b""
    for k, v in (p.get("fields") or {}).items():
        body += ("--%s\r\nContent-Disposition: form-data; name=\"%s\"\r\n\r\n%s\r\n" % (boundary, k, v)).encode()
    body += ("--%s\r\nContent-Disposition: form-data; name=\"file\"; filename=\"f\"\r\nContent-Type: %s\r\n\r\n"
             % (boundary, ct)).encode()
    body += data + ("\r\n--%s--\r\n" % boundary).encode()
    r = urllib.request.Request(p["url"], data=body, method="POST",
                               headers={"Content-Type": "multipart/form-data; boundary=" + boundary})
    urllib.request.urlopen(r).read()


def handler(event, context=None):
    event = event or {}
    op = event.get("op")

    if op == "put_chunk":
        data = event["data"]
        if event.get("sha") and hashlib.sha256(data.encode()).hexdigest() != event["sha"]:
            return {"ok": False, "i": event.get("i"), "bad_sha": True}
        sput("boot/chunks/%03d" % event["i"], data.encode(), "text/plain")
        return {"ok": True, "i": event["i"]}

    if op == "assemble":
        buf = ""
        for i in range(event["n"]):
            c = sget("boot/chunks/%03d" % i)
            if c is None:
                return {"ok": False, "missing": i}
            buf += c.decode()
        raw = base64.b64decode(buf)
        got = hashlib.sha256(raw).hexdigest()
        if event.get("sha256") and got != event["sha256"]:
            return {"ok": False, "assembled_sha": got, "expected": event["sha256"]}
        sput("boot/app.zip", raw, "application/zip")
        return {"ok": True, "bytes": len(raw), "sha256": got}

    raw = sget("boot/app.zip")
    if raw is None:
        return {"ok": False, "error": "app.zip not assembled yet"}
    with zipfile.ZipFile(io.BytesIO(raw)) as z:
        z.extractall("/tmp/pkg")
    if "/tmp/pkg" not in sys.path:
        sys.path.insert(0, "/tmp/pkg")
    for m in ("handler", "agent", "config"):
        if m in sys.modules:
            importlib.reload(sys.modules[m])
    import handler as real
    return real.handler(event, context)
