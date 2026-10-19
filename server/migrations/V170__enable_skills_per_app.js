/**
 * Migration V170 — skills are opt-in per app
 *
 * Skills used to reach every app: personal skills were added to each app
 * unless it set `skillSettings.allowPersonal: false`. One user skill was
 * enough to put an `<available_skills>` block and the `activate_skill` /
 * `read_skill_resource` tools into a tool-less translation app, and a
 * reasoning model there kept reconsidering its answer until `max_tokens` ran
 * out. An app now offers skills only when it sets `skillSettings.enabled:
 * true`.
 *
 * To keep what works today, this sets `enabled: true` on
 *
 * - every app that lists `skills`, and
 * - the general-purpose chat apps (`chat`, `web-chat`, `iassistant`), where
 *   users expect their personal skills.
 *
 * Every other app stays off. An app that already says `enabled` either way is
 * left alone. Every decision is logged. Apps live in `apps/*.json` and, for
 * older installations, in the legacy `config/apps.json` array; both are
 * migrated.
 */

export const version = '170';
export const description = 'enable_skills_per_app';

const GENERAL_CHAT_APPS = new Set(['chat', 'web-chat', 'iassistant']);

/**
 * Why `app` keeps skills, or null when it does not.
 *
 * @param {object} app - the app config
 * @returns {string|null}
 */
function reasonToEnable(app) {
  if (Array.isArray(app.skills) && app.skills.length > 0) return 'it lists skills';
  if (GENERAL_CHAT_APPS.has(app.id)) return 'it is a general-purpose chat app';
  return null;
}

/**
 * Read one app, or null when it cannot be read.
 *
 * @param {object} ctx - migration context
 * @param {string} path - app path
 * @returns {Promise<object|null>} the app config
 */
async function readApp(ctx, path) {
  try {
    const app = await ctx.readJson(path);
    return app && typeof app === 'object' && !Array.isArray(app) ? app : null;
  } catch (error) {
    // Not this migration's file to repair, and throwing would block every
    // later migration on startup.
    ctx.warn(`Skipped ${path}: ${error.message}`);
    return null;
  }
}

/**
 * Decide `skillSettings.enabled` for one app and log the decision.
 *
 * @param {object} ctx - migration context
 * @param {string} label - where the app lives, for the log
 * @param {object} app - the app config (mutated when it is enabled)
 * @returns {'enabled'|'off'|'kept'} what happened to it
 */
function decide(ctx, label, app) {
  if (app.skillSettings?.enabled !== undefined) {
    ctx.log(`${label}: skillSettings.enabled already set (${app.skillSettings.enabled}) — kept`);
    return 'kept';
  }
  const reason = reasonToEnable(app);
  if (!reason) {
    ctx.log(`${label}: skills stay off`);
    return 'off';
  }
  app.skillSettings = { ...app.skillSettings, enabled: true };
  ctx.log(`${label}: skillSettings.enabled set to true because ${reason}`);
  return 'enabled';
}

/**
 * Apply {@link decide} to the apps in the legacy `config/apps.json` array,
 * which the apps loader still reads next to `apps/*.json`.
 *
 * @param {object} ctx - migration context
 * @param {{enabled: number, off: number}} totals - running counts (mutated)
 * @returns {Promise<void>}
 */
async function migrateLegacyApps(ctx, totals) {
  const path = 'config/apps.json';
  if (!(await ctx.fileExists(path))) return;
  let apps = null;
  try {
    apps = await ctx.readJson(path);
  } catch (error) {
    ctx.warn(`Skipped ${path}: ${error.message}`);
    return;
  }
  if (!Array.isArray(apps)) return;
  let changed = false;
  apps.forEach((app, index) => {
    if (!app || typeof app !== 'object') return;
    const result = decide(ctx, `${path}[${index}] (${app.id})`, app);
    if (result === 'enabled') {
      totals.enabled += 1;
      changed = true;
    } else if (result === 'off') {
      totals.off += 1;
    }
  });
  if (changed) await ctx.writeJson(path, apps);
}

/**
 * Set `skillSettings.enabled` on every app that keeps skills, in `apps/*.json`
 * and in the legacy `config/apps.json`, and log each decision.
 *
 * @param {object} ctx - migration context
 * @returns {Promise<void>}
 */
export async function up(ctx) {
  const totals = { enabled: 0, off: 0 };
  for (const file of await ctx.listFiles('apps', '*.json')) {
    const path = `apps/${file}`;
    const app = await readApp(ctx, path);
    if (!app) continue;
    const result = decide(ctx, path, app);
    if (result === 'enabled') {
      await ctx.writeJson(path, app);
      totals.enabled += 1;
    } else if (result === 'off') {
      totals.off += 1;
    }
  }
  await migrateLegacyApps(ctx, totals);
  ctx.log(`Skills enabled on ${totals.enabled} app(s), left off on ${totals.off}`);
}
