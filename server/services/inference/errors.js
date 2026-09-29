/**
 * Errors of the inference API (`/api/inference/v1`).
 *
 * Every refusal the API makes on its own — a malformed model identifier, a
 * variable outside its allowed values, a conversation bound to another app,
 * an answer that failed validation — is an {@link InferenceApiError} with an
 * HTTP status and a stable `code`. Two wire shapes exist, because the
 * endpoints predate each other:
 *
 *   - `/chat/completions` keeps its flat `{ error, code, param?, details? }`
 *     body, which existing callers already parse;
 *   - `/responses` and `/conversations` use OpenAI's nested
 *     `{ error: { message, type, param, code, details? } }`.
 *
 * @module services/inference/errors
 */
import logger from '../../utils/logger.js';
import { isLLMError, LLM_ERROR_CODES } from '../loop/contracts/errors.js';

export class InferenceApiError extends Error {
  /**
   * @param {number} status - HTTP status.
   * @param {string} code - Stable machine-readable code.
   * @param {string} message - What went wrong, for a developer.
   * @param {Object} [extra]
   * @param {string} [extra.param] - The request field at fault.
   * @param {*} [extra.details] - Structured detail (per-variable errors, validation errors).
   */
  constructor(status, code, message, { param = null, details } = {}) {
    super(message);
    this.name = 'InferenceApiError';
    this.status = status;
    this.code = code;
    this.param = param;
    if (details !== undefined) this.details = details;
  }
}

export function isInferenceApiError(error) {
  return error instanceof InferenceApiError;
}

/** OpenAI's error `type` for an HTTP status. */
export function openAiErrorType(status) {
  if (status === 401) return 'authentication_error';
  if (status === 403) return 'permission_error';
  if (status === 404) return 'not_found_error';
  if (status === 429) return 'rate_limit_error';
  if (status >= 500) return 'server_error';
  return 'invalid_request_error';
}

/**
 * The nested OpenAI error object of an error.
 *
 * @param {InferenceApiError|Error} error
 * @returns {{message: string, type: string, param: string|null, code: string, details?: *}}
 */
export function openAiErrorObject(error) {
  const status = isInferenceApiError(error) ? error.status : 500;
  return {
    message: isInferenceApiError(error) ? error.message : 'Internal server error',
    type: openAiErrorType(status),
    param: error?.param ?? null,
    code: isInferenceApiError(error) ? error.code : 'internal_error',
    ...(isInferenceApiError(error) && error.details !== undefined ? { details: error.details } : {})
  };
}

/**
 * Answer with the OpenAI error shape (`/responses`, `/conversations`).
 *
 * @param {import('express').Response} res
 * @param {Error} error
 * @param {string} component - For the log line of an unexpected error.
 */
export function sendOpenAiError(res, error, component = 'InferenceApi') {
  if (!isInferenceApiError(error)) {
    logger.error('Inference API request failed', { component, error });
  }
  const status = isInferenceApiError(error) ? error.status : 500;
  return res.status(status).json({ error: openAiErrorObject(error) });
}

/**
 * Answer with the flat Chat Completions error shape.
 *
 * @param {import('express').Response} res
 * @param {InferenceApiError} error
 */
export function sendFlatError(res, error) {
  return res.status(error.status).json({
    error: error.message,
    code: error.code,
    ...(error.param ? { param: error.param } : {}),
    ...(error.details !== undefined ? { details: error.details } : {})
  });
}

/**
 * Map an LLMError to the HTTP status of the error body. Provider HTTP
 * failures keep the upstream status; client-side classes get the closest
 * HTTP equivalent.
 *
 * @param {Error} err
 * @returns {number}
 */
export function inferenceErrorStatus(err) {
  if (!isLLMError(err)) return 500;
  if (typeof err.status === 'number' && err.status >= 400) return err.status;
  switch (err.code) {
    case LLM_ERROR_CODES.AUTH_FAILED:
      // A key that is not configured on the server is a server-side problem
      // (kept at 500 for compatibility with the previous `apiKeyNotFound` reply).
      return String(err.providerCode || '').startsWith('API_KEY') ? 500 : 401;
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
    default:
      return 502;
  }
}

/**
 * An LLMError as an InferenceApiError, keeping the canonical LLM error code.
 *
 * @param {Error} err
 * @returns {InferenceApiError}
 */
export function fromLLMError(err) {
  if (isInferenceApiError(err)) return err;
  if (!isLLMError(err)) {
    return new InferenceApiError(500, 'internal_error', 'Internal server error');
  }
  return new InferenceApiError(
    inferenceErrorStatus(err),
    String(err.code || 'ERROR'),
    err.message,
    {
      ...(typeof err.details === 'string' && err.details ? { details: err.details } : {})
    }
  );
}
