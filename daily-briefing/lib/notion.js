// Notion access via the Matagi connection proxy. READ path queries the four task
// boards; a shared notionRequest (with 429 backoff) is reused by the dashboard
// writer. No Notion token ever touches this code — the proxy injects it.
import { proxy, sleep } from './matagi.js';

const NOTION = 'https://api.notion.com';

// One Notion API call through the proxy, with light retry on 429/5xx.
export async function notionRequest(conn, { method, path, version = '2022-06-28', body }) {
  let lastErr;
  for (let attempt = 0; attempt < 4; attempt++) {
    const resp = await proxy(conn.connectionId, {
      method,
      url: `${NOTION}${path}`,
      headers: { 'Notion-Version': version, 'Content-Type': 'application/json' },
      body,
    });
    if (resp.status === 429 || resp.status >= 500) {
      lastErr = new Error(`notion ${resp.status}: ${JSON.stringify(resp.body).slice(0, 200)}`);
      await sleep(800 * (attempt + 1));
      continue;
    }
    return resp; // { status, body }
  }
  throw lastErr || new Error('notion request failed');
}

function selectName(prop) {
  return prop?.select?.name ?? prop?.status?.name ?? null;
}

function titleText(prop) {
  return (prop?.title || []).map((t) => t.plain_text).join('').trim();
}

export function mapPriority(raw) {
  if (!raw) return 'none';
  const s = String(raw).trim();
  if (s.startsWith('1.')) return 'high';
  if (s.startsWith('2.')) return 'mid';
  if (s.startsWith('3.')) return 'low';
  return 'none';
}

function normalize(page, board) {
  const props = page.properties || {};
  const priorityRaw = selectName(props.Priority);
  return {
    id: page.id,
    url: page.url,
    board: board.key,
    label: board.label,
    clientOrInternal: board.clientOrInternal,
    title: titleText(props.Task) || '(untitled)',
    status: selectName(props.Status),
    priorityRaw,
    priority: mapPriority(priorityRaw),
    due: props.Deadline?.date?.start || null,
    lastEdited: page.last_edited_time || null,
  };
}

async function queryEndpoint(conn, path, version, completedStatus) {
  const filter = { property: 'Status', select: { does_not_equal: completedStatus } };
  const results = [];
  let cursor;
  for (let i = 0; i < 25; i++) {
    const body = { filter, page_size: 100 };
    if (cursor) body.start_cursor = cursor;
    const resp = await notionRequest(conn, { method: 'POST', path, version, body });
    if (resp.status >= 400) {
      throw new Error(`notion query ${resp.status}: ${JSON.stringify(resp.body).slice(0, 200)}`);
    }
    const data = resp.body || {};
    results.push(...(data.results || []));
    if (data.has_more && data.next_cursor) cursor = data.next_cursor;
    else break;
  }
  return results;
}

// Query one board's open tasks. Tries the data-source endpoint (new API),
// falls back to the database endpoint (old API). Excludes only the exact
// "✅ Completed" option — never a loose "Completed" match.
export async function queryBoard(conn, board, completedStatus) {
  let pages;
  try {
    pages = await queryEndpoint(
      conn,
      `/v1/data_sources/${board.dataSourceId}/query`,
      '2025-09-03',
      completedStatus,
    );
  } catch (primaryErr) {
    if (!board.databaseId) throw primaryErr;
    pages = await queryEndpoint(
      conn,
      `/v1/databases/${board.databaseId}/query`,
      '2022-06-28',
      completedStatus,
    );
  }
  return pages
    .map((p) => normalize(p, board))
    .filter((t) => t.status !== completedStatus);
}
