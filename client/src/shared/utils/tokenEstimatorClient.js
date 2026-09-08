/**
 * Client-side token estimation that keeps gpt-tokenizer OUT of the eager
 * bundle.
 *
 * The tokenizer's BPE rank tables are sizeable and the context-usage indicator
 * is non-critical UX, so we load `gpt-tokenizer` via a dynamic import (a
 * separate Vite chunk) only when a token estimate is first needed. Until the
 * chunk resolves — or if it fails to load — we fall back to the classic
 * chars/4 heuristic so the UI never blocks or crashes.
 *
 * The pure `computeContextUsage` math is re-exported from the dependency-free
 * shared helper so callers have a single import site.
 */
import {
  computeContextUsage,
  conversationTokenFragments
} from '../../../../shared/contextUsage.js';

let countTokensFn = null;
let loadPromise = null;

function heuristic(text) {
  return text ? Math.ceil(text.length / 4) : 0;
}

/**
 * Per-fragment memo for the stable parts of a request (system prompt, chat
 * history, attached documents). Those strings don't change between renders, so
 * re-estimating a long conversation on every message update would tokenize the
 * same megabyte over and over. Bounded and evicted least-recently-used.
 */
const MAX_CACHED_FRAGMENTS = 512;
const fragmentCache = new Map();

function countCached(text) {
  if (fragmentCache.has(text)) {
    // Refresh recency: delete + re-set moves the key to the end of the Map.
    const cached = fragmentCache.get(text);
    fragmentCache.delete(text);
    fragmentCache.set(text, cached);
    return cached;
  }
  const count = (countTokensFn || heuristic)(text);
  fragmentCache.set(text, count);
  if (fragmentCache.size > MAX_CACHED_FRAGMENTS) {
    fragmentCache.delete(fragmentCache.keys().next().value);
  }
  return count;
}

/**
 * Ensure the tokenizer chunk is loaded. Resolves with the active count
 * function (real tokenizer, or the heuristic fallback if loading failed).
 * @returns {Promise<(text: string) => number>}
 */
export function ensureTokenizer() {
  if (countTokensFn) return Promise.resolve(countTokensFn);
  if (!loadPromise) {
    loadPromise = import('gpt-tokenizer')
      .then(mod => {
        countTokensFn = mod.countTokens;
        // Anything memoized before this point came from the chars/4 fallback;
        // drop it so counts refine to the real tokenizer.
        fragmentCache.clear();
        return countTokensFn;
      })
      .catch(() => {
        countTokensFn = heuristic;
        return countTokensFn;
      });
  }
  return loadPromise;
}

/**
 * Synchronously estimate tokens using whichever implementation is currently
 * loaded (the heuristic until the tokenizer chunk has resolved). Pair with
 * `ensureTokenizer()` / `useEstimatedTokenCount` when an accurate count is
 * required after load.
 * @param {string} text
 * @returns {number}
 */
export function estimateTokensSync(text) {
  if (!text || typeof text !== 'string') return 0;
  try {
    return (countTokensFn || heuristic)(text);
  } catch {
    return heuristic(text);
  }
}

/**
 * Estimate tokens across the stable fragments of a request (system prompt,
 * chat history, attached document text). Non-string entries are ignored and
 * per-fragment counts are memoized, so re-estimating a long conversation after
 * one new message only tokenizes the new fragments.
 *
 * @param {Array<string>} fragments
 * @returns {number} total estimated token count
 */
export function estimateTokensForFragmentsSync(fragments = []) {
  if (!Array.isArray(fragments)) return 0;
  let total = 0;
  for (const fragment of fragments) {
    if (!fragment || typeof fragment !== 'string') continue;
    try {
      total += countCached(fragment);
    } catch {
      total += heuristic(fragment);
    }
  }
  return total;
}

export { computeContextUsage, conversationTokenFragments };
