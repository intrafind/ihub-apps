// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * The registry of API error codes.
 *
 * Every error response of the server carries one of these in `code`; the client
 * turns it into a message with the i18n key `apiErrors.<CODE>` and the response's
 * `details` as interpolation parameters, so no localized text travels over the
 * wire. The server keeps an English fallback in `error` for other callers.
 *
 * The value is the HTTP status a code answers with when the thrower names none.
 * Generic codes come first; a specific code is added where the client shows a
 * specific message for it today.
 *
 * @module shared/apiErrors
 */

/** Generic codes: what went wrong, not where. */
export const GENERIC_ERROR_CODES = Object.freeze({
  INTERNAL_ERROR: 500,
  BAD_REQUEST: 400,
  VALIDATION_FAILED: 400,
  AUTH_REQUIRED: 401,
  FORBIDDEN: 403,
  NOT_FOUND: 404,
  METHOD_NOT_ALLOWED: 405,
  REQUEST_TIMEOUT: 408,
  CONFLICT: 409,
  PAYLOAD_TOO_LARGE: 413,
  UNSUPPORTED_MEDIA_TYPE: 415,
  RATE_LIMITED: 429,
  NOT_IMPLEMENTED: 501,
  UPSTREAM_ERROR: 502,
  SERVICE_UNAVAILABLE: 503,
  TIMEOUT: 504
});

/** The failure codes of the storage layer (`server/storage/errors.js`). */
export const STORAGE_ERROR_CODES = Object.freeze({
  ETAG_MISMATCH: 409,
  LOCK_TIMEOUT: 503,
  INVALID_KEY: 400,
  INVALID_CURSOR: 400,
  INVALID_SEQ: 400,
  INVALID_DATA: 400,
  INVALID_ETAG: 400,
  INVALID_LOCK_OPTIONS: 400,
  NOT_SUPPORTED: 501,
  STORAGE_SHUT_DOWN: 503,
  STORAGE_UNAVAILABLE: 503,
  UNKNOWN_PROVIDER: 500,
  UNKNOWN_NAMESPACE: 400,
  CORRUPT_DOCUMENT: 500,
  STORAGE_ERROR: 500
});

/**
 * The failure codes of a model call (`LLM_ERROR_CODES`). `RATE_LIMITED` and
 * `TIMEOUT` are the generic codes of the same name.
 */
export const LLM_API_ERROR_CODES = Object.freeze({
  CONTEXT_WINDOW_EXCEEDED: 400,
  CONTENT_POLICY: 422,
  EMPTY_RESPONSE: 502,
  NETWORK: 502,
  PROVIDER_ERROR: 502,
  AUTH_FAILED: 502,
  MODEL_NOT_FOUND: 404,
  INVALID_REQUEST: 400,
  ABORTED: 499,
  QUOTA_EXCEEDED: 429
});

/**
 * Codes of one feature that the client already tells apart today (a specific
 * message, or a branch on the code). Everything else uses a generic code.
 */
export const FEATURE_ERROR_CODES = Object.freeze({
  CHAT_SHARING_UNAVAILABLE: 503,
  ARTIFACT_SHARING_DISABLED: 403,
  SHARE_MODE_DISABLED: 403,
  EMBED_DISABLED: 403,
  CHAT_TEMPORARY: 409,
  FILES_NOT_SHARED: 403,
  ORIGINAL_NOT_SHARED: 403,
  ORIGINAL_DISCARDED: 410
});

/** Every code, with its default HTTP status. */
export const API_ERROR_CODES = Object.freeze({
  ...GENERIC_ERROR_CODES,
  ...STORAGE_ERROR_CODES,
  ...LLM_API_ERROR_CODES,
  ...FEATURE_ERROR_CODES
});

/**
 * Whether `code` is in the registry.
 *
 * @param {unknown} code
 * @returns {boolean}
 */
export function isApiErrorCode(code) {
  return typeof code === 'string' && Object.hasOwn(API_ERROR_CODES, code);
}

/**
 * The i18n key of a code's message.
 *
 * @param {string} code
 * @returns {string}
 */
export function apiErrorI18nKey(code) {
  return `apiErrors.${code}`;
}
