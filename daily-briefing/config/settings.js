// Operational settings. Anything here can be overridden at runtime (without a
// redeploy) by uploading config/override.json to the shared storage bucket.
export default {
  timezone: 'Europe/London',

  // Baseline working window used to compute realistic free time.
  workStart: '09:00',
  workEnd: '17:30',
  meetingBufferMins: 0, // optional padding added around each meeting

  calendarId: 'primary',
  completedStatus: '✅ Completed', // exact Notion status option to exclude
  adminBlockPrefixes: ['Inbox review', 'Meeting prep'], // auto-generated blocks to ignore

  recipient: 'matt@mattphillipspr.com',
  sender: 'matt@mattphillipspr.com',

  // Notion "Daily Briefing" dashboard page (updated in place each run).
  dashboardTitle: 'Daily Briefing',
  dashboardIcon: '🗓️',
  dashboardParentPageId: '32cf0472-9880-802e-b90c-ef7559a2ce56', // Finance & Admin
  dashboardPageId: '3aef0472-9880-8109-b4be-c87e2fb8d286',
  dashboardPageUrl: 'https://app.notion.com/p/3aef047298808109b4bec87e2fb8d286',

  // Manual rerun auth. Prefer the RUN_TOKEN env secret; this is the fallback
  // used only if that secret is not set. (This repo is private.)
  runToken: '1IGRCIsio-SRhgugltidd5zAyfisG5mj',

  // Optional LLM flourish for the sign-off line (falls back to the template).
  llmSignoff: false,
  llmModel: 'claude-haiku-4-5',
};
