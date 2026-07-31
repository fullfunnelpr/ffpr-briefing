// Thin runtime client for the Matagi API (https://api.matagi.ai).
// Everything here is callable from inside a provisioned Vercel/lambda resource:
// the resource's MATAGI_RESOURCE_API_KEY authorizes LLM calls, the connection
// proxy (so no third-party OAuth token ever reaches this code), and storage
// presign. Connections and storage buckets shared with the resource are exposed
// as JSON in the environment.

const API = process.env.MATAGI_API_BASE || 'https://api.matagi.ai';
const KEY = process.env.MATAGI_RESOURCE_API_KEY || '';

function authHeaders(extra = {}) {
  return { Authorization: `Bearer ${KEY}`, 'Content-Type': 'application/json', ...extra };
}

export function getConnections() {
  try {
    return JSON.parse(process.env.MATAGI_CONNECTIONS_JSON || '[]');
  } catch {
    return [];
  }
}

// Find a shared connection by app slug, e.g. 'notion', 'gmail', 'google_calendar'.
export function getConnection(app) {
  const conns = getConnections();
  return conns.find((c) => c.app === app) || null;
}

export function getStorage() {
  try {
    const arr = JSON.parse(process.env.MATAGI_STORAGE_JSON || '[]');
    return arr[0] || null;
  } catch {
    return null;
  }
}

// Call a third-party app through a shared connection. Returns the third-party
// response as { status, body } where status is the third-party HTTP status
// (this call resolves as long as Matagi itself accepted the request).
export async function proxy(connectionId, { method = 'GET', url, headers = {}, body } = {}) {
  if (!connectionId) throw new Error('proxy: missing connectionId');
  const payload = { connectionId, method, url, headers };
  if (body !== undefined) payload.body = body;
  const res = await fetch(`${API}/v1/connections/proxy`, {
    method: 'POST',
    headers: authHeaders(),
    body: JSON.stringify(payload),
  });
  const text = await res.text();
  if (!res.ok) {
    throw new Error(`matagi proxy error ${res.status}: ${text.slice(0, 300)}`);
  }
  try {
    return JSON.parse(text);
  } catch {
    return { status: res.status, body: text };
  }
}

// OpenAI-compatible chat completion on the platform's keys (billed to this
// resource's company). Returns the assistant message text.
export async function llm({ model = 'claude-haiku-4-5', messages, max_tokens = 400, temperature = 0.3 } = {}) {
  const res = await fetch(`${API}/v1/chat/completions`, {
    method: 'POST',
    headers: authHeaders(),
    body: JSON.stringify({ model, messages, max_tokens, temperature }),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`matagi llm error ${res.status}: ${JSON.stringify(data).slice(0, 300)}`);
  return data.choices?.[0]?.message?.content || '';
}

// --- Storage (S3 via presign). Objects are JSON unless a string is passed. ---

async function presign(op, key, contentType) {
  const storage = getStorage();
  if (!storage) throw new Error('storage: no bucket shared with this resource');
  const body = { storageResourceId: storage.storageResourceId, op, key };
  if (contentType) body.contentType = contentType;
  const res = await fetch(`${API}/v1/storage/presign`, {
    method: 'POST',
    headers: authHeaders(),
    body: JSON.stringify(body),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`presign ${op} failed ${res.status}: ${JSON.stringify(data).slice(0, 200)}`);
  return data;
}

export async function storagePut(key, content, contentType = 'application/json') {
  const p = await presign('put', key, contentType);
  const bodyStr = typeof content === 'string' ? content : JSON.stringify(content, null, 2);
  const form = new FormData();
  for (const [k, v] of Object.entries(p.fields || {})) form.append(k, v);
  form.append('file', new Blob([bodyStr], { type: contentType }));
  const up = await fetch(p.url, { method: 'POST', body: form });
  if (!up.ok) {
    const t = await up.text().catch(() => '');
    throw new Error(`storage upload failed ${up.status}: ${t.slice(0, 200)}`);
  }
  return { key };
}

export async function storageGet(key) {
  const p = await presign('get', key);
  const res = await fetch(p.url, { method: 'GET' });
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`storage get failed ${res.status}`);
  const text = await res.text();
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

export function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}
