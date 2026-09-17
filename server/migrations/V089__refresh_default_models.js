/**
 * Migration V089 — refresh the default model catalog (issue #2282)
 *
 * The shipped defaults had drifted behind every provider's current lineup, and
 * three of the entries were actively broken on an existing install:
 *
 *  1. **Gemini thinking config.** Every Gemini 3.x default still carried the
 *     Gemini 2.5 `thinking: { budget, thoughts }` shape. Google's Gemini 3
 *     endpoints reject those fields with a bare 400 INVALID_ARGUMENT, so any
 *     app on `gemini-flash-latest` (the shipped default model) failed as soon
 *     as Google moved the alias to Gemini 3. The fix is `thinking.level`.
 *  2. **Retired models.** `gpt-4` (8K context), `claude-4-opus` /
 *     `claude-4-sonnet` (pointing at Claude 4.6 ids) and
 *     `gemini-3.1-flash-lite` (a preview id that now has a stable release)
 *     were all superseded.
 *  3. **`gpt-oss-vllm`.** Shipped enabled and pointing at `http://hal9000:1897`
 *     — a developer's machine. It appeared in every installation's model
 *     selector and failed on use.
 *
 * Removal is deliberately conservative: a model file is only deleted when it
 * still matches the default we shipped (same `modelId` and `url`). An admin who
 * repointed the file at their own endpoint keeps it, disabled and annotated, so
 * their configuration is never silently thrown away. Apps that referenced a
 * removed model are repointed to the replacement so they keep working.
 *
 * New models are seeded with `addIfMissing` semantics — an existing file with
 * the same id is left completely alone.
 */
export const version = '089';
export const description = 'refresh_default_models';

/**
 * Models that are no longer shipped. `modelId` / `url` are the values the
 * retired default carried; a file that still matches them is untouched by the
 * admin and safe to delete. `replacement` repoints apps that referenced it.
 */
const RETIRED_MODELS = [
  {
    id: 'gpt-4',
    modelId: 'gpt-4',
    url: 'https://api.openai.com/v1/chat/completions',
    replacement: 'gpt-5',
    reason: 'superseded by GPT-5'
  },
  {
    id: 'claude-4-opus',
    modelId: 'claude-opus-4-6',
    url: 'https://api.anthropic.com/v1/messages',
    replacement: 'claude-opus-5',
    reason: 'superseded by Claude Opus 5'
  },
  {
    id: 'claude-4-sonnet',
    modelId: 'claude-sonnet-4-6',
    url: 'https://api.anthropic.com/v1/messages',
    replacement: 'claude-sonnet-5',
    reason: 'superseded by Claude Sonnet 5'
  },
  {
    id: 'gemini-3.1-flash-lite',
    modelId: 'gemini-3.1-flash-lite-preview',
    url: 'https://generativelanguage.googleapis.com/v1beta/models/gemini-3.1-flash-lite-preview:streamGenerateContent',
    replacement: 'gemini-3.5-flash-lite',
    reason: 'preview id superseded by the stable Gemini 3.5 Flash Lite release'
  },
  {
    id: 'gpt-oss-vllm',
    modelId: 'openai/gpt-oss-20b',
    url: 'http://hal9000:1897/v1/chat/completions',
    replacement: 'gemini-flash-latest',
    reason: 'shipped by mistake pointing at a private development host'
  }
];

/** Models added to the default catalog by this migration. */
const NEW_MODELS = [
  'claude-opus-5.json',
  'claude-sonnet-5.json',
  'claude-fable-5-1.json',
  'gemini-3.8-flash.json',
  'gemini-3.5-flash-lite.json',
  'gemini-3.1-flash-lite-image.json',
  'gemini-3.5-transcribe-live.json',
  'gemini-3.5-transcribe.json'
];

/**
 * Existing model files whose shipped defaults changed. Each entry patches only
 * the fields that were wrong, and only when the file still carries the old
 * value — so an admin's own choice always wins.
 */
const PATCHES = [
  // Gemini 3.x models: replace the Gemini 2.5 thinking shape (400s on Gemini 3)
  // with the `level` shape the Gemini 3 endpoints expect.
  { id: 'gemini-flash-latest', thinkingLevel: 'medium' },
  { id: 'gemini-flash-lite-latest', thinkingLevel: 'low' },
  { id: 'gemini-3.1-pro', thinkingLevel: 'high' },
  {
    id: 'gemini-3.1-flash-image',
    thinkingLevel: 'low',
    // Google promoted Nano Banana 2 out of preview; the preview id is retired.
    modelId: { from: 'gemini-3.1-flash-image-preview', to: 'gemini-3.1-flash-image' },
    url: {
      from: 'https://generativelanguage.googleapis.com/v1beta/models/gemini-3.1-flash-image-preview:streamGenerateContent',
      to: 'https://generativelanguage.googleapis.com/v1beta/models/gemini-3.1-flash-image:streamGenerateContent'
    }
  },
  {
    id: 'gemini-3-pro-image',
    thinkingLevel: 'high',
    // Nano Banana Pro is stable too, but the shipped file's `url` still carried
    // the `-preview` suffix while its `modelId` did not.
    url: {
      from: 'https://generativelanguage.googleapis.com/v1beta/models/gemini-3-pro-image-preview:streamGenerateContent',
      to: 'https://generativelanguage.googleapis.com/v1beta/models/gemini-3-pro-image:streamGenerateContent'
    }
  }
];

// Only run on an installed instance; fresh installs get the new defaults from
// performInitialSetup.
export async function precondition(ctx) {
  return await ctx.fileExists('config/platform.json');
}

/**
 * Retire one model file: delete it when untouched, otherwise disable it and
 * record why so the admin can see what happened without losing their config.
 *
 * @returns {'deleted'|'kept'|'absent'}
 */
async function retireModel(ctx, entry) {
  const file = `models/${entry.id}.json`;
  if (!(await ctx.fileExists(file))) return 'absent';

  let model;
  try {
    model = await ctx.readJson(file);
  } catch {
    ctx.warn(`Could not read ${file}; leaving it in place`);
    return 'kept';
  }

  const untouched = model?.modelId === entry.modelId && model?.url === entry.url;
  if (untouched) {
    await ctx.deleteFile(file);
    ctx.log(`Removed retired model ${entry.id} (${entry.reason})`);
    return 'deleted';
  }

  if (model.enabled === false) {
    ctx.log(`Retired model ${entry.id} was customized and is already disabled; leaving as is`);
    return 'kept';
  }
  // Disable rather than delete, and say so in the log — the file is the admin's
  // configuration now, not ours. No marker field is written: the model schema
  // is strict, and an unknown key would warn on every startup.
  model.enabled = false;
  await ctx.writeJson(file, model);
  ctx.log(
    `Retired model ${entry.id} was customized; disabled it instead of deleting (${entry.reason}). ` +
      `Replacement: ${entry.replacement}. Re-enable it in Admin → Models if you still need it.`
  );
  return 'kept';
}

/** Seed one new default model file, never overwriting an existing one. */
async function seedModel(ctx, file) {
  const target = `models/${file}`;
  if (await ctx.fileExists(target)) return false;
  let model;
  try {
    model = await ctx.readDefaultJson(`models/${file}`);
  } catch {
    ctx.warn(`Default model ${file} not found in server/defaults; skipping`);
    return false;
  }
  await ctx.writeJson(target, model);
  return true;
}

/**
 * Apply one patch entry to a model file. Field rewrites are conditional on the
 * old value still being in place; the thinking rewrite only fires when the file
 * still carries the Gemini 2.5 shape.
 *
 * @returns {Promise<boolean>} true when the file was written
 */
async function patchModel(ctx, patch) {
  const file = `models/${patch.id}.json`;
  if (!(await ctx.fileExists(file))) return false;

  let model;
  try {
    model = await ctx.readJson(file);
  } catch {
    ctx.warn(`Could not read ${file}; skipping patch`);
    return false;
  }

  let changed = false;

  for (const field of ['modelId', 'url']) {
    const rule = patch[field];
    if (rule && model[field] === rule.from) {
      model[field] = rule.to;
      changed = true;
    }
  }

  // The Gemini 2.5 fields are what 400s on a Gemini 3 endpoint. Rewrite only
  // when they are present and no explicit `level` has been set by an admin.
  if (patch.thinkingLevel && model.thinking && !model.thinking.level) {
    if ('budget' in model.thinking || 'thoughts' in model.thinking) {
      delete model.thinking.budget;
      delete model.thinking.thoughts;
      model.thinking.level = patch.thinkingLevel;
      changed = true;
    }
  }

  if (patch.supportsTemperature === false && model.supportsTemperature === undefined) {
    model.supportsTemperature = false;
    changed = true;
  }

  if (changed) await ctx.writeJson(file, model);
  return changed;
}

/**
 * Repoint apps that named a removed model, so they fall back to the replacement
 * instead of an id that no longer resolves.
 */
async function repointApps(ctx, removedIds) {
  if (removedIds.size === 0) return;
  const replacementFor = new Map(RETIRED_MODELS.map(m => [m.id, m.replacement]));
  const files = await ctx.listFiles('apps', '*.json');
  let patched = 0;

  for (const file of files) {
    let app;
    try {
      app = await ctx.readJson(`apps/${file}`);
    } catch {
      continue;
    }
    if (!app || typeof app !== 'object') continue;

    let changed = false;
    if (removedIds.has(app.preferredModel)) {
      const replacement = replacementFor.get(app.preferredModel);
      ctx.log(`apps/${file}: preferredModel ${app.preferredModel} → ${replacement}`);
      app.preferredModel = replacement;
      changed = true;
    }
    if (Array.isArray(app.allowedModels)) {
      const next = app.allowedModels
        .map(id => (removedIds.has(id) ? replacementFor.get(id) : id))
        .filter(Boolean);
      const deduped = [...new Set(next)];
      if (deduped.join(' ') !== app.allowedModels.join(' ')) {
        app.allowedModels = deduped;
        changed = true;
      }
    }

    if (changed) {
      await ctx.writeJson(`apps/${file}`, app);
      patched += 1;
    }
  }
  if (patched > 0) ctx.log(`Repointed ${patched} app(s) away from removed models`);
}

export async function up(ctx) {
  // 1. Retire superseded models.
  const removedIds = new Set();
  for (const entry of RETIRED_MODELS) {
    if ((await retireModel(ctx, entry)) === 'deleted') removedIds.add(entry.id);
  }

  // 2. Repoint apps that referenced them.
  await repointApps(ctx, removedIds);

  // 3. Seed the new models.
  const seeded = [];
  for (const file of NEW_MODELS) {
    if (await seedModel(ctx, file)) seeded.push(file.replace(/\.json$/, ''));
  }
  if (seeded.length) ctx.log(`Seeded new default models: ${seeded.join(', ')}`);
  else ctx.log('No new default models to seed');

  // 4. Fix the existing files whose shipped defaults were wrong.
  const patched = [];
  for (const patch of PATCHES) {
    if (await patchModel(ctx, patch)) patched.push(patch.id);
  }
  if (patched.length) {
    ctx.log(`Updated model defaults: ${[...new Set(patched)].join(', ')}`);
  }

  ctx.log(
    'Gemini transcription models (gemini-3.5-transcribe, gemini-3.5-transcribe-live) are seeded disabled; enable one and set GOOGLE_API_KEY to use it'
  );
}
