export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') {
    return res.status(204).end();
  }

  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const { company, contact, q1, q2, q3, q4, q5, q6, q7, q8, q9, q10 } = req.body;

  if (!company || !q1 || !q2 || !q3) {
    return res.status(400).json({ error: 'Missing required fields' });
  }

  const prompt = `You are a senior PR consultant at Full Funnel PR, an expert in news assessment and media strategy. A client has submitted a press release briefing form. Your job is to assess the strength of their news and tell them honestly what they have — and what they need.

CLIENT: ${company}${contact ? ' (submitted by ' + contact + ')' : ''}

Q1 - What happened: ${q1}
Q2 - Who is affected and how: ${q2}
Q3 - Before and after / arc: ${q3}
Q4 - Well-known names involved: ${q4 || 'None mentioned'}
Q5 - Thread / what this builds on: ${q5 || 'Not provided'}
Q6 - Standout angle (first, biggest, fastest, twist): ${q6 || 'Not identified'}
Q7 - Topical context / themes: ${q7 || 'Not provided'}
Q8 - Spokespeople: ${q8 || 'Not provided'}
Q9 - Photography: ${q9 || 'Not provided'}
Q10 - Supporting data: ${q10 || 'Not provided'}

Produce a structured assessment with EXACTLY these four sections, using these exact labels:

VERDICT
First line only: one of these exact labels followed by a colon and a one-line reason:
🔥 HOT: [reason] — A famous name or company is involved AND/OR there is a large credible impact number. Multiple outlets should cover this unprompted.
🪴 POT: [reason] — Strong enough to earn coverage with the right pitch and personalised outreach.
🤖 BOT: [reason] — Significant to the business but unlikely to earn editorial coverage. Wire distribution recommended.
🤔 NOT: [reason] — No time-bound event. A press release is not the right vehicle.
Then 2 sentences explaining the verdict honestly.

STRENGTHS
2-3 sentences only. What is genuinely strong about this story — specific elements that journalists will find interesting. Be precise, not encouraging. If little is strong, say so briefly.

GAPS
A list of 3-5 specific things that are missing or weak, each as a short sentence starting with the gap type in caps, e.g: "IMPACT NUMBER: No measurable figure given for how many people are affected." Be direct. Each gap should be actionable — something the client can actually go and find or create.

PROVISIONAL ANGLE
One sentence: the strongest possible press release angle based on what has been submitted so far. Write it as if it were the opening line of a pitch email — specific, active, impact-first. If the story is NOT news, write what format would work better instead and why.

Keep the whole response under 380 words. Be honest, direct, and professional. Do not use marketing language or empty encouragement.`;

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
        max_tokens: 1000,
        stream: false,
        messages: [{ role: 'user', content: prompt }],
      }),
    });

    // Read as text first to safely inspect before parsing
    const rawText = await anthropicRes.text();

    let parsed;
    try {
      parsed = JSON.parse(rawText);
    } catch (e) {
      return res.status(500).json({
        error: 'Failed to parse Anthropic response',
        raw: rawText.slice(0, 500),
      });
    }

    // Return only the clean parsed response
    return res.status(200).json(parsed);

  } catch (err) {
    return res.status(500).json({ error: 'API call failed', detail: err.message });
  }
}
