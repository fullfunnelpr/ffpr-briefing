// Turns the ranked brief into (a) Notion blocks for the dashboard and (b) a
// short plain-text pointer email. Kept separate from I/O so it is easy to test
// and easy to restyle.
import { prettyDate, timeStr } from './time.js';
import { reasonText } from './rank.js';

// ---- Notion block helpers ----
const rt = (text) => [{ type: 'text', text: { content: String(text).slice(0, 1900) } }];
const h1 = (t) => ({ object: 'block', type: 'heading_1', heading_1: { rich_text: rt(t) } });
const h2 = (t) => ({ object: 'block', type: 'heading_2', heading_2: { rich_text: rt(t) } });
const para = (t) => ({ object: 'block', type: 'paragraph', paragraph: { rich_text: rt(t) } });
const bullet = (t) => ({ object: 'block', type: 'bulleted_list_item', bulleted_list_item: { rich_text: rt(t) } });
const numbered = (t) => ({ object: 'block', type: 'numbered_list_item', numbered_list_item: { rich_text: rt(t) } });
const divider = () => ({ object: 'block', type: 'divider', divider: {} });
const callout = (t, emoji) => ({
  object: 'block',
  type: 'callout',
  callout: { rich_text: rt(t), icon: { type: 'emoji', emoji } },
});

function freeTimeLine(free) {
  if (!free || free.unavailable) return 'Free working time: unavailable (calendar could not be read).';
  const mt = free.meetingCount === 1 ? '1 meeting' : `${free.meetingCount} meetings`;
  return `${free.freeHours}h free (${free.windowLabel} window, ${mt})`;
}

export function renderDashboardBlocks({ cfg, now, free, ranked, record }) {
  const tz = cfg.settings.timezone;
  const blocks = [];

  blocks.push(para(`${prettyDate(now, tz)} · updated ${timeStr(now, tz)} ${tz}`));
  blocks.push(callout(`Estimated free working time — ${freeTimeLine(free)}`, '⏱️'));

  if (record.missingSources?.length) {
    blocks.push(callout(`Partial brief: could not load ${record.missingSources.join(', ')}. Figures below exclude ${record.missingSources.length > 1 ? 'those boards' : 'that board'}.`, '⚠️'));
  }

  // Top priorities
  blocks.push(h2('🔦 Top 3 priorities'));
  if (ranked.top.length === 0) {
    blocks.push(para(cfg.templates.topEmpty));
  } else {
    for (const t of ranked.top) {
      blocks.push(numbered(`${t.title} — ${t.label}  ·  ${reasonText(t)}`));
    }
  }

  // Radar
  blocks.push(h2('📡 Also on your radar'));
  if (ranked.radar.length === 0 && ranked.lowerCount === 0) {
    blocks.push(para(cfg.templates.radarEmpty));
  } else {
    for (const t of ranked.radar) {
      blocks.push(bullet(`${t.title} — ${t.label}  ·  ${reasonText(t)}`));
    }
    if (ranked.lowerCount > 0) {
      blocks.push(para(`Plus ${ranked.lowerCount} lower-priority item${ranked.lowerCount === 1 ? '' : 's'} parked for now.`));
    }
  }

  // Needs clarity
  blocks.push(h2('❓ Needs clarity'));
  if (ranked.needsClarity.length === 0) {
    blocks.push(para(cfg.templates.needsClarityEmpty));
  } else {
    for (const t of ranked.needsClarity.slice(0, 15)) {
      blocks.push(bullet(`${t.title} — ${t.label}  ·  ${t.clarityReason}`));
    }
    if (ranked.needsClarity.length > 15) {
      blocks.push(para(`Plus ${ranked.needsClarity.length - 15} more items missing a clear priority.`));
    }
  }

  blocks.push(divider());
  blocks.push(para(cfg.templates.signoff));

  // Small run-metadata line for observability.
  const counts = cfg.boards
    .map((b) => `${b.label.split(' / ')[0]} ${fmtCount(record.sourceCounts[b.key])}`)
    .join('  ·  ');
  blocks.push(para(`Sources: ${counts}  ·  dashboard ${record.dashboardWriteStatus || 'pending'}  ·  email ${record.emailSendStatus || 'pending'}  ·  run ${record.trigger}`));

  return blocks;
}

function fmtCount(v) {
  return v === null || v === undefined ? '⚠️' : String(v);
}

export function renderEmail({ cfg, free, ranked, missingSources = [] }) {
  const lines = [];
  lines.push(cfg.templates.greeting);
  lines.push('');
  const freeStr = free && !free.unavailable
    ? `${free.freeHours}h (${free.meetingCount} meeting${free.meetingCount === 1 ? '' : 's'})`
    : 'unavailable (calendar not read)';
  lines.push(`Free working time today: ${freeStr}.`);

  if (ranked.top.length) {
    lines.push('Top 3:');
    ranked.top.forEach((t, i) => lines.push(`${i + 1}. ${asciiSafe(t.title)} - ${asciiSafe(t.label)}`));
  } else {
    lines.push(asciiSafe(cfg.templates.topEmpty));
  }

  if (missingSources.length) {
    lines.push('');
    lines.push(`Note: could not load ${asciiSafe(missingSources.join(', '))} - this brief is partial.`);
  }

  lines.push('');
  const url = cfg.settings.dashboardPageUrl;
  lines.push(url ? `Full brief: ${url}` : 'Full brief on the Daily Briefing dashboard in Notion.');
  return lines.join('\n');
}

// Keep the email body 7-bit clean (emoji/en-dashes stripped) so plain-text
// Content-Transfer-Encoding: 7bit is always valid.
function asciiSafe(s) {
  return String(s)
    .replace(/[–—]/g, '-')
    .replace(/[‘’]/g, "'")
    .replace(/[“”]/g, '"')
    .replace(/[^\x00-\x7F]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

export { asciiSafe };
