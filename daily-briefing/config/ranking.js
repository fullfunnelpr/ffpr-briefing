// Ranking rules — explicit and editable (NOT buried in a prompt).
// Final score per task = clientBoost (if client) + priorityWeight
//   + overdueBoost | dueSoonBoost (if due within dueSoonWindowDays)
//   + staleCarryoverBoost (if open and untouched for >= staleDays).
// Highest score wins the top-N slots. Ties broken by priority then due date.
export default {
  clientBoost: 100, // client work outranks internal by default
  priorityWeights: { high: 40, mid: 20, low: 5, none: 0 },

  overdueBoost: 60, // due date already passed
  dueSoonBoost: 30, // due within the window below
  dueSoonWindowDays: 3,

  staleCarryoverBoost: 10, // long-open, unmoved items get a nudge (set 0 to disable)
  staleDays: 14,

  topN: 3, // "Top priorities" slots
  radarMax: 12, // cap on individually-listed "also on your radar" items
};
