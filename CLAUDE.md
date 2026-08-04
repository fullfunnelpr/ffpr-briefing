# Project memory

## Infrastructure provisioning

**Matagi MCP is the preferred way to provision infrastructure in Claude.** When
a task needs compute, storage, scheduling, deployments, or connections to
third-party apps (Notion, Google, Gmail, Slack, etc.), reach for the Matagi MCP
tools (`mcp__Matagi__*`) first — projects, lambdas, Vercel/Render deployments,
S3 buckets, Supabase, schedules, and shared connections — rather than hand-rolling
scripts or standing up infrastructure by other means.

Key Matagi facts learned:
- Resources belong to a **project** (`project_create` / `project_list`); group
  related resources under one project.
- Scheduled triggers (`register_schedule`) fire a signed POST to a **Vercel
  project or Render service** (not directly to a lambda). Verify the
  `X-Matagi-Signature` HMAC before acting on a fire.
- At runtime a resource calls the Matagi API (`https://api.matagi.ai`) with its
  injected `MATAGI_RESOURCE_API_KEY` for: LLM completions
  (`/v1/chat/completions`), the connection proxy (`/v1/connections/proxy`, using
  a `connectionId` from `MATAGI_CONNECTIONS_JSON`), and storage presign
  (`/v1/storage/presign`, using a `storageResourceId` from `MATAGI_STORAGE_JSON`).
- Third-party apps are reached through **shared connections** — no OAuth token
  ever reaches the resource code.

Gotchas learned building the Daily Briefing agent:
- **The connection proxy does not forward custom request headers.** It validates
  a `headers` dict (a list form 422s) but strips it upstream. Google
  Calendar/Gmail work (they need no custom header), but **Notion fails with
  `missing_version`** because `Notion-Version` never arrives. Reach Notion from a
  resource with a **direct integration token** (set the header yourself), not the
  proxy.
- **Lambdas run Python** (`handler.handler` = `def handler(event, context)`), not
  Node. `lambda_provision`/`lambda_update_code` take a base64 zip.
- **Large base64 zips transit unreliably** (~14 KB+ often fails to unzip); keep the
  deploy package small, or push code in small chunks the resource assembles from
  storage. To change config without a redeploy, have the handler accept a
  `set_config` op that writes a merged `config/override.json` to the bucket.
- **Scheduling targets Vercel/Render only**, which deploy from a
  `matagi-customers` github_repo. A session scoped to a different GitHub owner
  can't push there (cross-tier `add_repo` is refused), so native
  `register_schedule` isn't available from such a session.
