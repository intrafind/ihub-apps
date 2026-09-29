export const version = '135';
export const description = 'raise_bundled_output_token_limits';

export async function precondition(ctx) {
  return await ctx.fileExists('models');
}

/** Bundled model id → the limit it shipped with, and the one it ships with now. */
const RAISED = {
  'claude-haiku-4-5': { from: 8000, to: 64000 },
  'mistral-large': { from: 8000, to: 32000 },
  'mistral-medium': { from: 8000, to: 32000 },
  'mistral-small': { from: 8000, to: 32000 },
  'local-vllm': { from: 8000, to: 16000 }
};

/**
 * A reasoning model spends its thinking tokens from the output cap, so 8000 could
 * be used up before the answer started (finish_reason "length", empty answer).
 * The bundled models now ship with a higher cap; this raises the installed copies.
 *
 * Only a model still carrying the exact value it shipped with is changed. A cap an
 * admin set themselves — higher or lower — is a decision and stays as it is.
 */
export async function up(ctx) {
  for (const file of await ctx.listFiles('models', '*.json')) {
    const path = `models/${file}`;
    let model;
    try {
      model = await ctx.readJson(path);
    } catch {
      continue;
    }
    const raise = RAISED[model?.id];
    if (!raise || model.maxOutputTokens !== raise.from) continue;
    model.maxOutputTokens = raise.to;
    await ctx.writeJson(path, model);
    ctx.log(`${path}: maxOutputTokens ${raise.from} -> ${raise.to}`);
  }
}
