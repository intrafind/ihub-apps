// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

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
 * Raise a `preferredTemperature` below the floor.
 *
 * @param {object} ctx - migration context
 * @param {string} path - app path, for the log
 * @param {object} app - the app config (mutated)
 * @returns {boolean} true when it changed
 */
function raiseTemperature(ctx, path, app) {
  const temperature = app.preferredTemperature;
  if (typeof temperature !== 'number' || temperature >= MIN_TEMPERATURE) return false;
  app.preferredTemperature = MIN_TEMPERATURE;
  ctx.log(`${path}: preferredTemperature ${temperature} → ${MIN_TEMPERATURE}`);
  return true;
}

/**
 * Turn thinking off for a translation app that does not say whether to think.
 *
 * @param {object} ctx - migration context
 * @param {string} path - app path, for the log
 * @param {object} app - the app config (mutated)
 * @returns {boolean} true when it changed
 */
function turnOffThinking(ctx, path, app) {
  if (!NO_THINKING_APPS.has(app.id) || app.thinking?.enabled !== undefined) return false;
  app.thinking = { ...app.thinking, enabled: false };
  ctx.log(`${path}: thinking turned off`);
  return true;
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
    return app && typeof app === 'object' ? app : null;
  } catch (error) {
    // Not this migration's file to repair, and throwing would block every
    // later migration on startup.
    ctx.warn(`Skipped ${path}: ${error.message}`);
    return null;
  }
}

export async function up(ctx) {
  let count = 0;
  for (const file of await ctx.listFiles('apps', '*.json')) {
    const path = `apps/${file}`;
    const app = await readApp(ctx, path);
    if (!app) continue;
    // Both rules run, so neither may short-circuit the other.
    const changed = [raiseTemperature(ctx, path, app), turnOffThinking(ctx, path, app)];
    if (changed.includes(true)) {
      await ctx.writeJson(path, app);
      count += 1;
    }
  }
  ctx.log(count === 0 ? 'No app needed a change' : `Updated ${count} app(s)`);
}
