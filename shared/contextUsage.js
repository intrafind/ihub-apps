/**
 * Pure context-window math — no heavy dependencies.
 *
 * Kept separate from `tokenEstimator.js` (which pulls in the gpt-tokenizer BPE
 * tables) so the client can import this lightweight helper eagerly while
 * loading the tokenizer itself lazily / on demand.
 */

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
