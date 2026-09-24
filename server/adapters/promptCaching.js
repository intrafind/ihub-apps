/**
 * Server side of per-model prompt caching (see `shared/promptCaching.js`):
 * resolving the per-request cache options the adapters read from
 * `options.promptCache`.
 *
 * @module adapters/promptCaching
 */
import { isPromptCachingEnabled } from '../../shared/promptCaching.js';

/** OpenAI rejects the whole request when `prompt_cache_key` is longer. */
export const PROMPT_CACHE_KEY_MAX_LENGTH = 64;

const FNV_OFFSET = 0xcbf29ce484222325n;
const FNV_PRIME = 0x100000001b3n;
const U64 = 0xffffffffffffffffn;

/**
 * 64-bit FNV-1a: a stable, non-cryptographic digest. The cache key is a
 * routing hint, not a secret — a collision only makes two apps share OpenAI
 * routing — so a cryptographic hash would add nothing.
 * @param {string} text
 * @returns {string} 16 hex characters
 */
function fnv1a64(text) {
  let hash = FNV_OFFSET;
  for (const byte of Buffer.from(text, 'utf8')) {
    hash = ((hash ^ BigInt(byte)) * FNV_PRIME) & U64;
  }
  return hash.toString(16).padStart(16, '0');
}

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
  return `ihub:${fnv1a64(key)}`;
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
