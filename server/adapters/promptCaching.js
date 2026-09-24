/**
 * Server side of per-model prompt caching (see `shared/promptCaching.js`):
 * resolving the per-request cache options the adapters read from
 * `options.promptCache`.
 *
 * @module adapters/promptCaching
 */
import { createHash } from 'node:crypto';
import { isPromptCachingEnabled } from '../../shared/promptCaching.js';

/** OpenAI rejects the whole request when `prompt_cache_key` is longer. */
export const PROMPT_CACHE_KEY_MAX_LENGTH = 64;

/**
 * The OpenAI `prompt_cache_key` for a request: one key per app and model.
 *
 * The key is only a routing hint — it never isolates caches, which are scoped
 * to the OpenAI organization either way. Per app and model groups exactly the
 * requests that share a prefix (app prompt, sources, tools): per user would
 * stop users of one app from sharing the cached app prompt, and one key for
 * everything would overflow OpenAI's per-key routing (~15 requests/min) and
 * lower the hit rate. Keys over OpenAI's limit are hashed.
 *
 * @param {{appId?: string|null, modelId: string}} params
 * @returns {string}
 */
export function buildPromptCacheKey({ appId, modelId }) {
  const key = `ihub:${appId || '-'}:${modelId}`;
  if (key.length <= PROMPT_CACHE_KEY_MAX_LENGTH) return key;
  return `ihub:${createHash('sha256').update(key).digest('hex').slice(0, 32)}`;
}

/**
 * The `promptCache` adapter option for a call, or `null` when caching is off
 * for the model.
 *
 * @param {Object} model - model config
 * @param {{appId?: string|null}} [refs]
 * @returns {{key: string}|null}
 */
export function resolvePromptCache(model, { appId } = {}) {
  if (!isPromptCachingEnabled(model)) return null;
  return { key: buildPromptCacheKey({ appId, modelId: model.id }) };
}
