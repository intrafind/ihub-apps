/**
 * Transient-error classification and backoff for LLM HTTP calls.
 *
 * Extracted (unchanged in semantics) from the former WorkflowLLMHelper so the
 * retry policy is one shared, dependency-free module used by `LLMClient`:
 *
 *   - 429 and every 5xx are transient; other 4xx are caller errors
 *   - transport faults before any response (node error codes / message
 *     patterns) are transient; a deliberate abort never is
 *   - `Retry-After` wins over exponential backoff and is bounded separately
 *
 * @module services/loop/llmRetry
 */

/**
 * Default number of retries for transient LLM errors. Overridable per
 * instance / per call, or globally via `LLM_TRANSIENT_RETRIES`
 * (`WORKFLOW_LLM_TRANSIENT_RETRIES` is still honored for existing deployments).
 * @type {number}
 */
export const DEFAULT_TRANSIENT_RETRIES = (() => {
  const raw = process.env.LLM_TRANSIENT_RETRIES ?? process.env.WORKFLOW_LLM_TRANSIENT_RETRIES;
  const fromEnv = Number(raw);
  return Number.isFinite(fromEnv) && fromEnv >= 0 ? fromEnv : 3;
})();

const NETWORK_ERROR_CODES =
  /ECONNRESET|ETIMEDOUT|ENOTFOUND|EAI_AGAIN|ECONNREFUSED|EPIPE|ECONNABORTED|UND_ERR_CONNECT_TIMEOUT|UND_ERR_SOCKET/i;
const NETWORK_ERROR_MESSAGES = /fetch failed|network|socket hang up|timeout|terminated|aborted/i;

/**
 * Whether an HTTP status from a provider is a transient failure worth retrying.
 * @param {number} status
 * @returns {boolean}
 */
export function isTransientHttpStatus(status) {
  if (typeof status !== 'number') return false;
  if (status === 429) return true;
  return status >= 500 && status < 600;
}

/**
 * Whether `err` looks like a deliberate cancellation (caller abort / timeout
 * controller). Node-fetch and the DOM AbortController both surface this as
 * `name === 'AbortError'`; our own LLMError uses code `ABORTED`.
 * @param {*} err
 * @returns {boolean}
 */
export function isAbortLike(err) {
  if (!err) return false;
  return err.name === 'AbortError' || err.code === 'ABORT_ERR' || err.code === 'ABORTED';
}

/**
 * Whether a thrown error should be retried.
 * @param {Error & { status?: number, code?: string }} err
 * @returns {boolean}
 */
export function isTransientLlmError(err) {
  if (!err) return false;
  if (isAbortLike(err)) return false;
  if (err.status != null) return isTransientHttpStatus(err.status);
  // A classified network/timeout LLMError (no HTTP status) is transient.
  if (err.code === 'NETWORK' || err.code === 'TIMEOUT') return true;
  const code = typeof err.code === 'string' ? err.code : '';
  const msg = typeof err.message === 'string' ? err.message : '';
  const causeCode = typeof err.cause?.code === 'string' ? err.cause.code : '';
  return (
    NETWORK_ERROR_CODES.test(code) ||
    NETWORK_ERROR_CODES.test(causeCode) ||
    NETWORK_ERROR_MESSAGES.test(msg)
  );
}

/**
 * Parse a `Retry-After` header into milliseconds (integer seconds or HTTP date).
 * @param {string|number|null|undefined} retryAfter
 * @returns {number|null}
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
 * @param {number} attempt - zero-based attempt index that just failed
 * @param {Object} [opts]
 * @param {number|null} [opts.retryAfterMs]
 * @param {number} [opts.baseMs=1000]
 * @param {number} [opts.capMs=15000]
 * @param {number} [opts.retryAfterCapMs=60000]
 * @param {() => number} [opts.jitter=Math.random]
 * @returns {number}
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

/**
 * Run `fn(attempt)` and retry it on transient errors with backoff.
 *
 * @param {(attempt: number) => Promise<any>} fn
 * @param {Object} [opts]
 * @param {number} [opts.maxRetries=DEFAULT_TRANSIENT_RETRIES]
 * @param {(info: {attempt:number, err:Error, delayMs:number}) => void} [opts.onRetry]
 * @param {(ms: number, signal?: AbortSignal) => Promise<void>} [opts.sleep]
 * @param {(err: Error) => boolean} [opts.isTransient]
 * @param {AbortSignal} [opts.signal] - aborting it ends a pending backoff at once
 * @returns {Promise<any>}
 */
export async function runWithRetries(
  fn,
  {
    maxRetries = DEFAULT_TRANSIENT_RETRIES,
    onRetry,
    sleep = abortableSleep,
    isTransient = isTransientLlmError,
    signal
  } = {}
) {
  const budget = Number.isFinite(maxRetries) && maxRetries >= 0 ? maxRetries : 0;
  for (let attempt = 0; ; attempt++) {
    try {
      return await fn(attempt);
    } catch (err) {
      if (attempt >= budget || !isTransient(err)) throw err;
      if (signal?.aborted) throw abortError();
      const delayMs = computeRetryDelayMs(attempt, {
        retryAfterMs: typeof err?.retryAfterMs === 'number' ? err.retryAfterMs : null
      });
      if (onRetry) onRetry({ attempt, err, delayMs });
      await sleep(delayMs, signal);
    }
  }
}

function abortError() {
  const err = new Error('The operation was aborted');
  err.name = 'AbortError';
  return err;
}

/**
 * Sleep that ends immediately when `signal` aborts (rejecting with an
 * AbortError), so a stop or the whole-call timeout also covers a pending
 * `Retry-After` wait.
 */
export function abortableSleep(ms, signal) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(abortError());
    const onAbort = () => {
      clearTimeout(timer);
      reject(abortError());
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}
