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
 * left alone. Every decision is logged.
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

export async function up(ctx) {
  let enabled = 0;
  let off = 0;
  for (const file of await ctx.listFiles('apps', '*.json')) {
    const path = `apps/${file}`;
    const app = await readApp(ctx, path);
    if (!app) continue;
    if (app.skillSettings?.enabled !== undefined) {
      ctx.log(`${path}: skillSettings.enabled already set (${app.skillSettings.enabled}) — kept`);
      continue;
    }
    const reason = reasonToEnable(app);
    if (!reason) {
      off += 1;
      ctx.log(`${path}: skills stay off`);
      continue;
    }
    app.skillSettings = { ...app.skillSettings, enabled: true };
    await ctx.writeJson(path, app);
    enabled += 1;
    ctx.log(`${path}: skillSettings.enabled set to true because ${reason}`);
  }
  ctx.log(`Skills enabled on ${enabled} app(s), left off on ${off}`);
}
