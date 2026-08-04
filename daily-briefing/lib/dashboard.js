// Writes the "Daily Briefing" dashboard page IN PLACE: every run rebuilds the
// whole page body (clear existing child blocks, then append the freshly rendered
// blocks) and refreshes the title/icon. Rebuilding the entire body each run is
// what guarantees "resend the full page content" — no section is ever left blank
// by a partial update.
import { notionRequest } from './notion.js';
import { sleep } from './matagi.js';

const WRITE_SPACING_MS = 320; // stay comfortably under Notion's rate limit

async function listChildren(conn, pageId) {
  const ids = [];
  let cursor;
  for (let i = 0; i < 50; i++) {
    const qs = cursor ? `?page_size=100&start_cursor=${cursor}` : '?page_size=100';
    const resp = await notionRequest(conn, { method: 'GET', path: `/v1/blocks/${pageId}/children${qs}` });
    if (resp.status >= 400) throw new Error(`list children ${resp.status}: ${JSON.stringify(resp.body).slice(0, 200)}`);
    const data = resp.body || {};
    for (const b of data.results || []) ids.push(b.id);
    if (data.has_more && data.next_cursor) cursor = data.next_cursor;
    else break;
  }
  return ids;
}

export async function updateDashboard(conn, pageId, blocks, { title, icon }) {
  if (!pageId) throw new Error('dashboardPageId not configured');

  // 1) Clear the existing body.
  const existing = await listChildren(conn, pageId);
  for (const id of existing) {
    const resp = await notionRequest(conn, { method: 'DELETE', path: `/v1/blocks/${id}` });
    if (resp.status >= 400 && resp.status !== 404) {
      throw new Error(`delete block ${resp.status}: ${JSON.stringify(resp.body).slice(0, 160)}`);
    }
    await sleep(WRITE_SPACING_MS);
  }

  // 2) Refresh title + icon (idempotent).
  if (title) {
    const resp = await notionRequest(conn, {
      method: 'PATCH',
      path: `/v1/pages/${pageId}`,
      body: {
        icon: icon ? { type: 'emoji', emoji: icon } : undefined,
        properties: { title: { title: [{ type: 'text', text: { content: title } }] } },
      },
    });
    if (resp.status >= 400) throw new Error(`patch page ${resp.status}: ${JSON.stringify(resp.body).slice(0, 200)}`);
    await sleep(WRITE_SPACING_MS);
  }

  // 3) Append the new body in batches of <=100 blocks.
  for (let i = 0; i < blocks.length; i += 100) {
    const batch = blocks.slice(i, i + 100);
    const resp = await notionRequest(conn, {
      method: 'PATCH',
      path: `/v1/blocks/${pageId}/children`,
      body: { children: batch },
    });
    if (resp.status >= 400) throw new Error(`append children ${resp.status}: ${JSON.stringify(resp.body).slice(0, 200)}`);
    await sleep(WRITE_SPACING_MS);
  }
  return { blocks: blocks.length, cleared: existing.length };
}
