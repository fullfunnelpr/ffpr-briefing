export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') return res.status(204).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const { company, contact, email, verdict, angle, stage1, stage2gaps } = req.body;

  if (!company || !stage1) return res.status(400).json({ error: 'Missing required fields' });

  const gapAnswers = Object.entries(stage2gaps || {})
    .map(([gap, answer]) => `${gap}: ${answer || 'Not provided'}`)
    .join('\n');

  const prompt = `You are a senior PR copywriter at Full Funnel PR. You have received a fully completed press release briefing from a client and must now produce two things: a covering note and a draft press release.

IMPORTANT: Do NOT use markdown formatting anywhere in your response. No asterisks, no hashes, no bullet dashes, no bold markers. Plain text only throughout — including the covering note and the press release draft.

CLIENT: ${company}${contact ? ' (' + contact + ')' : ''}
CLIENT EMAIL: ${email}
NEWS VERDICT: ${verdict}
PROVISIONAL ANGLE: ${angle}

STAGE 1 BRIEFING ANSWERS:
${stage1}

STAGE 2 — ADDITIONAL INFORMATION PROVIDED BY CLIENT:
${gapAnswers || 'No additional information provided.'}

---

Produce your response in EXACTLY this structure with these EXACT labels:

COVERING NOTE
A short note (3-5 sentences) from Matt Phillips's perspective to himself — written as "Matt," not "Dear Matt". Flag: the verdict, the strongest element of the story, any remaining weaknesses to be aware of before sending to the client, and any questions to raise with the client on a call. Tone: direct, collegial, like a senior colleague briefing him. No markdown. No asterisks.

PRESS RELEASE DRAFT

FOR IMMEDIATE RELEASE / EMBARGO: [date if known, otherwise TBC]

[HEADLINE — active, specific, includes company name and key fact. Under 12 words.]

[STANDFIRST — one sentence adding context to the headline]

[LOCATION, DATE] — [Para 1: what the company has done, who it affects, what the impact number is. 2-3 sentences max.]

[Para 2: the before-and-after arc. What was the situation before? What changes now?]

[Para 3: spokesperson quote. Must avoid the words excited, delighted, proud to announce, and all salesspeak. Should explain WHY the thing was done and what the audience should do. Format as: FirstName LastName, JobTitle, CompanyName, said: "Quote text here."]

[Para 4: if a partnership — partner quote explaining why they chose to work with the client. If not a partnership, use this paragraph for a proof point or supporting data. Format quotes as: FirstName LastName, JobTitle, CompanyName, said: "Quote text here."]

[Para 5 optional: topical context or third-party data that adds credibility.]

[Final para: what happens next. One sentence.]

ENDS

Notes to editor:
About ${company}: [one sentence boilerplate inferred from the briefing]
Spokesperson available for interview: [name and title if provided]
For more information contact: matt@mattphillipspr.com

---

Rules:
- Write in third person throughout
- No markdown, no asterisks, no hashes, no bullet formatting of any kind
- No hyperbole, salesspeak, or jargon
- Quotes must sound like a real person speaking
- If impact numbers are missing write [INSERT FIGURE] as a placeholder
- If photography is confirmed add "Images available on request" after ENDS
- Keep the whole release under 450 words`;

  try {
    const anthropicRes = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': process.env.ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: 'claude-sonnet-4-6',
        max_tokens: 2000,
        stream: false,
        messages: [{ role: 'user', content: prompt }],
      }),
    });

    const rawText = await anthropicRes.text();
    let parsed;
    try { parsed = JSON.parse(rawText); }
    catch (e) { return res.status(500).json({ error: 'Failed to parse Anthropic response', raw: rawText.slice(0, 500) }); }

    const responseText = parsed.content?.find(b => b.type === 'text')?.text || '';
    if (!responseText) return res.status(500).json({ error: 'Empty response' });

    return res.status(200).json({ draft: responseText });

  } catch (err) {
    return res.status(500).json({ error: 'API call failed', detail: err.message });
  }
}
