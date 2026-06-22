/**
 * Shared token estimation utility.
 *
 * Uses gpt-tokenizer (o200k_base / GPT-4o BPE) to estimate token counts for
 * text. This is a cross-provider approximation: it is accurate for OpenAI
 * models and a good estimate for Anthropic / Google / Mistral (typically
 * within ~10-20%). The authoritative count for any turn is always the
 * provider-reported usage (promptTokens / completionTokens), which the chat
 * pipeline reconciles against after each response.
 *
 * Both the server (usageTracker, RequestBuilder) and the client (chat input
 * capacity indicator) import this single helper so estimates stay consistent.
 *
 * The gpt-tokenizer package is loaded lazily so the server can still start
 * even when the package is not installed (falls back to a chars/4 heuristic).
 */
import { createRequire } from 'module';
import { computeContextUsage } from './contextUsage.js';

/** Chars/4 fallback when the real tokenizer is unavailable. */
function heuristic(text) {
  return Math.ceil(text.length / 4);
}

let countTokensFn = null;

// Attempt to load gpt-tokenizer synchronously using createRequire.
// If the package is not installed (e.g. missing from node_modules in a
// production deployment), we silently fall back to the heuristic.
try {
  const require = createRequire(import.meta.url);
  const mod = require('gpt-tokenizer');
  countTokensFn = mod.countTokens || mod.default?.countTokens || null;
} catch {
  // Package not available — heuristic will be used
}

/**
 * Estimate the number of tokens in a piece of text.
 * @param {string} text
 * @returns {number} estimated token count (0 for empty/invalid input)
 */
export function estimateTokens(text) {
  if (!text || typeof text !== 'string') return 0;
  try {
    return (countTokensFn || heuristic)(text);
  } catch {
    // Fall back to the classic chars/4 heuristic if the tokenizer throws
    // (e.g. on unusual input). Better an approximate number than a crash.
    return heuristic(text);
  }
}

/**
 * Estimate tokens across multiple text fragments (system prompt, sources,
 * history, new message, file content, ...). Non-string entries are ignored.
 * @param {Array<string>} fragments
 * @returns {number} total estimated token count
 */
export function estimateTokensForFragments(fragments = []) {
  if (!Array.isArray(fragments)) return 0;
  return fragments.reduce((sum, fragment) => sum + estimateTokens(fragment), 0);
}

// Re-exported from the dependency-free helper so existing server/test imports
// (`import { computeContextUsage } from 'shared/tokenEstimator.js'`) keep working.
export { computeContextUsage };
