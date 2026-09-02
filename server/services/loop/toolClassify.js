/**
 * Classify a tool result message for the circuit breaker.
 *
 * A tool "failed" when its serialized result is a JSON object with a truthy
 * `error`; it is "rate limited" when the error message looks like a 429/503.
 * Non-JSON content is real tool output, never an error.
 *
 * @module services/loop/toolClassify
 */

export const RATE_LIMIT_PATTERN = /\b(429|503)\b|too many requests|rate[ -]?limit/i;

/**
 * @param {{content?: unknown}|null} toolMessage - the `role: 'tool'` message
 * @returns {{ failed: boolean, rateLimited: boolean, message: string }}
 */
export function classifyToolResult(toolMessage) {
  const none = { failed: false, rateLimited: false, message: '' };
  const content = toolMessage?.content;
  let parsed;
  if (typeof content === 'string') {
    try {
      parsed = JSON.parse(content);
    } catch {
      return none;
    }
  } else if (content && typeof content === 'object') {
    parsed = content;
  } else {
    return none;
  }
  if (!parsed || typeof parsed !== 'object' || !parsed.error) return none;
  const message = String(parsed.message || 'tool error');
  return { failed: true, rateLimited: RATE_LIMIT_PATTERN.test(message), message };
}

/**
 * Heuristic used by the wrap-up nudge: tools that produce citations (search,
 * fetch, source lookups) must not be replaced by invented URLs.
 * @param {string} toolId
 * @returns {boolean}
 */
export function isCitationProducingTool(toolId) {
  const id = String(toolId || '').toLowerCase();
  if (!id) return false;
  return id.includes('search') || id === 'webcontentextractor' || id.startsWith('source_');
}
