/**
 * Migration V169 — no app below temperature 0.7, no thinking for translation
 *
 * Reasoning models such as Qwen3.6 on vLLM get stuck in reasoning loops at low
 * temperatures: they reach the answer, then keep second-guessing it until
 * `max_tokens` runs out. Several apps asked for 0.2–0.4. In a replay of a real
 * Babelfish turn (temperature 0.2, thinking on), 5 of 8 runs never answered;
 * with thinking off, 0 of 8 did, in about a second each.
 *
 * The shipped defaults and the marketplace apps changed with this release, but
 * an installation keeps its own copies. This brings them in line:
 *
 * - every app with a `preferredTemperature` below 0.7 gets 0.7;
 * - the Translator and Babelfish apps get `thinking.enabled: false`, unless
 *   the app already says whether to think — a translation does not need it.
 *
 * Every change is logged.
 */

export const version = '169';
export const description = 'app_temperature_floor_and_translation_thinking';

const MIN_TEMPERATURE = 0.7;
const NO_THINKING_APPS = new Set(['translator', 'babelfish']);

/**
 * Apply both rules to one app config in place.
 *
 * @param {object} ctx - migration context
 * @param {string} path - app path, for the log
 * @param {object} app - the app config (mutated)
 * @returns {boolean} true when it changed
 */
function migrateApp(ctx, path, app) {
  let changed = false;

  const temperature = app.preferredTemperature;
  if (typeof temperature === 'number' && temperature < MIN_TEMPERATURE) {
    app.preferredTemperature = MIN_TEMPERATURE;
    ctx.log(`${path}: preferredTemperature ${temperature} → ${MIN_TEMPERATURE}`);
    changed = true;
  }

  if (NO_THINKING_APPS.has(app.id) && app.thinking?.enabled === undefined) {
    app.thinking = { ...(app.thinking ?? {}), enabled: false };
    ctx.log(`${path}: thinking turned off`);
    changed = true;
  }

  return changed;
}

export async function up(ctx) {
  let count = 0;
  for (const file of await ctx.listFiles('apps', '*.json')) {
    const path = `apps/${file}`;
    let app;
    try {
      app = await ctx.readJson(path);
    } catch (error) {
      // Not this migration's file to repair, and throwing would block every
      // later migration on startup.
      ctx.warn(`Skipped ${path}: ${error.message}`);
      continue;
    }
    if (!app || typeof app !== 'object') continue;
    if (migrateApp(ctx, path, app)) {
      await ctx.writeJson(path, app);
      count += 1;
    }
  }
  ctx.log(count === 0 ? 'No app needed a change' : `Updated ${count} app(s)`);
}
