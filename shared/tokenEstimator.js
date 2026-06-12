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
 */
import { countTokens } from 'gpt-tokenizer';

/**
 * Estimate the number of tokens in a piece of text.
 * @param {string} text
 * @returns {number} estimated token count (0 for empty/invalid input)
 */
export function estimateTokens(text) {
  if (!text || typeof text !== 'string') return 0;
  try {
    return countTokens(text);
  } catch {
    // Fall back to the classic chars/4 heuristic if the tokenizer throws
    // (e.g. on unusual input). Better an approximate number than a crash.
    return Math.ceil(text.length / 4);
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

/**
 * Compute remaining context-window capacity for a request.
 * @param {object} params
 * @param {number} params.contextWindow - model's total context window
 * @param {number} params.inputTokens - estimated input tokens
 * @param {number} params.maxOutputTokens - reserved output cap
 * @returns {{ contextWindow: number, inputTokens: number, maxOutputTokens: number, remaining: number, usedRatio: number }}
 */
export function computeContextUsage({ contextWindow, inputTokens, maxOutputTokens = 0 }) {
  const total = Number(contextWindow) || 0;
  const input = Number(inputTokens) || 0;
  const reserve = Number(maxOutputTokens) || 0;
  const remaining = total > 0 ? total - input - reserve : 0;
  const usedRatio = total > 0 ? (input + reserve) / total : 0;
  return {
    contextWindow: total,
    inputTokens: input,
    maxOutputTokens: reserve,
    remaining,
    usedRatio
  };
}
