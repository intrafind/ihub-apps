// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * Migration V184 — base URLs for the built-in LLM providers
 *
 * Admin → Models → Import from URL fills the endpoint URL from the selected
 * provider's `baseUrl`. The built-in OpenAI, Anthropic, Google and Mistral
 * entries shipped without one, so the admin had to look up and type the API
 * base of a vendor iHub already knows. They now carry their public API base,
 * which stays editable under Admin → Providers (for a proxy or a regional
 * endpoint) and in the import dialog itself.
 *
 * Only an entry without a `baseUrl` gets one: a URL the admin set is kept.
 * `local` has no well-known address and gets none.
 */

export const version = '184';
export const description = 'Add API base URLs to the built-in LLM providers';

/** Snapshot of the `baseUrl`s in server/defaults/config/providers.json as of V184. */
const BASE_URLS = {
  openai: 'https://api.openai.com/v1',
  anthropic: 'https://api.anthropic.com/v1',
  google: 'https://generativelanguage.googleapis.com/v1beta',
  mistral: 'https://api.mistral.ai/v1'
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

  const added = [];
  for (const provider of config.providers) {
    const baseUrl = BASE_URLS[provider?.id];
    if (!baseUrl || provider.baseUrl) continue;
    provider.baseUrl = baseUrl;
    added.push(provider.id);
  }

  if (added.length === 0) {
    ctx.log('Built-in LLM providers already have a base URL — nothing to do');
    return;
  }
  await ctx.writeJson('config/providers.json', config);
  ctx.log(`Added a base URL to the providers: ${added.join(', ')}`);
}
