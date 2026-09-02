/**
 * Classify a tool result message for the circuit breaker.
 *
 * A tool "failed" when its serialized result is a JSON object with a truthy
 * `error`; it is "rate limited" when the numeric `status` is 429/503 or the
 * error text looks like a rate limit. Both documented failure shapes are
 * understood: `{ error, message, code }` and `{ error, status, statusText, body }`.
 * Non-JSON content is real tool output, never an error.
 *
 * @module services/loop/toolClassify
 */

export const RATE_LIMIT_PATTERN = /\b(429|503)\b|too many requests|rate[ _-]?limit/i;
const RATE_LIMIT_STATUSES = new Set([429, 503]);

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
  const status = Number(parsed.status ?? parsed.statusCode);
  const message = String(
    parsed.message ||
      (typeof parsed.error === 'string' && parsed.error !== 'true' ? parsed.error : '') ||
      parsed.statusText ||
      (typeof parsed.body === 'string' ? parsed.body.slice(0, 200) : '') ||
      'tool error'
  );
  const rateLimited =
    RATE_LIMIT_STATUSES.has(status) ||
    RATE_LIMIT_PATTERN.test(message) ||
    RATE_LIMIT_PATTERN.test(String(parsed.code || ''));
  return { failed: true, rateLimited, message };
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
