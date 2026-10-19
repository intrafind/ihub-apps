/**
 * Migration V170 — temperature is no longer an app, prompt, agent or workflow setting
 *
 * A temperature picked per app contradicts what a current model is tuned for:
 * reasoning models loop at low values, and some providers fix the value or
 * reject a custom one. iHub now sends a sampling parameter only when the model
 * config sets one (`model.sampling`); everything else gets the provider's or
 * model's own default.
 *
 * This removes the settings that no longer exist from stored configuration.
 * The app and agent-profile schemas are strict, so a leftover key would fail
 * validation:
 *
 * - apps:           `preferredTemperature` and `settings.temperature` (the flag
 *                   that showed the per-chat slider)
 * - agent profiles: `preferredTemperature` and `memory.temperature`
 * - workflows:      `config.temperature` of every node
 * - prompts:        `temperature` / `preferredTemperature`
 *
 * Nothing is carried over to the models: an admin who wants a fixed sampling
 * setting for a model sets `sampling` on it. Every dropped value is logged so
 * it can be found again.
 */

export const version = '170';
export const description = 'remove_temperature_settings';

/**
 * Delete `key` from `object` when it is there.
 *
 * @param {object} ctx - migration context
 * @param {string} label - file and key path, for the log
 * @param {object} object - the object to remove the key from (mutated)
 * @param {string} key
 * @returns {boolean} true when the key was removed
 */
function drop(ctx, label, object, key) {
  if (!object || typeof object !== 'object' || !Object.hasOwn(object, key)) return false;
  ctx.log(`${label}: removed ${key} ${JSON.stringify(object[key])}`);
  delete object[key];
  return true;
}

/**
 * Remove every temperature setting from one stored app.
 *
 * @param {object} ctx - migration context
 * @param {string} path - file path, for the log
 * @param {object} app - the app config (mutated)
 * @returns {boolean} true when it changed
 */
function stripApp(ctx, path, app) {
  const dropped = [
    drop(ctx, path, app, 'preferredTemperature'),
    drop(ctx, `${path} settings`, app.settings, 'temperature')
  ];
  return dropped.includes(true);
}

/**
 * Remove every temperature setting from one stored agent profile.
 *
 * @param {object} ctx - migration context
 * @param {string} path - file path, for the log
 * @param {object} profile - the agent profile (mutated)
 * @returns {boolean} true when it changed
 */
function stripAgentProfile(ctx, path, profile) {
  const dropped = [
    drop(ctx, path, profile, 'preferredTemperature'),
    drop(ctx, `${path} memory`, profile.memory, 'temperature')
  ];
  return dropped.includes(true);
}

/**
 * Remove the temperature from every node of one stored workflow.
 *
 * @param {object} ctx - migration context
 * @param {string} path - file path, for the log
 * @param {object} workflow - the workflow definition (mutated)
 * @returns {boolean} true when it changed
 */
function stripWorkflow(ctx, path, workflow) {
  if (!Array.isArray(workflow.nodes)) return false;
  let changed = false;
  for (const node of workflow.nodes) {
    if (drop(ctx, `${path} node ${node?.id}`, node?.config, 'temperature')) changed = true;
  }
  return changed;
}

/**
 * Remove every temperature setting from one stored prompt.
 *
 * @param {object} ctx - migration context
 * @param {string} path - file path, for the log
 * @param {object} prompt - the prompt (mutated)
 * @returns {boolean} true when it changed
 */
function stripPrompt(ctx, path, prompt) {
  const dropped = [
    drop(ctx, path, prompt, 'temperature'),
    drop(ctx, path, prompt, 'preferredTemperature')
  ];
  return dropped.includes(true);
}

/**
 * Apply `strip` to every JSON file of a directory.
 *
 * @param {object} ctx - migration context
 * @param {string} directory - relative to the contents directory
 * @param {(ctx: object, path: string, config: object) => boolean} strip
 * @returns {Promise<number>} how many files changed
 */
async function stripDirectory(ctx, directory, strip) {
  let count = 0;
  for (const file of await ctx.listFiles(directory, '*.json')) {
    const path = `${directory}/${file}`;
    let config;
    try {
      config = await ctx.readJson(path);
    } catch (error) {
      // Not this migration's file to repair, and throwing would block every
      // later migration on startup.
      ctx.warn(`Skipped ${path}: ${error.message}`);
      continue;
    }
    if (!config || typeof config !== 'object' || Array.isArray(config)) continue;
    if (strip(ctx, path, config)) {
      await ctx.writeJson(path, config);
      count += 1;
    }
  }
  return count;
}

export async function up(ctx) {
  const counts = {
    apps: await stripDirectory(ctx, 'apps', stripApp),
    'agent profiles': await stripDirectory(ctx, 'agents/profiles', stripAgentProfile),
    workflows: await stripDirectory(ctx, 'workflows', stripWorkflow),
    prompts: await stripDirectory(ctx, 'prompts', stripPrompt)
  };
  const total = Object.values(counts).reduce((sum, n) => sum + n, 0);
  if (total === 0) {
    ctx.log('No temperature settings to remove');
    return;
  }
  const summary = Object.entries(counts)
    .filter(([, n]) => n > 0)
    .map(([name, n]) => `${n} ${name}`)
    .join(', ');
  ctx.log(`Removed temperature settings from ${summary}`);
}
