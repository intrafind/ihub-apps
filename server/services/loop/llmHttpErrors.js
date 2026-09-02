/**
 * HTTP mapping for `LLMError`s thrown by `LLMClient`.
 *
 * Express routes that make single-shot model calls (admin utilities, magic
 * prompt, model diagnostics, …) use this module to turn the canonical
 * `LLMError` taxonomy (contracts/errors.js) into a status code and a stable
 * JSON error body, instead of collapsing every failure into
 * "Internal server error".
 *
 * Mapping (see `llmErrorToHttpStatus`):
 *
 * | LLMError.code             | HTTP | Notes                                                        |
 * | ------------------------- | ---- | ------------------------------------------------------------ |
 * | AUTH_FAILED (API_KEY_*)   | 500  | No key configured on the server — an operator problem        |
 * | AUTH_FAILED (other)       | 502  | The provider rejected the server's credentials — never 401, which browser clients treat as an expired session |
 * | MODEL_NOT_FOUND           | 404  |                                                              |
 * | INVALID_REQUEST           | 400  |                                                              |
 * | CONTEXT_WINDOW_EXCEEDED   | 400  |                                                              |
 * | RATE_LIMITED              | 429  | `Retry-After` header set when the provider sent one          |
 * | TIMEOUT                   | 504  |                                                              |
 * | NETWORK                   | 502  |                                                              |
 * | ABORTED                   | 499  | Client closed request (nginx convention)                     |
 * | PROVIDER_ERROR / other    | 502 for an upstream 5xx, else the upstream 4xx or `defaultStatus` |
 *
 * Anything that is not an `LLMError` is a programming error and answered with
 * the generic 500 from `responseHelpers.sendInternalError`.
 *
 * @module services/loop/llmHttpErrors
 */
import { isLLMError, LLM_ERROR_CODES } from './contracts/errors.js';
import { sendInternalError } from '../../utils/responseHelpers.js';
import logger from '../../utils/logger.js';

const COMPONENT = 'llmHttpErrors';

/** Upper bound for the raw provider body echoed in `details`. */
const MAX_DETAILS_LENGTH = 2000;

/**
 * Whether an `AUTH_FAILED` error means "no API key is configured on this
 * server" (ApiKeyVerifier's `API_KEY_ERROR` / LLMClient's `API_KEY_MISSING`)
 * as opposed to the provider rejecting a key that was sent.
 *
 * @param {import('./contracts/errors.js').LLMError} err
 * @returns {boolean}
 */
export function isMissingApiKeyError(err) {
  return (
    isLLMError(err) &&
    err.code === LLM_ERROR_CODES.AUTH_FAILED &&
    String(err.providerCode || '').startsWith('API_KEY')
  );
}

/**
 * Map an `LLMError` to the HTTP status an Express route should answer with.
 *
 * @param {*} err - Anything thrown by `LLMClient`
 * @param {Object} [opts]
 * @param {number} [opts.defaultStatus=502] - Used for provider errors without a usable upstream status
 * @returns {number} HTTP status code (500 for non-LLMError input)
 *
 * @example
 *   llmErrorToHttpStatus(new LLMError('…', { code: 'RATE_LIMITED' })) // → 429
 */
export function llmErrorToHttpStatus(err, { defaultStatus = 502 } = {}) {
  if (!isLLMError(err)) return 500;

  switch (err.code) {
    case LLM_ERROR_CODES.AUTH_FAILED:
      // Both variants are server-side configuration problems from the caller's
      // point of view. A 401 would make the browser clients drop the user's own
      // session (their axios interceptors treat any 401 as "token expired").
      return isMissingApiKeyError(err) ? 500 : 502;
    case LLM_ERROR_CODES.MODEL_NOT_FOUND:
      return 404;
    case LLM_ERROR_CODES.INVALID_REQUEST:
    case LLM_ERROR_CODES.CONTEXT_WINDOW_EXCEEDED:
      return 400;
    case LLM_ERROR_CODES.RATE_LIMITED:
      return 429;
    case LLM_ERROR_CODES.TIMEOUT:
      return 504;
    case LLM_ERROR_CODES.NETWORK:
      return 502;
    case LLM_ERROR_CODES.ABORTED:
      return 499;
    default: {
      // PROVIDER_ERROR and the remaining taxonomy entries: relay an upstream 4xx,
      // hide upstream 5xx behind 502, fall back to defaultStatus otherwise.
      const upstream = typeof err.status === 'number' ? err.status : null;
      if (upstream === null) return defaultStatus;
      if (upstream >= 500) return 502;
      if (upstream >= 400) return upstream;
      return defaultStatus;
    }
  }
}

/**
 * Build the JSON body for an `LLMError` response. `undefined` fields are
 * dropped by `res.json`, so `provider` / `details` only appear when known.
 *
 * @param {import('./contracts/errors.js').LLMError} err
 * @returns {{ error: string, code: string, provider?: string, details?: string }}
 */
export function llmErrorToResponseBody(err) {
  return {
    error: err.message,
    code: err.code,
    provider: err.provider ?? undefined,
    details: typeof err.details === 'string' ? err.details.slice(0, MAX_DETAILS_LENGTH) : undefined
  };
}

/**
 * Answer an Express request with the mapped status and body for an LLM
 * failure. Sets `Retry-After` (seconds) for rate limits when the provider
 * supplied one. Non-`LLMError` input is delegated to `sendInternalError`.
 *
 * @param {import('express').Response} res
 * @param {*} err - Error thrown by `LLMClient` (or anything else)
 * @param {Object} [opts]
 * @param {number} [opts.defaultStatus=502] - See `llmErrorToHttpStatus`
 * @param {string} [opts.context='LLM request'] - Route context for the server log
 * @returns {import('express').Response}
 *
 * @example
 *   try {
 *     const result = await llmClient.complete({ … });
 *   } catch (error) {
 *     if (isLLMError(error)) return sendLLMError(res, error, { context: 'translate text' });
 *     return sendInternalError(res, error, 'translate text');
 *   }
 */
export function sendLLMError(res, err, { defaultStatus = 502, context = 'LLM request' } = {}) {
  if (!isLLMError(err)) {
    return sendInternalError(res, err, context);
  }

  const status = llmErrorToHttpStatus(err, { defaultStatus });

  if (
    err.code === LLM_ERROR_CODES.RATE_LIMITED &&
    typeof err.retryAfterMs === 'number' &&
    err.retryAfterMs > 0 &&
    typeof res.setHeader === 'function'
  ) {
    res.setHeader('Retry-After', String(Math.ceil(err.retryAfterMs / 1000)));
  }

  logger.warn(`LLM request failed in ${context}`, {
    component: COMPONENT,
    context,
    code: err.code,
    providerCode: err.providerCode,
    upstreamStatus: err.status,
    httpStatus: status,
    provider: err.provider,
    modelId: err.modelId
  });

  return res.status(status).json(llmErrorToResponseBody(err));
}
