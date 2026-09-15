/**
 * Migration V104 — one Gemini thinking shape, and it is `thinking.level`
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
 * Gemini 3 is the floor now. The adapter speaks only `thinkingLevel`, so
 * `thinking.budget` on a Google model is inert — it asks for reasoning
 * settings that are no longer sent — and the model schema rejects it outright
 * so an admin saving such a config is told rather than left guessing.
 *
 * This converts what is already stored, using the same budget → effort mapping
 * `BaseAdapter.resolveReasoningEffort` has always applied for the providers
 * that still read a budget, so a model's reasoning effort lands where the rest
 * of the codebase would have put it:
 *
 *     0        → minimal      (thinking off in 2.5 terms)
 *     -1       → medium       (2.5's "dynamic", the model decides)
 *     1..100   → low
 *     101..500 → medium
 *     > 500    → high
 *
 * Only Google models are touched. Anthropic reads `thinking.budget` as
 * `budget_tokens` and the OpenAI Responses adapter maps it to a reasoning
 * effort, so on every other provider it stays exactly as it is.
 *
 * A model that already declares `thinking.level` keeps that level — the
 * stale `budget` beside it is simply dropped. Genuine Gemini 2.x models are
 * not deleted or disabled here, because a model file may be an operator's own
 * endpoint and losing it would be worse than the warning: they are converted
 * like any other and named in the log, since their thinking will not work
 * against a 2.x endpoint any more.
 */

export const version = '104';
export const description = 'gemini_thinking_level_only';

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

export async function up(ctx) {
  const files = await ctx.listFiles('models', '*.json');
  let converted = 0;
  const legacy = [];

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
    if (!model.thinking || model.thinking.budget === undefined) continue;

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

    if (isLegacyGemini(model)) legacy.push(model.modelId || model.id || file);

    await ctx.writeJson(path, model);
    converted += 1;
  }

  if (converted > 0) {
    ctx.log(`Moved ${converted} Google model(s) onto thinking.level`);
  }
  if (legacy.length > 0) {
    ctx.warn(
      `Gemini 2.x models found (${legacy.join(', ')}). iHub now sends only the Gemini 3 ` +
        `thinkingConfig, which a 2.x endpoint rejects — repoint these at a Gemini 3 model ` +
        `or turn their thinking off.`
    );
  }
}
