/**
 * Migration V104 — Gemini 3 and forward, on one thinking shape
 *
 * Gemini shipped two `thinkingConfig` schemas and they were never
 * interchangeable: Gemini 2.5 takes `thinkingBudget`, Gemini 3 takes
 * `thinkingLevel`, and each returns a bare `400 INVALID_ARGUMENT` — naming no
 * field — when handed the other's. The Google adapter carried both and picked
 * per model config, which meant every Gemini model had to declare which era it
 * belonged to, and a config left on the old shape failed silently the moment
 * Google moved a `-latest` alias forward. V089 had already rewritten the
 * shipped defaults once for exactly that reason.
 *
 * Gemini 3 is the floor now. The adapter speaks only `thinkingLevel`, so this
 * migration does two things:
 *
 * 1. **Converts what is still on the old shape.** Every `provider: "google"`
 *    model carrying `thinking.budget` moves to `thinking.level`, using the same
 *    budget → effort mapping `BaseAdapter.resolveReasoningEffort` has always
 *    applied for the providers that still read a budget:
 *
 *        0        → minimal      (thinking off in 2.5 terms)
 *        -1       → medium       (2.5's "dynamic", the model decides)
 *        1..100   → low
 *        101..500 → medium
 *        > 500    → high
 *
 *    Only Google models are touched. Anthropic reads `thinking.budget` as
 *    `budget_tokens` and the OpenAI Responses adapter maps it to a reasoning
 *    effort, so on every other provider it stays exactly as it is.
 *
 * 2. **Retires the Gemini 2.x models themselves.** A 2.x endpoint rejects the
 *    only thinkingConfig iHub now sends, so these models cannot serve a
 *    thinking request at all. They follow V089's retirement semantics, which
 *    is how this repo has always removed a model:
 *
 *      - A file still matching a shipped Gemini 2.x example (same `modelId`
 *        and `url`) is **deleted** — it is our configuration, not the admin's.
 *      - A file that was customized is **disabled** and the reason logged. It
 *        may point at an operator's own Vertex or proxy endpoint, and the URL,
 *        headers and per-model key in it cannot be reconstructed from anywhere
 *        else. Disabled takes it out of every model selector just as deletion
 *        would; re-enabling is a click in Admin → Models if they disagree.
 *
 *    Apps are repointed away from every retired model, disabled ones included —
 *    V089 repointed only the deleted, but an app whose `preferredModel` is
 *    disabled has no model at all, which is the worse failure.
 */

export const version = '104';
export const description = 'gemini_3_only';

/** Providers routed through the Google adapter. */
const GEMINI_PROVIDERS = ['google'];

/**
 * A Gemini 2.5 thinking budget as a Gemini 3 reasoning level.
 *
 * Mirrors `BaseAdapter.resolveReasoningEffort`, which is what every other
 * adapter still does with a budget.
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

/** True for a model id that names a Gemini generation older than 3. */
function isLegacyGemini(model) {
  const id = String(model.modelId || model.id || '');
  return /gemini-[0-2](\.|-|$)/i.test(id);
}

/**
 * The Gemini 2.x configs iHub shipped as examples, by `id`. A stored file whose
 * `modelId` and `url` still match one of these has never been edited, so
 * deleting it loses nothing. `replacement` repoints apps that referenced it.
 */
const SHIPPED_LEGACY_MODELS = {
  'gemini-2.0-flash': {
    modelId: 'gemini-2.0-flash',
    url: 'https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:streamGenerateContent',
    replacement: 'gemini-3.8-flash'
  },
  'gemini-2.5-flash': {
    modelId: 'gemini-2.5-flash',
    url: 'https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:streamGenerateContent',
    replacement: 'gemini-3.8-flash'
  },
  'gemini-2.5-flash-lite': {
    modelId: 'gemini-2.5-flash-lite',
    url: 'https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash-lite-preview-06-17:streamGenerateContent',
    replacement: 'gemini-3.5-flash-lite'
  },
  'gemini-2.5-pro': {
    modelId: 'gemini-2.5-pro',
    url: 'https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-pro:streamGenerateContent',
    replacement: 'gemini-3.1-pro'
  },
  'gemini-2.5-flash-image': {
    modelId: 'gemini-2.5-flash-image',
    url: 'https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash-image:streamGenerateContent',
    replacement: 'gemini-3.1-flash-image'
  }
};

/** Where an unrecognised Gemini 2.x model's apps are sent instead. */
const FALLBACK_REPLACEMENT = 'gemini-3.8-flash';

/**
 * The Gemini 3 model that should inherit a retired model's traffic.
 *
 * @param {object} model - the retired model config
 * @returns {string}
 */
function replacementFor(model) {
  return SHIPPED_LEGACY_MODELS[model.id]?.replacement ?? FALLBACK_REPLACEMENT;
}

/**
 * True when the stored file is still the example iHub shipped, rather than an
 * operator's own endpoint wearing the same id.
 *
 * @param {object} model - the stored model config
 * @returns {boolean}
 */
function isUnmodifiedShippedExample(model) {
  const shipped = SHIPPED_LEGACY_MODELS[model.id];
  return !!shipped && model.modelId === shipped.modelId && model.url === shipped.url;
}

/**
 * Move one model's `thinking` block off the retired budget shape, in place.
 *
 * @param {object} ctx - migration context
 * @param {string} path - the model's path, for logging
 * @param {object} model - the model config (mutated)
 * @returns {boolean} true when the block changed and the file needs writing
 */
function convertThinkingShape(ctx, path, model) {
  if (!model.thinking || model.thinking.budget === undefined) return false;

  const budget = model.thinking.budget;
  delete model.thinking.budget;

  if (model.thinking.level === undefined) {
    if (typeof budget === 'number' && Number.isFinite(budget)) {
      model.thinking.level = budgetToLevel(budget);
      ctx.log(`${path}: thinking.budget ${budget} → level "${model.thinking.level}"`);
    } else {
      ctx.warn(
        `${path}: thinking.budget was ${JSON.stringify(budget)}, not a number — ` +
          `dropped it and left the level to Gemini`
      );
    }
  } else {
    ctx.log(
      `${path}: dropped stale thinking.budget ${budget}; kept level "${model.thinking.level}"`
    );
  }
  return true;
}

export async function up(ctx) {
  const files = await ctx.listFiles('models', '*.json');
  let converted = 0;
  let deleted = 0;
  let disabled = 0;
  /** @type {Map<string, string>} retired model id → replacement model id */
  const retired = new Map();
  /** @type {string[]} retired models that were somebody's system-wide default */
  const wasDefault = [];

  for (const file of files) {
    const path = `models/${file}`;
    let model;
    try {
      model = await ctx.readJson(path);
    } catch (error) {
      // A model file that does not parse is not this migration's to repair,
      // and throwing here would block every later migration on startup.
      ctx.warn(`Skipped ${path}: ${error.message}`);
      continue;
    }

    if (!GEMINI_PROVIDERS.includes(model.provider)) continue;

    // The thinking shape is converted first, for retired models too. A model
    // that is disabled rather than deleted stays on disk and stays validated on
    // every startup, and the schema now rejects `thinking.budget` on Google —
    // so leaving the old key on it would trade one silent failure for a warning
    // on every boot, forever.
    const convertedThinking = convertThinkingShape(ctx, path, model);

    // ── Retire Gemini 2.x ──────────────────────────────────────────────────
    if (isLegacyGemini(model)) {
      const replacement = replacementFor(model);
      const modelId = model.modelId || model.id || file;
      if (model.default === true) wasDefault.push(modelId);
      retired.set(model.id, replacement);

      if (isUnmodifiedShippedExample(model)) {
        await ctx.deleteFile(path);
        deleted += 1;
        ctx.log(`Removed Gemini 2.x model ${modelId}; apps repointed to ${replacement}`);
        continue;
      }

      if (model.enabled === false) {
        if (convertedThinking) await ctx.writeJson(path, model);
        ctx.log(`Gemini 2.x model ${modelId} is already disabled; leaving it disabled`);
        continue;
      }

      // Disable rather than delete: this file is the admin's configuration
      // now — possibly their own Vertex or proxy endpoint — and nothing else
      // records its url, headers or per-model key. No marker field is written;
      // the model schema is strict and an unknown key warns on every startup.
      model.enabled = false;
      await ctx.writeJson(path, model);
      disabled += 1;
      ctx.log(
        `Gemini 2.x model ${modelId} was customized; disabled it instead of deleting. ` +
          `A 2.x endpoint rejects the Gemini 3 thinkingConfig iHub now sends. ` +
          `Replacement: ${replacement}. Re-enable it in Admin → Models if you still need it.`
      );
      continue;
    }

    if (convertedThinking) {
      await ctx.writeJson(path, model);
      converted += 1;
    }
  }

  if (converted > 0) ctx.log(`Moved ${converted} Google model(s) onto thinking.level`);
  if (deleted > 0 || disabled > 0) {
    ctx.log(
      `Retired ${deleted + disabled} Gemini 2.x model(s): ${deleted} removed, ${disabled} disabled`
    );
  }

  await repointApps(ctx, retired);

  if (wasDefault.length > 0) {
    ctx.warn(
      `Retired Gemini 2.x model(s) ${wasDefault.join(', ')} were marked as the system-wide ` +
        `default. No replacement was promoted — pick a new default in Admin → Models.`
    );
  }
}

/**
 * Point apps away from the retired models, so an app whose model just went away
 * still has one.
 *
 * @param {object} ctx - migration context
 * @param {Map<string, string>} retired - retired model id → replacement model id
 */
async function repointApps(ctx, retired) {
  if (retired.size === 0) return;

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

    if (retired.has(app.preferredModel)) {
      const replacement = retired.get(app.preferredModel);
      ctx.log(`apps/${file}: preferredModel ${app.preferredModel} → ${replacement}`);
      app.preferredModel = replacement;
      changed = true;
    }

    if (Array.isArray(app.allowedModels)) {
      const next = [
        ...new Set(
          app.allowedModels.map(id => (retired.has(id) ? retired.get(id) : id)).filter(Boolean)
        )
      ];
      if (next.join(' ') !== app.allowedModels.join(' ')) {
        app.allowedModels = next;
        changed = true;
      }
    }

    if (changed) {
      await ctx.writeJson(`apps/${file}`, app);
      patched += 1;
    }
  }

  if (patched > 0) ctx.log(`Repointed ${patched} app(s) away from retired Gemini 2.x models`);
}
