/**
 * Migration V163 — `supportsTools` becomes a three-state setting
 *
 * A model's `supportsTools` was a yes/no flag. "Can be given tools" and "can be
 * made to call one" are different questions, though: an app that requires a
 * tool call (`toolChoice: "required"`) can only have it enforced when the
 * provider accepts a forced tool choice, and some do not (Claude Opus 5.5,
 * Sonnet 5.5 and Fable 5.1 reject it). The flag is now one of:
 *
 * - `none`     — no tools (was `false`)
 * - `auto`     — tools; the model decides whether to call one
 * - `required` — tools, and the provider accepts a forced tool call
 *
 * 1. **Models.** `true` becomes `required` where the provider's API takes a
 *    forced tool choice (OpenAI, OpenAI Responses, Mistral, Google chat models,
 *    Bedrock's Claude and Nova models) and `auto` everywhere else: a model that
 *    cannot be told to use a tool is asked in words, which works on any model,
 *    and a model that was `required` by mistake is found out on its first
 *    forced call, so neither guess breaks a chat. `false` becomes `none`.
 * 2. **App model filters.** `settings.model.filter` compares properties of the
 *    model as they are, so `{ "supportsTools": true }` no longer matches
 *    anything. It becomes `["auto", "required"]` (a filter value that is an
 *    array matches any of its entries) and `false` becomes `"none"`.
 *
 * Idempotent: only the old boolean values are rewritten.
 */

const PROVIDERS_TAKING_FORCED_CALLS = new Set(['openai', 'openai-responses', 'mistral']);

export const version = '163';
export const description = 'tool_support_levels';

/** The level a model that had `supportsTools: true` gets. */
function levelForToolModel(model) {
  const upstreamId = String(model.modelId || model.id || '');
  if (model.provider === 'bedrock') {
    return /anthropic\.claude|amazon\.nova/i.test(upstreamId) ? 'required' : 'auto';
  }
  if (model.provider === 'google') return /image/i.test(upstreamId) ? 'auto' : 'required';
  return PROVIDERS_TAKING_FORCED_CALLS.has(model.provider) ? 'required' : 'auto';
}

function convertedModel(model) {
  if (typeof model?.supportsTools !== 'boolean') return null;
  return { ...model, supportsTools: model.supportsTools ? levelForToolModel(model) : 'none' };
}

function convertedApp(app) {
  const filter = app?.settings?.model?.filter;
  if (!filter || typeof filter !== 'object' || typeof filter.supportsTools !== 'boolean') {
    return null;
  }
  const supportsTools = filter.supportsTools ? ['auto', 'required'] : 'none';
  return {
    ...app,
    settings: {
      ...app.settings,
      model: { ...app.settings.model, filter: { ...filter, supportsTools } }
    }
  };
}

/** Every JSON file of a directory with what `convert` makes of it (null: leave it). */
async function convertedFiles(ctx, directory, convert) {
  if (!(await ctx.fileExists(directory))) return [];
  const names = await ctx.listFiles(directory, '*.json');
  const changes = [];
  for (const name of names) {
    const path = `${directory}/${name}`;
    let data;
    try {
      data = await ctx.readJson(path);
    } catch (err) {
      ctx.warn(`Skipping ${path}: ${err.message}`);
      continue;
    }
    const next = convert(data);
    if (next) changes.push({ path, next });
  }
  return changes;
}

async function pendingChanges(ctx) {
  const [models, apps] = await Promise.all([
    convertedFiles(ctx, 'models', convertedModel),
    convertedFiles(ctx, 'apps', convertedApp)
  ]);
  return { models, apps };
}

export async function precondition(ctx) {
  const { models, apps } = await pendingChanges(ctx);
  return models.length + apps.length > 0;
}

export async function up(ctx) {
  const { models, apps } = await pendingChanges(ctx);
  for (const { path, next } of [...models, ...apps]) {
    await ctx.writeJson(path, next);
  }
  ctx.log(
    `Converted supportsTools on ${models.length} model(s) and ${apps.length} app model filter(s) to none/auto/required`
  );
}
