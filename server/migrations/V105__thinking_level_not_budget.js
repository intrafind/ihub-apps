/**
 * Migration V105 — reasoning effort is a level everywhere, never a number
 *
 * `thinking.budget` looked like a token allowance and was nothing of the kind.
 * No adapter ever put the number on the wire: every one of them bucketed it
 * into one of four reasoning levels first — Google into `thinkingLevel`,
 * OpenAI and vLLM into `reasoning_effort`, the OpenAI Responses adapter into
 * `reasoning.effort` via its own copy of the same ladder. Anything above 500
 * came out as `high`, so a budget of 1024 and a budget of 32768 were the same
 * request while looking like a considered choice. The app settings panel made
 * it worse by offering the number as a 0–32768 slider labelled "Maximum tokens
 * for thinking".
 *
 * So the number is gone — from model, app and workflow-node configs alike, and
 * from the API — and `thinking.level` is the only way to ask for more or less
 * reasoning. This converts what is stored, with the mapping the adapters
 * already applied (`BaseAdapter.resolveReasoningEffort`, before this release
 * dropped its budget half):
 *
 *     0        → minimal
 *     -1       → medium       ("dynamic": let the model decide)
 *     1..100   → low
 *     101..500 → medium
 *     > 500    → high
 *
 * Every provider is in scope. V104 already did this for Google models, on its
 * way to retiring Gemini 2.x; this picks up Anthropic, OpenAI, vLLM and
 * anything else, plus the app and workflow configs V104 never looked at.
 *
 * Apps additionally gain a level they never had: the app `thinking` block
 * accepted only `enabled`, `budget` and `thoughts`, so an app could not express
 * a reasoning level at all — it could only spell one as a number, which is how
 * the confusion got in.
 */

export const version = '105';
export const description = 'thinking_level_not_budget';

/**
 * A thinking budget as the reasoning level it always resolved to.
 *
 * @param {number} budget - the stored `thinking.budget`
 * @returns {'minimal'|'low'|'medium'|'high'}
 */
function budgetToLevel(budget) {
  if (budget === 0) return 'minimal';
  if (budget === -1) return 'medium';
  if (budget > 0 && budget <= 100) return 'low';
  if (budget > 100 && budget <= 500) return 'medium';
  return 'high';
}

/**
 * Rewrite one `thinking` block in place.
 *
 * @param {object} ctx - migration context
 * @param {string} where - path for the log line
 * @param {object|undefined} thinking - the block (mutated)
 * @returns {boolean} true when it changed
 */
function convert(ctx, where, thinking) {
  if (!thinking || typeof thinking !== 'object') return false;
  if (thinking.budget === undefined) return false;

  const budget = thinking.budget;
  delete thinking.budget;

  if (thinking.level !== undefined) {
    ctx.log(`${where}: dropped stale thinking.budget ${budget}; kept level "${thinking.level}"`);
    return true;
  }

  if (typeof budget === 'number' && Number.isFinite(budget)) {
    thinking.level = budgetToLevel(budget);
    ctx.log(`${where}: thinking.budget ${budget} → level "${thinking.level}"`);
  } else {
    ctx.warn(
      `${where}: thinking.budget was ${JSON.stringify(budget)}, not a number — ` +
        `dropped it and left the level to the provider default`
    );
  }
  return true;
}

/**
 * Walk every workflow node, since a node may override its model's thinking.
 *
 * @param {object} ctx - migration context
 * @param {string} file - workflow filename, for the log
 * @param {object} workflow - the workflow config (mutated)
 * @returns {boolean} true when any node changed
 */
function convertWorkflowNodes(ctx, file, workflow) {
  const nodes = Array.isArray(workflow?.nodes) ? workflow.nodes : [];
  let changed = false;
  for (const node of nodes) {
    const thinking = node?.config?.thinking ?? node?.thinking;
    if (convert(ctx, `workflows/${file}:${node?.id ?? '?'}`, thinking)) changed = true;
  }
  return changed;
}

export async function up(ctx) {
  const counts = { models: 0, apps: 0, workflows: 0 };

  for (const [dir, key] of [
    ['models', 'models'],
    ['apps', 'apps']
  ]) {
    for (const file of await ctx.listFiles(dir, '*.json')) {
      const path = `${dir}/${file}`;
      let config;
      try {
        config = await ctx.readJson(path);
      } catch (error) {
        // Not this migration's file to repair, and throwing would block every
        // later migration on startup.
        ctx.warn(`Skipped ${path}: ${error.message}`);
        continue;
      }
      if (convert(ctx, path, config?.thinking)) {
        await ctx.writeJson(path, config);
        counts[key] += 1;
      }
    }
  }

  for (const file of await ctx.listFiles('workflows', '*.json')) {
    const path = `workflows/${file}`;
    let workflow;
    try {
      workflow = await ctx.readJson(path);
    } catch (error) {
      ctx.warn(`Skipped ${path}: ${error.message}`);
      continue;
    }
    let changed = convert(ctx, path, workflow?.thinking);
    if (convertWorkflowNodes(ctx, file, workflow)) changed = true;
    if (changed) {
      await ctx.writeJson(path, workflow);
      counts.workflows += 1;
    }
  }

  const total = counts.models + counts.apps + counts.workflows;
  if (total === 0) {
    ctx.log('No thinking.budget left to convert');
    return;
  }
  ctx.log(
    `Moved thinking.budget to thinking.level in ${counts.models} model(s), ` +
      `${counts.apps} app(s) and ${counts.workflows} workflow(s)`
  );
}
