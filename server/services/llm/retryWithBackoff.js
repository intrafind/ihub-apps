/**
 * Shared transient-error retry/backoff helper for LLM HTTP calls.
 *
 * Extracted from WorkflowLLMHelper (the only LLM invocation path that had any
 * retry logic) so other paths (simpleCompletion, etc.) can reuse the same
 * transient-error classification and backoff computation instead of having
 * none at all. WorkflowLLMHelper re-exports these for backward compatibility
 * with existing importers.
 *
 * @module services/llm/retryWithBackoff
 */

const NETWORK_ERROR_CODES =
  /ECONNRESET|ETIMEDOUT|ENOTFOUND|EAI_AGAIN|ECONNREFUSED|EPIPE|ECONNABORTED/i;
const NETWORK_ERROR_MESSAGES = /fetch failed|network|socket hang up|timeout|terminated|aborted/i;

/**
 * Whether an HTTP status from a provider is a TRANSIENT failure worth retrying.
 * 429 (rate limit — honor Retry-After) and any 5xx (server-side / overload).
 * 4xx other than 429 are caller errors (bad request, auth, context window) and
 * must NOT be retried — retrying can't fix them and just wastes the budget.
 *
 * @param {number} status - HTTP status code
 * @returns {boolean}
 */
export function isTransientHttpStatus(status) {
  if (typeof status !== 'number') return false;
  if (status === 429) return true;
  return status >= 500 && status < 600;
}

/**
 * Whether a thrown error should be retried. Two transient classes:
 *   1. A classified HTTP error (has `.status`) whose status is transient.
 *   2. A transport/network fault thrown BEFORE any response (no `.status`),
 *      recognized by its node error code or message. We deliberately do NOT
 *      treat an arbitrary status-less error (e.g. a logic bug) as transient,
 *      so we don't silently retry real defects.
 *
 * @param {Error & { status?: number, code?: string }} err
 * @returns {boolean}
 */
export function isTransientLlmError(err) {
  if (!err) return false;
  if (err.status != null) return isTransientHttpStatus(err.status);
  const code = typeof err.code === 'string' ? err.code : '';
  const msg = typeof err.message === 'string' ? err.message : '';
  return NETWORK_ERROR_CODES.test(code) || NETWORK_ERROR_MESSAGES.test(msg);
}

/**
 * Parse a `Retry-After` header into milliseconds. Supports the integer-seconds
 * form (what Google sends) and an HTTP-date; returns null when absent or
 * unparseable so the caller falls back to exponential backoff.
 *
 * @param {string|number|null|undefined} retryAfter - raw header value
 * @returns {number|null} delay in ms, or null
 */
export function parseRetryAfterMs(retryAfter) {
  if (retryAfter == null) return null;
  const s = String(retryAfter).trim();
  if (s === '') return null;
  if (/^\d+$/.test(s)) return Number(s) * 1000;
  const dateMs = Date.parse(s);
  if (!Number.isNaN(dateMs)) return Math.max(0, dateMs - Date.now());
  return null;
}

/**
 * Compute the delay before the next retry. Honors a server-instructed
 * `Retry-After` (bounded only by `retryAfterCapMs`); otherwise exponential
 * backoff (base · 2^attempt) plus up to `baseMs` of jitter, capped at `capMs`.
 *
 * A server-instructed delay is NOT clamped to the small backoff `capMs`:
 * retrying before the server's stated window has elapsed just re-trips the
 * rate limit and burns the whole retry budget. It is bounded by a separate,
 * larger `retryAfterCapMs` only to guard against an absurd header value.
 *
 * @param {number} attempt - zero-based attempt index that just failed
 * @param {Object} [opts]
 * @param {number|null} [opts.retryAfterMs] - server-instructed delay, if any
 * @param {number} [opts.baseMs=1000]
 * @param {number} [opts.capMs=15000] - cap for computed exponential backoff
 * @param {number} [opts.retryAfterCapMs=60000] - upper bound for an explicit Retry-After
 * @param {() => number} [opts.jitter=Math.random]
 * @returns {number} delay in ms
 */
export function computeRetryDelayMs(
  attempt,
  {
    retryAfterMs = null,
    baseMs = 1000,
    capMs = 15000,
    retryAfterCapMs = 60000,
    jitter = Math.random
  } = {}
) {
  if (typeof retryAfterMs === 'number' && retryAfterMs >= 0) {
    return Math.min(retryAfterMs, retryAfterCapMs);
  }
  const exp = baseMs * Math.pow(2, attempt);
  const jitterMs = Math.floor(jitter() * baseMs);
  return Math.min(exp + jitterMs, capMs);
}

function defaultSleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * Run `fn` and retry it on transient errors with exponential backoff.
 *
 * `fn(attempt)` is invoked once per attempt and must either return a value
 * (success) or throw. A thrown error is retried only when
 * `isTransientLlmError` says so and the retry budget remains; otherwise it
 * propagates unchanged. A `.retryAfterMs` on the error (parsed from a
 * provider Retry-After header) overrides the computed backoff.
 *
 * @param {(attempt: number) => Promise<any>} fn
 * @param {Object} [opts]
 * @param {number} [opts.maxRetries=3]
 * @param {(info: {attempt:number, err:Error, delayMs:number}) => void} [opts.onRetry]
 * @param {(ms: number) => Promise<void>} [opts.sleep] - overridable for tests
 * @returns {Promise<any>} fn's successful return value
 */
export async function runWithRetries(fn, { maxRetries = 3, onRetry, sleep = defaultSleep } = {}) {
  for (let attempt = 0; ; attempt++) {
    try {
      return await fn(attempt);
    } catch (err) {
      if (attempt >= maxRetries || !isTransientLlmError(err)) throw err;
      const delayMs = computeRetryDelayMs(attempt, {
        retryAfterMs: typeof err?.retryAfterMs === 'number' ? err.retryAfterMs : null
      });
      if (onRetry) onRetry({ attempt, err, delayMs });
      await sleep(delayMs);
    }
  }
}
