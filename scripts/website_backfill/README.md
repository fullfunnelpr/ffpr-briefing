# Website backfill

Tooling to find and verify official company homepages for the Notion prospecting
database **Milton Park & Harwell — Occupiers**, and fill in the `Website`
property for rows that are missing it.

The script only resolves and verifies URLs. Reading the database and writing the
`Website` values back is done with the Notion MCP tools by whoever runs the task,
so that the write step stays auditable and never touches other properties.

## What `verify_sites.py` does

For each company it builds a ranked list of candidate URLs:

1. Domains named in the row's `hints` text (an email domain in the Contact
   field, or a domain written in the Notes — these are the strongest signal).
2. Candidate URLs supplied by the operator in a `--candidates` file (used to
   feed in homepages found by web search for companies the guessing can't reach).
3. Guesses built from the company name (full concatenation, first word, first
   two words, hyphenated) across common TLDs (`.com`, `.co.uk`, `.io`, `.ai`,
   `.bio`, `.space`, `.tech`, `.net`, `.eu`, `.org`, `.world`, `.uk`).

Each candidate is checked with a real HTTP request (`curl`), following
redirects. A candidate counts as **verified** when it returns `200` *and* a
token of the company name appears in the page `<title>`/body or in the final
domain. The result records the final URL after redirects, reduced to the
`https` root (scheme + host, no path), as required by the brief.

Statuses:

| status | meaning |
| --- | --- |
| `verified` | 200 + company name matched — safe to write |
| `resolves_no_match` | 200 but the name was not found (parked page / namesake) — review, do not write blind |
| `unresolved` | no candidate returned a usable 200 — needs web-search discovery |

Requests are rate-limited (`--sleep`, default 0.4s between calls) and results are
written incrementally, so a long run can be interrupted and resumed.

## Running it

```bash
# first pass: hints + name guesses
python3 verify_sites.py --input input.json --output results.json

# second pass: after adding search-found candidates for the misses,
# keep the already-verified rows and only retry the rest
python3 verify_sites.py --input input.json --candidates candidates.json \
        --output results.json --only-missing results.json

# limit to one campus, be gentler on rate
python3 verify_sites.py --input input.json --output results.json \
        --campus "Milton Park" --sleep 0.6
```

### Input format

`input.json` is a JSON list; each object needs `page_id`, `company`, `campus`,
`stage`, `what`, `hints`:

```json
[
  { "page_id": "388f0472...", "company": "Crowcon Detection Instruments",
    "campus": "Milton Park", "stage": "To contact",
    "what": "Gas-detection instruments",
    "hints": "graham.jardine@crowcon.com Abingdon Halma plc" }
]
```

`candidates.json` (optional) maps `page_id` or company name to a URL or list of
URLs to try first:

```json
{ "388f0472...": "https://avaxmed.com", "Some Company": ["https://example.com"] }
```

## Rebuilding the input from Notion (for new rows later)

1. Query the data source for in-scope rows: `Core = "Core"`, `Stage != "Not now"`,
   `Website` empty. (SQL/rows mode, or the Default view read in view mode and
   filtered client-side.)
2. For each row emit `page_id` (the page URL's last segment), `company`,
   `campus`, `stage`, `what`, and `hints` = Contact + Notes + What-they-do.
3. Run the two passes above.
4. Write each `verified` result's `url` into the row's `Website` property with
   `notion-update-page` (command `update_properties`, `{ "Website": "<url>" }`).
   Never overwrite an existing `Website`; never change other properties.

## Verification note

A `verified` result is a live `200` on the final URL with a name match. It is
not a judgement that the company is still trading or that the domain is their
primary brand — only that the page resolves and corresponds to the company.
Material findings (renames, acquisitions, moves) are recorded separately in the
run report, not written to the database.
