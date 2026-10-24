// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * Migration V183 — add OpenRouter as an LLM provider
 *
 * OpenRouter (one OpenAI-compatible API for the models of many vendors) ships
 * as a provider entry next to OpenAI, Anthropic and the others, so it shows up
 * under Admin → Providers with a field for its key and in the provider list of
 * Admin → Models → Import from URL. Before, it was only a preset that filled in
 * the new-provider form of the import dialog.
 *
 * The entry is an ordinary LLM provider with `apiType: "openai"`: models
 * imported into it carry `providerId: "openrouter"` and take its key, or
 * `OPENROUTER_API_KEY` when none is stored.
 */

export const version = '183';
export const description = 'Add the OpenRouter LLM provider';

/** Snapshot of the `openrouter` entry in server/defaults/config/providers.json as of V183. */
const OPENROUTER_PROVIDER = {
  id: 'openrouter',
  name: 'OpenRouter',
  description: 'OpenRouter — one API for models of many vendors',
  enabled: true,
  category: 'llm',
  apiType: 'openai',
  baseUrl: 'https://openrouter.ai/api/v1'
};

export async function precondition(ctx) {
  return await ctx.fileExists('config/providers.json');
}

export async function up(ctx) {
  const config = await ctx.readJson('config/providers.json');

  if (!config || !Array.isArray(config.providers)) {
    ctx.warn('providers.json has no providers array — skipping');
    return;
  }

  // An admin who already created it (the import dialog's preset used this ID)
  // keeps their entry and its API key.
  if (config.providers.some(p => p?.id === 'openrouter')) {
    ctx.log('OpenRouter provider already present — leaving it as configured');
    return;
  }

  // Keep the LLM providers together: insert after the last one.
  let index = -1;
  config.providers.forEach((p, i) => {
    if (!p?.category || p.category === 'llm') index = i;
  });
  config.providers.splice(index + 1, 0, { ...OPENROUTER_PROVIDER });
  await ctx.writeJson('config/providers.json', config);
  ctx.log('Added the openrouter LLM provider to providers.json');
}
