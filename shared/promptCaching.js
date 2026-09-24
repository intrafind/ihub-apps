/**
 * Prompt caching per model (issue #2508) — shared by the server (which sends
 * the cache hints) and the admin model editor (which shows the switch).
 *
 * Providers cache the start of a prompt they have seen recently and bill those
 * input tokens at a discount. Some do it on their own; for others iHub has to
 * mark what may be cached. A model's `promptCaching.enabled` switches iHub's
 * hints on or off:
 *
 * - OpenAI (Chat Completions and Responses): `prompt_cache_key`, which routes
 *   requests that share a prefix to the same cache. OpenAI caches with or
 *   without it; the key only raises the hit rate, and writes cost nothing.
 * - Anthropic: `cache_control` breakpoints on the tools, the system prompt and
 *   the latest user message.
 * - Bedrock (Converse): `cachePoint` blocks in the same places.
 *
 * Other providers (Google, Mistral, vLLM, …) cache on their own, if at all;
 * there is nothing to switch, so the setting does not apply to them.
 *
 * @module shared/promptCaching
 */

/** Providers whose adapter sends prompt-cache hints. */
export const PROMPT_CACHE_PROVIDERS = Object.freeze([
  'openai',
  'openai-responses',
  'anthropic',
  'bedrock'
]);

/** Whether the prompt-caching switch applies to models of this provider. */
export function supportsPromptCaching(provider) {
  return PROMPT_CACHE_PROVIDERS.includes(provider);
}

function isOpenAIApi(url) {
  try {
    return new URL(url).hostname === 'api.openai.com';
  } catch {
    return false;
  }
}

/**
 * Whether caching is on for a model that does not set `promptCaching.enabled`.
 *
 * - On for OpenAI's own API: caching happens anyway, the key only helps.
 * - Off for OpenAI-compatible servers reached through the OpenAI adapters
 *   (Azure, LM Studio, vLLM, gateways): they may reject the unknown parameter.
 * - Off for Anthropic and Bedrock: cache writes cost more than normal input,
 *   so caching pays off only for prompts that are reused — an admin decision.
 *   Bedrock also rejects cache points on models that do not support them.
 *
 * @param {{provider?: string, url?: string}} model
 * @returns {boolean}
 */
export function defaultPromptCachingEnabled(model) {
  if (model?.provider === 'openai' || model?.provider === 'openai-responses') {
    return isOpenAIApi(model.url);
  }
  return false;
}

/**
 * Whether iHub sends prompt-cache hints for this model.
 * @param {{provider?: string, url?: string, promptCaching?: {enabled?: boolean}}} model
 * @returns {boolean}
 */
export function isPromptCachingEnabled(model) {
  if (!supportsPromptCaching(model?.provider)) return false;
  const explicit = model?.promptCaching?.enabled;
  return typeof explicit === 'boolean' ? explicit : defaultPromptCachingEnabled(model);
}
