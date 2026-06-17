export const version = '058';
export const description = 'split_token_limits';

// Per-provider default output cap (max_tokens). These are NOT the old
// context-sized tokenLimit values — they are sensible response limits.
// Admins can raise them per model afterwards.
const OUTPUT_DEFAULTS = {
  anthropic: 16000,
  'openai-responses': 32000,
  openai: 4096,
  google: 8192,
  mistral: 8000,
  bedrock: 8000,
  local: 4096
};
const FALLBACK_OUTPUT = 4096;

export async function precondition(ctx) {
  const models = await ctx.listFiles('models', '*.json');
  const apps = await ctx.listFiles('apps', '*.json');
  return models.length > 0 || apps.length > 0;
}

export async function up(ctx) {
  // 1. Models: rename tokenLimit -> contextWindow, seed maxOutputTokens.
  const modelFiles = await ctx.listFiles('models', '*.json');
  let migratedModels = 0;
  for (const file of modelFiles) {
    const path = `models/${file}`;
    const model = await ctx.readJson(path);
    if (!model || typeof model !== 'object') continue;

    let changed = false;

    // The old tokenLimit values were context-window sized, so they map
    // directly to contextWindow.
    if (model.tokenLimit !== undefined && model.contextWindow === undefined) {
      ctx.renameKey(model, 'tokenLimit', 'contextWindow');
      changed = true;
    } else if (model.tokenLimit !== undefined) {
      // contextWindow already set (re-run / hand-edited): just drop the legacy key.
      ctx.removeKey(model, 'tokenLimit');
      changed = true;
    }

    // Seed an output cap that is NOT the context-sized value, clamped so it
    // never exceeds the context window.
    if (model.maxOutputTokens === undefined) {
      const base = OUTPUT_DEFAULTS[model.provider] ?? FALLBACK_OUTPUT;
      model.maxOutputTokens =
        typeof model.contextWindow === 'number' && model.contextWindow > 0
          ? Math.min(base, model.contextWindow)
          : base;
      changed = true;
    }

    if (changed) {
      await ctx.writeJson(path, model);
      migratedModels++;
    }
  }
  ctx.log(`Migrated ${migratedModels} model config(s) to contextWindow/maxOutputTokens`);

  // 2. Apps: strip the now-removed tokenLimit field entirely.
  const appFiles = await ctx.listFiles('apps', '*.json');
  let migratedApps = 0;
  for (const file of appFiles) {
    const path = `apps/${file}`;
    const app = await ctx.readJson(path);
    if (!app || typeof app !== 'object') continue;
    if (app.tokenLimit !== undefined) {
      ctx.removeKey(app, 'tokenLimit');
      await ctx.writeJson(path, app);
      migratedApps++;
    }
  }
  ctx.log(`Removed tokenLimit from ${migratedApps} app config(s)`);
}
