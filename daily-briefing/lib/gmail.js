// Sends the short pointer email via the Gmail API through the Matagi proxy.
import { proxy } from './matagi.js';

function buildRaw({ to, from, subject, text }) {
  const headers = [
    `To: ${to}`,
    from ? `From: ${from}` : null,
    `Subject: ${subject}`,
    'MIME-Version: 1.0',
    'Content-Type: text/plain; charset="UTF-8"',
    'Content-Transfer-Encoding: 7bit',
  ].filter(Boolean);
  return `${headers.join('\r\n')}\r\n\r\n${text}`;
}

export async function sendEmail(conn, { to, from, subject, text }) {
  const raw = Buffer.from(buildRaw({ to, from, subject, text }), 'utf8').toString('base64url');
  const resp = await proxy(conn.connectionId, {
    method: 'POST',
    url: 'https://gmail.googleapis.com/gmail/v1/users/me/messages/send',
    headers: { 'Content-Type': 'application/json' },
    body: { raw },
  });
  if (resp.status >= 400) {
    throw new Error(`gmail send ${resp.status}: ${JSON.stringify(resp.body).slice(0, 200)}`);
  }
  return resp.body; // { id, threadId, labelIds }
}
