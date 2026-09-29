/**
 * Output-token cap (`max_tokens` / `maxOutputTokens`) sent to a provider.
 *
 * Reasoning models spend their thinking tokens from this same budget, so a cap
 * sized for a plain answer can be used up before the answer starts (the turn
 * then ends with `finish_reason: "length"` and no content). The fallback is
 * therefore generous; models with a known limit declare it as `maxOutputTokens`.
 */
export const DEFAULT_MAX_OUTPUT_TOKENS = 16384;

/**
 * Resolve the output cap for a model.
 *
 * The model's own `maxOutputTokens` wins. Without one the default applies, but
 * never more than half of a known context window: servers such as vLLM reject a
 * request whose prompt plus `max_tokens` exceeds the window.
 *
 * @param {{maxOutputTokens?: number|null, contextWindow?: number|null}} [model]
 * @returns {number}
 */
export function resolveMaxOutputTokens(model) {
  const configured = Number(model?.maxOutputTokens);
  if (Number.isFinite(configured) && configured > 0) return Math.floor(configured);
  const windowSize = Number(model?.contextWindow);
  if (Number.isFinite(windowSize) && windowSize > 0) {
    return Math.max(1, Math.min(DEFAULT_MAX_OUTPUT_TOKENS, Math.floor(windowSize / 2)));
  }
  return DEFAULT_MAX_OUTPUT_TOKENS;
}
