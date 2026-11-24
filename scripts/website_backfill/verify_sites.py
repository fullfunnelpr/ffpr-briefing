#!/usr/bin/env python3
"""
verify_sites.py  -  Find and verify official company homepages.

Given a JSON list of companies, this script tries a ranked set of candidate
URLs for each one and verifies them with a real HTTP request (via curl):
it follows redirects, confirms a 200, and checks that the company name (or an
obvious token of it) appears in the page title or body. It records the final
URL after redirects, reduced to the https root (scheme + host, no path).

It is deliberately standalone and rerunnable, so it can be pointed at new rows
later. Notion reads/writes are done by the operator (the Notion MCP tools), not
by this script - it only resolves and verifies URLs.

INPUT  (--input, required): JSON list of objects, each with at least:
    { "page_id": "...", "company": "Acme Ltd", "campus": "...",
      "stage": "...", "what": "...", "hints": "free text that may name a domain" }
CANDIDATES (--candidates, optional): JSON object mapping page_id (or company)
    -> candidate URL or list of URLs. Use this to feed in search-found homepages
    for companies the name-guessing could not resolve. These are tried first.
OUTPUT (--output): JSON list of result objects (see build_result).

Verification statuses:
    verified             200 + company name matched in title/body/host
    resolves_no_match    200 but name not found (parked page / wrong co - review)
    unresolved           no candidate returned a usable 200

Usage:
    python3 verify_sites.py --input input.json --output results.json
    python3 verify_sites.py --input input.json --candidates cand.json \
            --output results.json --only-missing results.json
"""
import argparse, json, re, subprocess, sys, time, os
from urllib.parse import urlsplit

TLDS = ["com", "co.uk", "io", "ai", "bio", "space", "tech", "net", "eu", "org", "world", "uk"]
DOMAIN_RE = re.compile(r'\b([a-z0-9][a-z0-9-]{1,}(?:\.[a-z0-9-]+)*\.(?:com|co\.uk|io|ai|bio|space|tech|net|eu|org|world|uk))\b', re.I)
LEGAL = {"ltd","limited","plc","llp","llc","inc","incorporated","corp","corporation",
         "company","co","group","holdings","international","europe","uk","gmbh","sa","sarl",
         "the","and","of","for","a"}
STOP = {"services","solutions","systems","technologies","technology","global","worldwide",
        "consulting","consultancy","associates","partners","laboratories","laboratory",
        "research","pharmaceuticals","pharma","therapeutics","bioinnovation","sciences",
        "science","instruments","industries","digital","labs","lab"}

def slug(s):
    return re.sub(r'[^a-z0-9]+','', s.lower())

def name_tokens(company):
    c = re.sub(r'\(.*?\)',' ', company.lower())
    c = re.sub(r'[^a-z0-9 ]+',' ', c)
    toks = [t for t in c.split() if t and t not in LEGAL]
    core = [t for t in toks if t not in STOP and len(t) >= 3]
    return toks, (core or toks)

def candidate_urls(row, no_guess=False):
    """Ranked candidate URLs: hint domains, then name guesses."""
    cands = []
    seen = set()
    def add(u):
        u = u.strip().rstrip('/')
        if not u: return
        if not u.startswith("http"): u = "https://" + u
        host = urlsplit(u).netloc.lower()
        key = host.replace("www.","")
        if key and key not in seen:
            seen.add(key); cands.append(u)
    # 1. explicit domains named in hints (email domains / site mentions)
    for m in DOMAIN_RE.findall(row.get("hints","") or ""):
        add("https://"+m.lower())
    # 2. name-based guesses
    if no_guess:
        return cands
    toks, core = name_tokens(row["company"])
    bases = []
    if toks:
        bases.append("".join(toks))              # fullconcat
        bases.append(toks[0])                    # firstword
        if len(toks) >= 2: bases.append(toks[0]+toks[1])
        bases.append("-".join(toks))             # hyphenated
        if core and core != toks:
            bases.append("".join(core)); bases.append(core[0])
    # de-dup bases preserving order
    bb = []
    for b in bases:
        if b and b not in bb: bb.append(b)
    for b in bb[:4]:
        for tld in TLDS:
            add(f"https://{b}.{tld}")
    return cands

def curl_head(url, timeout=30):
    """Follow redirects; return (final_url, http_code) or (None, '000')."""
    try:
        out = subprocess.run(
            ["curl","-sS","-o","/dev/null","-L","--max-time",str(timeout),
             "-A","Mozilla/5.0 (compatible; FFPR-site-check/1.0)",
             "-w","%{url_effective} %{http_code}", url],
            capture_output=True, text=True, timeout=timeout+5)
        parts = (out.stdout or "").strip().split()
        if len(parts) >= 2:
            return parts[0], parts[1]
    except Exception:
        pass
    return None, "000"

def curl_body(url, timeout=30, cap=60000):
    try:
        out = subprocess.run(
            ["curl","-sS","-L","--max-time",str(timeout),
             "-A","Mozilla/5.0 (compatible; FFPR-site-check/1.0)", url],
            capture_output=True, text=True, timeout=timeout+5)
        return (out.stdout or "")[:cap]
    except Exception:
        return ""

def title_of(html):
    m = re.search(r'<title[^>]*>(.*?)</title>', html, re.I|re.S)
    return re.sub(r'\s+',' ', m.group(1)).strip()[:200] if m else ""

def visible_text(html):
    html = re.sub(r'<(script|style)[^>]*>.*?</\1>',' ', html, flags=re.I|re.S)
    return re.sub(r'<[^>]+>',' ', html)

def root_of(url):
    p = urlsplit(url)
    return f"https://{p.netloc}"

def name_match(company, final_url, title, body):
    toks, core = name_tokens(company)
    host = urlsplit(final_url).netloc.lower()
    hay = (title + " " + body[:8000]).lower()
    host_slug = slug(host)
    # strong: a core token present in title/body, or host contains a core token
    for t in core:
        if t in hay: return True, f"token '{t}' in page"
    for t in core:
        if len(t) >= 4 and t in host_slug: return True, f"token '{t}' in domain"
    # whole-name concatenation inside host (e.g. liohealth)
    full = "".join(toks)
    if len(full) >= 5 and full in host_slug: return True, "name in domain"
    return False, ""

def build_result(row, tried, best):
    r = {"page_id": row["page_id"], "company": row["company"], "campus": row["campus"],
         "stage": row["stage"], "what": row.get("what",""), "tried": tried}
    if best:
        r.update({"status": "verified" if best["match"] else "resolves_no_match",
                  "url": root_of(best["final"]), "final_url": best["final"],
                  "http_code": best["code"], "redirected": best["redirected"],
                  "title": best["title"], "evidence": best["evidence"]})
    else:
        r.update({"status": "unresolved", "url": "", "http_code": "", "title": "", "evidence": ""})
    return r

def resolve_row(row, candidates_map, sleep, no_guess=False):
    cands = []
    # operator-supplied candidates first
    extra = candidates_map.get(row["page_id"]) or candidates_map.get(row["company"]) or []
    if isinstance(extra, str): extra = [extra]
    for u in extra:
        uu = u if u.startswith("http") else "https://"+u
        cands.append(uu.rstrip('/'))
    # With no_guess, test ONLY the operator-supplied candidate(s) - no hint
    # domains or name guesses - so a result reflects exactly that URL.
    if not no_guess:
        cands += candidate_urls(row)
    # de-dup preserving order
    seen=set(); ordered=[]
    for u in cands:
        k=urlsplit(u).netloc.lower().replace("www.","")
        if k and k not in seen: seen.add(k); ordered.append(u)

    tried=[]; best=None
    for u in ordered[:16]:
        final, code = curl_head(u)
        time.sleep(sleep)
        rec={"cand":u,"final":final,"code":code}
        if code=="200" and final:
            html=curl_body(final); time.sleep(sleep)
            title=title_of(html); body=visible_text(html)
            ok,ev=name_match(row["company"], final, title, body)
            cand={"final":final,"code":code,"match":ok,"title":title,"evidence":ev,
                  "redirected": root_of(final)!=root_of(u)}
            rec["match"]=ok
            if ok:
                best=cand; tried.append(rec); break      # first strong match wins
            if best is None:
                best=cand                                 # keep a 200 as fallback
        tried.append(rec)
    return build_result(row, tried, best)

def main():
    ap=argparse.ArgumentParser()
    ap.add_argument("--input",required=True)
    ap.add_argument("--candidates",default="")
    ap.add_argument("--output",required=True)
    ap.add_argument("--only-missing",default="",
                    help="path to a prior results.json; skip page_ids already 'verified'")
    ap.add_argument("--campus",default="",help="limit to one campus")
    ap.add_argument("--no-guess",action="store_true",
                    help="test only operator-supplied candidates (no hint/name guessing)")
    ap.add_argument("--sleep",type=float,default=0.4)
    a=ap.parse_args()

    rows=json.load(open(a.input))
    if a.campus: rows=[r for r in rows if r["campus"]==a.campus]
    cand_map=json.load(open(a.candidates)) if a.candidates and os.path.exists(a.candidates) else {}

    done={}
    if a.only_missing and os.path.exists(a.only_missing):
        for r in json.load(open(a.only_missing)):
            done[r["page_id"]]=r
    results=[]
    total=len(rows)
    for i,row in enumerate(rows,1):
        if done.get(row["page_id"],{}).get("status")=="verified":
            results.append(done[row["page_id"]])
            print(f"[{i}/{total}] {row['company'][:40]:40} SKIP (already verified)",flush=True)
            continue
        res=resolve_row(row, cand_map, a.sleep, a.no_guess)
        results.append(res)
        json.dump(results,open(a.output,"w"),indent=1,ensure_ascii=False)   # incremental save
        print(f"[{i}/{total}] {row['company'][:40]:40} {res['status']:17} {res.get('url','')}",flush=True)
    # summary
    from collections import Counter
    c=Counter(r["status"] for r in results)
    print("\nSUMMARY:",dict(c),flush=True)

if __name__=="__main__":
    main()
