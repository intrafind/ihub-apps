/**
 * Canonical LLM error taxonomy for the unified runtime.
 *
 * Every provider failure that escapes `LLMClient` is an `LLMError` carrying one
 * of the codes below. Circuit breakers, microcompaction retries, failover and
 * the inference API's error mapping key off `code` — never off provider
 * message strings. The first seven codes are the canonical set from the
 * concept (§5.2); the remaining four are terminal client-side classes that the
 * existing `ErrorHandler` already distinguishes and that callers surface to
 * users with dedicated messages.
 *
 * @module services/loop/contracts/errors
 */

export const LLM_ERROR_CODES = Object.freeze({
  CONTEXT_WINDOW_EXCEEDED: 'CONTEXT_WINDOW_EXCEEDED',
  RATE_LIMITED: 'RATE_LIMITED',
  CONTENT_POLICY: 'CONTENT_POLICY',
  EMPTY_RESPONSE: 'EMPTY_RESPONSE',
  TIMEOUT: 'TIMEOUT',
  NETWORK: 'NETWORK',
  PROVIDER_ERROR: 'PROVIDER_ERROR',
  AUTH_FAILED: 'AUTH_FAILED',
  MODEL_NOT_FOUND: 'MODEL_NOT_FOUND',
  INVALID_REQUEST: 'INVALID_REQUEST',
  ABORTED: 'ABORTED'
});

export const LLM_ERROR_CODE_LIST = Object.freeze(Object.values(LLM_ERROR_CODES));

/** Codes for which a retry (with backoff) can succeed without changing the request. */
export const RETRYABLE_LLM_ERROR_CODES = Object.freeze(
  new Set([LLM_ERROR_CODES.RATE_LIMITED, LLM_ERROR_CODES.NETWORK, LLM_ERROR_CODES.TIMEOUT])
);

/**
 * Typed error thrown by `LLMClient`.
 */
export class LLMError extends Error {
  /**
   * @param {string} message - Human-readable (localized where possible) message
   * @param {Object} props
   * @param {string} props.code - One of LLM_ERROR_CODES
   * @param {string} [props.providerCode] - Provider / legacy ErrorHandler code (e.g. 'SERVICE_UNAVAILABLE')
   * @param {number} [props.status] - HTTP status from the provider, when any
   * @param {string} [props.provider] - iHub provider id
   * @param {string} [props.modelId] - iHub model id
   * @param {number|null} [props.retryAfterMs] - Parsed Retry-After hint
   * @param {*} [props.details] - Raw provider error body / diagnostic payload
   * @param {Error} [props.cause]
   */
  constructor(message, props = {}) {
    super(message, props.cause ? { cause: props.cause } : undefined);
    this.name = 'LLMError';
    this.code = LLM_ERROR_CODE_LIST.includes(props.code)
      ? props.code
      : LLM_ERROR_CODES.PROVIDER_ERROR;
    this.providerCode = props.providerCode ?? null;
    this.status = typeof props.status === 'number' ? props.status : null;
    this.provider = props.provider ?? null;
    this.modelId = props.modelId ?? null;
    this.retryAfterMs = typeof props.retryAfterMs === 'number' ? props.retryAfterMs : null;
    this.details = props.details ?? null;
  }

  /** Whether a plain retry of the same request may succeed. */
  get retryable() {
    return RETRYABLE_LLM_ERROR_CODES.has(this.code) || (this.status >= 500 && this.status < 600);
  }

  /** Whether this error signals the request exceeded the model's context window. */
  get isContextWindowError() {
    return this.code === LLM_ERROR_CODES.CONTEXT_WINDOW_EXCEEDED;
  }

  toJSON() {
    return {
      name: this.name,
      message: this.message,
      code: this.code,
      providerCode: this.providerCode,
      status: this.status,
      provider: this.provider,
      modelId: this.modelId,
      retryAfterMs: this.retryAfterMs
    };
  }
}

/**
 * Type guard for LLMError (also recognizes structurally compatible errors that
 * crossed a module boundary / were re-created).
 * @param {*} err
 * @returns {boolean}
 */
export function isLLMError(err) {
  return (
    err instanceof LLMError ||
    (!!err && typeof err === 'object' && err.name === 'LLMError' && typeof err.code === 'string')
  );
}
