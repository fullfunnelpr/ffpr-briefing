export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') return res.status(204).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const { company, contact, clientEmail, verdict, coveringNote, draft, stage1Summary, gapSummary } = req.body;

  // Strip markdown formatting as a safety net
  function stripMarkdown(text) {
    return (text || '')
      .replace(/\*\*(.+?)\*\*/g, '$1')
      .replace(/\*(.+?)\*/g, '$1')
      .replace(/#{1,6}\s+/g, '')
      .replace(/^[-*]\s+/gm, '')
      .trim();
  }

  function textToHtml(text) {
    const clean = stripMarkdown(text);
    return clean
      .split(/\n{2,}/)
      .map(block => block.trim())
      .filter(block => block.length > 0)
      .map(block => `<p style="margin:0 0 12px 0;">${block.replace(/\n/g, '<br>')}</p>`)
      .join('');
  }

  function draftToHtml(text) {
    const clean = stripMarkdown(text);
    const lines = clean.split('\n');
    let html = '';
    let headlinesDone = 0;
    for (const line of lines) {
      const t = line.trim();
      if (!t) { html += '<br>'; continue; }
      if (t.startsWith('FOR IMMEDIATE') || t.startsWith('EMBARGO')) {
        html += `<p style="margin:0 0 16px 0;font-size:12px;color:#888;text-transform:uppercase;letter-spacing:0.06em;">${t}</p>`;
      } else if (t === 'ENDS') {
        html += `<p style="margin:16px 0;font-weight:700;color:#0d0d0d;">ENDS</p>`;
      } else if (t.startsWith('Notes to editor') || t.startsWith('About ') || t.startsWith('Spokesperson') || t.startsWith('For more information')) {
        html += `<p style="margin:0 0 8px 0;font-size:13px;color:#2e2e2e;">${t}</p>`;
      } else if (headlinesDone < 2 && t.length < 130) {
        headlinesDone++;
        html += `<p style="margin:0 0 12px 0;font-weight:700;font-size:${headlinesDone === 1 ? '17' : '14'}px;color:#0d0d0d;">${t}</p>`;
      } else {
        html += `<p style="margin:0 0 12px 0;">${t}</p>`;
      }
    }
    return html;
  }

  const cleanCovering = stripMarkdown(coveringNote);
  const cleanDraft = stripMarkdown(draft);

  // Extract verdict type for Notion select field
  let notionVerdict = '🪴 POT';
  if (verdict && verdict.includes('HOT')) notionVerdict = '🔥 HOT';
  else if (verdict && verdict.includes('BOT')) notionVerdict = '🤖 BOT';
  else if (verdict && verdict.includes('NOT')) notionVerdict = '🤔 NOT';

  const htmlBody = `<!DOCTYPE html>
<html><head><meta charset="UTF-8" /></head>
<body style="font-family:'Helvetica Neue',Helvetica,Arial,sans-serif;font-size:14px;color:#1a1a1a;line-height:1.7;background:#ffffff;margin:0;padding:0;">
<div style="max-width:620px;margin:0 auto;padding:32px 24px;">
  <div style="border-bottom:3px solid #F04E23;padding-bottom:16px;margin-bottom:28px;">
    <span style="font-family:Arial Black,sans-serif;font-size:15px;font-weight:900;color:#0d0d0d;">Full Funnel <span style="color:#F04E23;">PR</span></span>
  </div>
  <div style="display:inline-block;background:#fff3ef;color:#F04E23;font-size:11px;font-weight:700;letter-spacing:0.08em;text-transform:uppercase;padding:4px 10px;border-radius:20px;margin-bottom:20px;">Draft for review</div>
  <p style="font-family:Arial,sans-serif;font-size:10px;font-weight:700;letter-spacing:0.1em;text-transform:uppercase;color:#F04E23;border-bottom:1px solid #e2e2e2;padding-bottom:8px;margin:0 0 16px 0;">Covering note</p>
  <div style="background:#fff3ef;border-left:3px solid #F04E23;border-radius:6px;padding:16px 20px;margin-bottom:28px;font-size:14px;color:#1a1a1a;">${textToHtml(cleanCovering)}</div>
  <p style="font-family:Arial,sans-serif;font-size:10px;font-weight:700;letter-spacing:0.1em;text-transform:uppercase;color:#F04E23;border-bottom:1px solid #e2e2e2;padding-bottom:8px;margin:32px 0 16px 0;">Press release draft</p>
  <div style="background:#f8f7f5;border:1px solid #e2e2e2;border-radius:8px;padding:20px 24px;font-size:14px;color:#1a1a1a;font-family:Georgia,serif;line-height:1.85;">${draftToHtml(cleanDraft)}</div>
  <p style="font-family:Arial,sans-serif;font-size:10px;font-weight:700;letter-spacing:0.1em;text-transform:uppercase;color:#F04E23;border-bottom:1px solid #e2e2e2;padding-bottom:8px;margin:32px 0 16px 0;">Briefing summary</p>
  <div style="background:#f8f7f5;border:1px solid #e2e2e2;border-radius:8px;padding:16px 20px;font-size:13px;color:#2e2e2e;">
    <p style="margin:0 0 6px 0;"><strong>Client:</strong> ${company}${contact ? ' (' + contact + ')' : ''}</p>
    <p style="margin:0 0 6px 0;"><strong>Email:</strong> ${clientEmail}</p>
    <p style="margin:0 0 16px 0;"><strong>Verdict:</strong> ${verdict}</p>
    <p style="margin:0 0 8px 0;"><strong>Stage 1 answers:</strong></p>
    ${textToHtml(stage1Summary)}
    ${gapSummary ? `<p style="margin:12px 0 8px 0;"><strong>Stage 2 additions:</strong></p>${textToHtml(gapSummary)}` : ''}
  </div>
  <div style="margin-top:40px;padding-top:16px;border-top:1px solid #e2e2e2;font-size:12px;color:#888888;">
    Sent automatically by the Full Funnel PR briefing tool &mdash; matt@mattphillipspr.com
  </div>
</div>
</body></html>`;

  const plainBody = `${cleanCovering}\n\n---\nPRESS RELEASE DRAFT\n---\n\n${cleanDraft}\n\n---\nClient: ${company}\nEmail: ${clientEmail}\nVerdict: ${verdict}\n\n${stage1Summary}${gapSummary ? '\n\nStage 2:\n' + gapSummary : ''}`;

  const today = new Date().toISOString().split('T')[0];

  // ── Notion write-back (direct API) ──
  const notionKey = process.env.NOTION_API_KEY;
  const notionDsId = '559e781f-5953-4a7c-bf29-20ee9a8e286e';

  if (notionKey) {
    try {
      await fetch('https://api.notion.com/v1/pages', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${notionKey}`,
          'Notion-Version': '2022-06-28',
        },
        body: JSON.stringify({
          parent: { database_id: notionDsId },
          properties: {
            Company: { title: [{ text: { content: company || '' } }] },
            'Contact Name': { rich_text: [{ text: { content: contact || '' } }] },
            'Client Email': { email: clientEmail || null },
            Verdict: { select: { name: notionVerdict } },
            Status: { select: { name: 'Brief received' } },
            Submitted: { date: { start: today } },
            'Provisional Angle': { rich_text: [{ text: { content: (verdict || '').slice(0, 2000) } }] },
            'Stage 1 Summary': { rich_text: [{ text: { content: (stage1Summary || '').slice(0, 2000) } }] },
            'Stage 2 Additions': { rich_text: [{ text: { content: (gapSummary || '').slice(0, 2000) } }] },
            Draft: { rich_text: [{ text: { content: cleanDraft.slice(0, 2000) } }] },
          },
        }),
      });
    } catch (e) {
      console.error('Notion write failed:', e.message);
    }
  }

  // ── Zapier webhook → Gmail draft ──
  const webhookUrl = process.env.NOTION_WEBHOOK_URL;
  if (webhookUrl) {
    try {
      await fetch(webhookUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          to: clientEmail,
          from: 'matt@mattphillipspr.com',
          subject: `DRAFT FOR REVIEW: ${company} press release`,
          body: plainBody,
          htmlBody,
          company,
          contact,
          clientEmail,
          verdict,
        }),
      });
    } catch (e) {
      console.error('Zapier webhook failed:', e.message);
    }
  }

  return res.status(200).json({ ok: true });
}
