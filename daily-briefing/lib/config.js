// Loads config from the bundled defaults and merges an optional S3 override
// (config/override.json) so ranking rules and templates can be changed at
// runtime without a redeploy.
import boards from '../config/boards.js';
import ranking from '../config/ranking.js';
import templates from '../config/templates.js';
import settings from '../config/settings.js';
import { storageGet } from './matagi.js';

function isPlainObject(v) {
  return v && typeof v === 'object' && !Array.isArray(v);
}

function deepMerge(base, over) {
  if (!isPlainObject(over)) return over;
  const out = Array.isArray(base) ? [...base] : { ...base };
  for (const [k, v] of Object.entries(over)) {
    out[k] = isPlainObject(v) && isPlainObject(out[k]) ? deepMerge(out[k], v) : v;
  }
  return out;
}

export async function loadConfig() {
  const clone = (o) => JSON.parse(JSON.stringify(o));
  let cfg = {
    boards: clone(boards),
    ranking: clone(ranking),
    templates: clone(templates),
    settings: clone(settings),
  };
  // Prefer the env secret for the run token when present.
  if (process.env.RUN_TOKEN) cfg.settings.runToken = process.env.RUN_TOKEN;

  try {
    const override = await storageGet('config/override.json');
    if (isPlainObject(override)) cfg = deepMerge(cfg, override);
  } catch {
    // override is optional — ignore read failures
  }
  return cfg;
}
