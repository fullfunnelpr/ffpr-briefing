export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') return res.status(204).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const { company, contact, clientEmail, verdict, coveringNote, draft, stage1Summary, gapSummary } = req.body;

  // Build the email body
  const emailBody = `${coveringNote}

─────────────────────────────────────────────
PRESS RELEASE DRAFT
─────────────────────────────────────────────

${draft}

─────────────────────────────────────────────
FULL BRIEFING SUMMARY
─────────────────────────────────────────────

Client: ${company}${contact ? ' (' + contact + ')' : ''}
Client email: ${clientEmail}
Verdict: ${verdict}

STAGE 1 ANSWERS:
${stage1Summary}

STAGE 2 — ADDITIONAL INFORMATION:
${gapSummary || 'None provided.'}
`;

  const notionWebhookUrl = process.env.NOTION_WEBHOOK_URL;

  // Fire Zapier/webhook to create Gmail draft — Zapier receives the payload
  // and creates the draft in Matt's Gmail via its Gmail integration.
  // If no webhook URL is set, we fall back gracefully.
  if (notionWebhookUrl) {
    try {
      await fetch(notionWebhookUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          to: clientEmail,
          from: 'matt@mattphillipspr.com',
          subject: `DRAFT FOR REVIEW: ${company} press release`,
          body: emailBody,
          company,
          contact,
          clientEmail,
          verdict,
        }),
      });
    } catch (e) {
      console.error('Webhook failed:', e.message);
    }
  }

  return res.status(200).json({ ok: true });
}
