// Deterministic, config-driven ranking. Produces top-N / radar / needs-clarity
// buckets. All weights live in config/ranking.js — nothing here is hard-coded
// policy beyond the mechanics of applying those weights.
import { daysBetween } from './time.js';

// Conservative "vague title" detector — bare verbs with no object, only treated
// as ambiguous when the task also has no due date.
const VAGUE = [
  /^follow[-\s]?ups?$/i,
  /^review$/i,
  /^chase$/i,
  /^check$/i,
  /^catch[-\s]?up$/i,
  /^tidy(\s?up)?$/i,
  /^sort(\s?out)?$/i,
  /^prep$/i,
  /^update$/i,
  /^admin$/i,
];

function isVague(title) {
  const t = (title || '').trim();
  if (!t || t === '(untitled)') return true;
  const words = t.split(/\s+/);
  return words.length <= 2 && VAGUE.some((r) => r.test(t));
}

const PRIORITY_ORDER = { high: 0, mid: 1, low: 2, none: 3 };

export function rankTasks(tasks, ranking, todayStr) {
  for (const t of tasks) {
    t.flags = [];
    t.needsClarity = false;
    t.clarityReason = null;

    if (t.priority === 'none') {
      t.needsClarity = true;
      t.clarityReason = 'no priority set — what tier is this?';
    } else if (isVague(t.title) && !t.due) {
      t.needsClarity = true;
      t.clarityReason = 'vague title, no due date — what is the concrete next action?';
    }

    let score = 0;
    if (t.clientOrInternal === 'client') { score += ranking.clientBoost; t.flags.push('client'); }
    score += ranking.priorityWeights?.[t.priority] ?? 0;
    if (t.priority !== 'none') t.flags.push(t.priority);

    if (t.due) {
      const dueDay = String(t.due).slice(0, 10);
      const days = daysBetween(todayStr, dueDay);
      t.dueInDays = days;
      if (days < 0) { score += ranking.overdueBoost; t.flags.push('overdue'); }
      else if (days <= (ranking.dueSoonWindowDays ?? 0)) { score += ranking.dueSoonBoost; t.flags.push('due-soon'); }
    }

    if (ranking.staleCarryoverBoost && t.lastEdited) {
      const editedDay = String(t.lastEdited).slice(0, 10);
      const age = daysBetween(editedDay, todayStr);
      if (age >= (ranking.staleDays ?? Infinity)) { score += ranking.staleCarryoverBoost; t.flags.push('stale'); }
    }

    t.score = score;
  }

  const byScore = (a, b) =>
    b.score - a.score ||
    PRIORITY_ORDER[a.priority] - PRIORITY_ORDER[b.priority] ||
    (dueSortKey(a) - dueSortKey(b));

  const clear = tasks.filter((t) => !t.needsClarity).sort(byScore);
  const needsClarity = tasks.filter((t) => t.needsClarity).sort(byScore);

  const top = clear.slice(0, ranking.topN);
  const rest = clear.slice(ranking.topN);
  const radar = rest.filter((t) => t.priority === 'high' || t.priority === 'mid').slice(0, ranking.radarMax);
  const radarIds = new Set(radar.map((t) => t.id));
  const lowerCount = rest.filter((t) => !radarIds.has(t.id)).length;

  return { top, radar, lowerCount, needsClarity, all: tasks };
}

function dueSortKey(t) {
  return typeof t.dueInDays === 'number' ? t.dueInDays : 9999;
}

// Short human reason string from a task's flags, e.g. "High · client · due in 2d".
export function reasonText(t) {
  const bits = [];
  if (t.priority === 'high') bits.push('High');
  else if (t.priority === 'mid') bits.push('Mid');
  else if (t.priority === 'low') bits.push('Low');
  if (t.clientOrInternal === 'client') bits.push('client');
  else bits.push('internal');
  if (t.flags?.includes('overdue')) bits.push(`overdue by ${Math.abs(t.dueInDays)}d`);
  else if (t.flags?.includes('due-soon')) bits.push(t.dueInDays === 0 ? 'due today' : `due in ${t.dueInDays}d`);
  if (t.flags?.includes('stale')) bits.push('long-open');
  return bits.join(' · ');
}
