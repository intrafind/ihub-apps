// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

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
 * The server (usageTracker, RequestBuilder) imports this helper. The client
 * uses its own tokenEstimatorClient.js which dynamically imports gpt-tokenizer.
 *
 * gpt-tokenizer is a dependency of the server (`server/package.json`). It is
 * still loaded defensively so the server can start even when the package is
 * missing from a deployment (falls back to a chars/4 heuristic).
 */
import { createRequire } from 'node:module';

/** Chars/4 fallback when the real tokenizer is unavailable. */
function heuristic(text) {
  return Math.ceil(text.length / 4);
}

let countTokensFn = null;

// Attempt to load gpt-tokenizer synchronously using createRequire. The server
// declares the package, and it lives in the server's node_modules: next to this
// file's own location Node looks only at the repository (or `dist/`) root, so
// the server directory is tried as well. A development checkout and the Docker
// image keep the package under `server/node_modules`, the single-binary build
// at the root; one of the two finds it. If neither does (e.g. a deployment
// that left it out), we silently fall back to the heuristic.
const SEARCH_FROM = [import.meta.url, new URL('../server/package.json', import.meta.url).href];
for (const base of SEARCH_FROM) {
  try {
    const mod = createRequire(base)('gpt-tokenizer');
    countTokensFn = mod.countTokens || mod.default?.countTokens || null;
    if (countTokensFn) break;
  } catch {
    // Not found from here — try the next place, then the heuristic
  }
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
 * Which method {@link estimateTokens} counts with: `o200k_base` when
 * gpt-tokenizer is installed, `heuristic` (about 4 characters per token, a rough
 * approximation that can be off in either direction) when it is not. For callers that show
 * the figure to a person and should say how it was made.
 * @returns {{method: 'o200k_base'|'heuristic'}}
 */
export function tokenizerInfo() {
  return { method: countTokensFn ? 'o200k_base' : 'heuristic' };
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

export { computeContextUsage } from './contextUsage.js';
