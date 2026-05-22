export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') return res.status(204).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const { company, contact, clientEmail, verdict, coveringNote, draft, stage1Summary, gapSummary } = req.body;

  // Strip markdown formatting as a safety net
  function stripMarkdown(text) {
    return text
      .replace(/\*\*(.+?)\*\*/g, '$1')   // **bold**
      .replace(/\*(.+?)\*/g, '$1')         // *italic*
      .replace(/#{1,6}\s+/g, '')            // ## headings
      .replace(/^[-*]\s+/gm, '')            // bullet points
      .trim();
  }

  // Convert plain text paragraphs to HTML paragraphs
  function textToHtml(text) {
    const clean = stripMarkdown(text);
    return clean
      .split(/\n{2,}/)
      .map(block => block.trim())
      .filter(block => block.length > 0)
      .map(block => {
        // Preserve single line breaks within a block
        const inner = block.replace(/\n/g, '<br>');
        return `<p style="margin:0 0 12px 0;">${inner}</p>`;
      })
      .join('');
  }

  // For the press release — preserve line breaks more carefully
  function draftToHtml(text) {
    const clean = stripMarkdown(text);
    const lines = clean.split('\n');
    let html = '';
    for (const line of lines) {
      const t = line.trim();
      if (!t) { html += '<br>'; continue; }
      // Section dividers
      if (t.startsWith('FOR IMMEDIATE') || t.startsWith('EMBARGO')) {
        html += `<p style="margin:0 0 16px 0;font-size:12px;color:#888;text-transform:uppercase;letter-spacing:0.06em;">${t}</p>`;
      } else if (t === 'ENDS') {
        html += `<p style="margin:16px 0;font-weight:700;color:#0d0d0d;">ENDS</p>`;
      } else if (t.startsWith('Notes to editor') || t.startsWith('About ') || t.startsWith('Spokesperson') || t.startsWith('For more information')) {
        html += `<p style="margin:0 0 8px 0;font-size:13px;color:#2e2e2e;">${t}</p>`;
      } else if (lines.indexOf(line) < 5 && t.length < 120) {
        // Headline and standfirst — first few short lines
        html += `<p style="margin:0 0 12px 0;font-weight:700;font-size:16px;color:#0d0d0d;">${t}</p>`;
      } else {
        html += `<p style="margin:0 0 12px 0;">${t}</p>`;
      }
    }
    return html;
  }

  const cleanCoveringNote = stripMarkdown(coveringNote);
  const cleanDraft = stripMarkdown(draft);

  const htmlBody = `<!DOCTYPE html>
<html>
<head>
<meta charset="UTF-8" />
</head>
<body style="font-family:'Helvetica Neue',Helvetica,Arial,sans-serif;font-size:14px;color:#1a1a1a;line-height:1.7;background:#ffffff;margin:0;padding:0;">
<div style="max-width:620px;margin:0 auto;padding:32px 24px;">

  <div style="border-bottom:3px solid #F04E23;padding-bottom:16px;margin-bottom:28px;">
    <span style="font-family:Arial Black,sans-serif;font-size:15px;font-weight:900;color:#0d0d0d;letter-spacing:-0.02em;">Full Funnel <span style="color:#F04E23;">PR</span></span>
  </div>

  <div style="display:inline-block;background:#fff3ef;color:#F04E23;font-size:11px;font-weight:700;letter-spacing:0.08em;text-transform:uppercase;padding:4px 10px;border-radius:20px;margin-bottom:20px;">Draft for review</div>

  <p style="font-family:Arial,sans-serif;font-size:10px;font-weight:700;letter-spacing:0.1em;text-transform:uppercase;color:#F04E23;border-bottom:1px solid #e2e2e2;padding-bottom:8px;margin:0 0 16px 0;">Covering note</p>
  <div style="background:#fff3ef;border-left:3px solid #F04E23;border-radius:6px;padding:16px 20px;margin-bottom:28px;font-size:14px;color:#1a1a1a;">
    ${textToHtml(cleanCoveringNote)}
  </div>

  <p style="font-family:Arial,sans-serif;font-size:10px;font-weight:700;letter-spacing:0.1em;text-transform:uppercase;color:#F04E23;border-bottom:1px solid #e2e2e2;padding-bottom:8px;margin:32px 0 16px 0;">Press release draft</p>
  <div style="background:#f8f7f5;border:1px solid #e2e2e2;border-radius:8px;padding:20px 24px;font-size:14px;color:#1a1a1a;font-family:Georgia,serif;line-height:1.85;">
    ${draftToHtml(cleanDraft)}
  </div>

  <p style="font-family:Arial,sans-serif;font-size:10px;font-weight:700;letter-spacing:0.1em;text-transform:uppercase;color:#F04E23;border-bottom:1px solid #e2e2e2;padding-bottom:8px;margin:32px 0 16px 0;">Briefing summary</p>
  <div style="background:#f8f7f5;border:1px solid #e2e2e2;border-radius:8px;padding:16px 20px;font-size:13px;color:#2e2e2e;">
    <p style="margin:0 0 6px 0;"><strong>Client:</strong> ${company}${contact ? ' (' + contact + ')' : ''}</p>
    <p style="margin:0 0 6px 0;"><strong>Client email:</strong> ${clientEmail}</p>
    <p style="margin:0 0 16px 0;"><strong>Verdict:</strong> ${verdict}</p>
    <p style="margin:0 0 8px 0;"><strong>Stage 1 answers:</strong></p>
    ${textToHtml(stage1Summary)}
    ${gapSummary ? `<p style="margin:12px 0 8px 0;"><strong>Stage 2 — additional information:</strong></p>${textToHtml(gapSummary)}` : ''}
  </div>

  <div style="margin-top:40px;padding-top:16px;border-top:1px solid #e2e2e2;font-size:12px;color:#888888;">
    Sent automatically by the Full Funnel PR briefing tool &mdash; matt@mattphillipspr.com
  </div>

</div>
</body>
</html>`;

  // Plain text fallback
  const plainBody = `${cleanCoveringNote}\n\n---\nPRESS RELEASE DRAFT\n---\n\n${cleanDraft}\n\n---\nFULL BRIEFING SUMMARY\n---\n\nClient: ${company}${contact ? ' (' + contact + ')' : ''}\nClient email: ${clientEmail}\nVerdict: ${verdict}\n\n${stage1Summary}${gapSummary ? '\n\nStage 2:\n' + gapSummary : ''}`;

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
      console.error('Webhook failed:', e.message);
    }
  }

  return res.status(200).json({ ok: true });
}
