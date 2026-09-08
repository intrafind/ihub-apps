/**
 * Fallback for provider-native web search the provider turns down.
 *
 * Native web search (Anthropic's server tool, Google Search grounding, OpenAI
 * web search) is a request-time directive resolved by toolLoader. Some
 * deployments cannot honour it: web search disabled for the organisation in
 * the provider console, a model or gateway that does not implement the server
 * tool, a tool version the platform does not offer. The provider answers with
 * a 400 that names web search — and without handling, the whole turn fails.
 *
 * AgentLoop recognises that rejection, retries the call without the directive
 * and with the script-backed search tool the directive names as its fallback,
 * and remembers the rejection per model for a while so later calls skip the
 * doomed request.
 *
 * @module services/loop/nativeWebSearchFallback
 */

const DEFAULT_TTL_MS = 15 * 60 * 1000;
const WEB_SEARCH_PATTERN = /web[\s_-]?search/i;
const REJECTION_STATUSES = new Set([400, 422]);

/** @type {Map<string, {until: number, reason: string|null}>} */
const unavailable = new Map();

function errorText(err) {
  const parts = [err.message];
  const details = err.details;
  if (typeof details === 'string') parts.push(details);
  else if (details && typeof details === 'object') {
    try {
      parts.push(JSON.stringify(details));
    } catch {
      // unserializable details carry nothing to match on
    }
  }
  return parts.filter(Boolean).join(' ');
}

/**
 * Whether an LLM error is the provider refusing native web search (a client
 * error whose message or body names web search), as opposed to any other bad
 * request.
 * @param {Error & {status?: number, details?: any}} err
 * @returns {boolean}
 */
export function isNativeWebSearchRejection(err) {
  if (!err || typeof err !== 'object') return false;
  if (!REJECTION_STATUSES.has(err.status)) return false;
  return WEB_SEARCH_PATTERN.test(errorText(err));
}

/**
 * Remember that a model rejected native web search.
 * @param {string} modelId
 * @param {{reason?: string|null, ttlMs?: number, now?: number}} [options]
 */
export function markNativeWebSearchUnavailable(
  modelId,
  { reason = null, ttlMs = DEFAULT_TTL_MS, now = Date.now() } = {}
) {
  if (!modelId) return;
  unavailable.set(modelId, { until: now + ttlMs, reason });
}

/**
 * Whether a model recently rejected native web search (entries expire).
 * @param {string} modelId
 * @param {number} [now]
 * @returns {boolean}
 */
export function isNativeWebSearchUnavailable(modelId, now = Date.now()) {
  const entry = unavailable.get(modelId);
  if (!entry) return false;
  if (entry.until <= now) {
    unavailable.delete(modelId);
    return false;
  }
  return true;
}

/** Forget every remembered rejection (tests, config reloads). */
export function clearNativeWebSearchFallbackMemo() {
  unavailable.clear();
}

/**
 * Tool definitions to offer instead of the rejected directive. toolLoader is
 * imported lazily: it pulls in the whole config and tool stack, which the loop
 * must not depend on at module load.
 * @param {{fallback?: string}|null} directive
 * @param {{app?: Object, language?: string}} [context]
 * @returns {Promise<Object[]>}
 */
export async function resolveNativeWebSearchFallbackTools(directive, context = {}) {
  const { resolveNativeWebSearchFallbackTools: resolve } = await import('../../toolLoader.js');
  return resolve(directive, context);
}
