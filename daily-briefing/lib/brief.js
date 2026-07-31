// Orchestrator: gather (guarded per source) → rank → render → write dashboard →
// send email → persist a run snapshot. Every external step is independently
// wrapped so one failure degrades to a partial brief instead of failing silently.
import { loadConfig } from './config.js';
import { getConnection, storagePut, storageGet, llm } from './matagi.js';
import { queryBoard } from './notion.js';
import { computeFreeTime } from './calendar.js';
import { rankTasks } from './rank.js';
import { renderDashboardBlocks, renderEmail } from './render.js';
import { updateDashboard } from './dashboard.js';
import { sendEmail } from './gmail.js';
import { dateStr } from './time.js';

export async function runBriefing({ trigger = 'manual' } = {}) {
  const cfg = await loadConfig();
  const tz = cfg.settings.timezone;
  const now = new Date();
  const today = dateStr(now, tz);

  const record = {
    runAt: now.toISOString(),
    dateLondon: today,
    trigger,
    sourceCounts: {},
    missingSources: [],
    errors: [],
    dashboardWriteStatus: 'pending',
    emailSendStatus: 'pending',
  };

  const notionConn = getConnection('notion');
  const calConn = getConnection('google_calendar');
  const gmailConn = getConnection('gmail');

  // 1) Tasks from the four boards (each guarded independently).
  const tasks = [];
  for (const board of cfg.boards) {
    if (!notionConn) { record.missingSources.push(board.label); record.sourceCounts[board.key] = null; continue; }
    try {
      const boardTasks = await queryBoard(notionConn, board, cfg.settings.completedStatus);
      tasks.push(...boardTasks);
      record.sourceCounts[board.key] = boardTasks.length;
    } catch (e) {
      record.missingSources.push(board.label);
      record.sourceCounts[board.key] = null;
      record.errors.push({ where: `notion:${board.key}`, message: String(e?.message || e) });
    }
  }

  // 2) Calendar / realistic free time (guarded).
  let free = { unavailable: true };
  try {
    if (!calConn) throw new Error('no google_calendar connection shared');
    free = await computeFreeTime(calConn, cfg.settings, now);
  } catch (e) {
    record.errors.push({ where: 'calendar', message: String(e?.message || e) });
  }
  record.freeTime = free;

  // 3) Rank.
  const ranked = rankTasks(tasks, cfg.ranking, today);
  record.ranked = {
    top: ranked.top,
    radar: ranked.radar,
    lowerCount: ranked.lowerCount,
    needsClarity: ranked.needsClarity,
  };
  record.taskTotal = tasks.length;

  // 4) Optional LLM sign-off flourish (never fatal).
  if (cfg.settings.llmSignoff) {
    try {
      const top = ranked.top.map((t, i) => `${i + 1}. ${t.title} (${t.label})`).join('; ');
      const msg = `Write ONE short, warm, plain-text sign-off line (max 20 words, no markdown, no emoji) for a PR director's morning briefing. Free time today: ${free.freeHours ?? 'unknown'}h. Top priorities: ${top || 'none'}.`;
      const out = await llm({ model: cfg.settings.llmModel, messages: [{ role: 'user', content: msg }], max_tokens: 60 });
      if (out && out.trim()) cfg.templates.signoff = out.trim().replace(/^["']|["']$/g, '');
    } catch (e) {
      record.errors.push({ where: 'llm-signoff', message: String(e?.message || e) });
    }
  }

  // 5) Render dashboard + email.
  const blocks = renderDashboardBlocks({ cfg, now, free, ranked, record });
  const emailText = renderEmail({ cfg, free, ranked, missingSources: record.missingSources });
  record.emailBody = emailText;

  // 6) Write dashboard in place (guarded).
  try {
    if (!notionConn) throw new Error('no notion connection shared');
    const res = await updateDashboard(notionConn, cfg.settings.dashboardPageId, blocks, {
      title: cfg.settings.dashboardTitle,
      icon: cfg.settings.dashboardIcon,
    });
    record.dashboardWriteStatus = 'ok';
    record.dashboardBlocks = res.blocks;
  } catch (e) {
    record.dashboardWriteStatus = 'failed';
    record.errors.push({ where: 'dashboard', message: String(e?.message || e) });
  }

  // Re-render the metadata line so the dashboard reflects final statuses is not
  // needed: the email is sent after, and the snapshot below carries truth.

  // 7) Send pointer email (guarded).
  try {
    if (!gmailConn) throw new Error('no gmail connection shared');
    const info = await sendEmail(gmailConn, {
      to: cfg.settings.recipient,
      from: cfg.settings.sender,
      subject: `Your Morning Briefing - ${today}`,
      text: emailText,
    });
    record.emailSendStatus = 'ok';
    record.emailId = info?.id || null;
  } catch (e) {
    record.emailSendStatus = 'failed';
    record.errors.push({ where: 'email', message: String(e?.message || e) });
  }

  // 8) Persist the run snapshot (history + latest pointer).
  try {
    const key = `runs/${record.runAt.replace(/[:.]/g, '-')}.json`;
    await storagePut(key, record);
    await storagePut('runs/latest.json', record);
    record.snapshotKey = key;
  } catch (e) {
    record.errors.push({ where: 'persist', message: String(e?.message || e) });
  }

  return record;
}

// Compact one-line-ish summary for API responses / logs.
export function summarize(record) {
  return {
    date: record.dateLondon,
    trigger: record.trigger,
    freeHours: record.freeTime?.freeHours ?? null,
    tasks: record.taskTotal ?? null,
    top: (record.ranked?.top || []).map((t) => `${t.title} (${t.label})`),
    needsClarity: (record.ranked?.needsClarity || []).length,
    sourceCounts: record.sourceCounts,
    missingSources: record.missingSources,
    dashboard: record.dashboardWriteStatus,
    email: record.emailSendStatus,
    errors: record.errors,
  };
}

export async function lastRun() {
  return storageGet('runs/latest.json');
}
