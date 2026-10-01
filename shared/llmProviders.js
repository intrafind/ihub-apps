/**
 * LLM provider entries (`config/providers.json`) and the models linked to them.
 * Shared by the server (API key lookup, admin routes) and the admin UI.
 *
 * A model's `provider` field is its API type — the adapter that speaks to the
 * endpoint (`openai`, `local`, `anthropic`, …). The provider entry that holds
 * its API key is found by `model.providerId`, falling back to `model.provider`
 * itself: the built-in entries (`openai`, `anthropic`, …) are named after
 * their API type, so existing models need no link.
 *
 * A custom LLM provider — a gateway such as T-Systems AI Foundation Services
 * (LLM Hub) — declares the API type its endpoint speaks in `apiType`, and its
 * models carry `providerId`. One key on the provider then serves all of them.
 */

/**
 * Provider entries named after an API type. They are never deleted, and their
 * API type is their id.
 */
export const BUILT_IN_LLM_PROVIDERS = Object.freeze([
  'openai',
  'anthropic',
  'google',
  'mistral',
  'local',
  'bedrock'
]);

/** API types a custom LLM provider can declare (the chat adapters with an HTTP endpoint). */
export const CUSTOM_PROVIDER_API_TYPES = Object.freeze([
  'openai',
  'local',
  'mistral',
  'openai-responses',
  'anthropic',
  'google'
]);

/** True for an entry an admin created for an LLM gateway of their own. */
export function isCustomLlmProvider(provider) {
  return Boolean(
    provider &&
    provider.category === 'llm' &&
    typeof provider.apiType === 'string' &&
    !BUILT_IN_LLM_PROVIDERS.includes(provider.id)
  );
}

/**
 * The API type (adapter) of a provider entry: its `apiType` for a custom LLM
 * provider, its id for a built-in one, null for anything else.
 */
export function getProviderApiType(provider) {
  if (!provider) return null;
  if (isCustomLlmProvider(provider)) return provider.apiType;
  if (BUILT_IN_LLM_PROVIDERS.includes(provider.id)) return provider.id;
  return null;
}

/** Id of the provider entry a model takes its API key from. */
export function getModelProviderId(model) {
  return model?.providerId || model?.provider || null;
}

/** Models whose API key comes from the provider entry `providerId`. */
export function getLinkedModels(providerId, models) {
  return (models || []).filter(model => getModelProviderId(model) === providerId);
}

/**
 * Environment variable a provider's key can be set in: `LLMHUB_API_KEY` for a
 * provider with id `llmhub`, `T_SYSTEMS_API_KEY` for `t-systems`.
 */
export function providerEnvKeyName(providerId) {
  return `${String(providerId)
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, '_')}_API_KEY`;
}
