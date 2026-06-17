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
import { computeContextUsage } from '../../../../shared/contextUsage.js';

let countTokensFn = null;
let loadPromise = null;

function heuristic(text) {
  return text ? Math.ceil(text.length / 4) : 0;
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

export { computeContextUsage };
