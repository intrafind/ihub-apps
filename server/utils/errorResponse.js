// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * One error response shape for the whole API.
 *
 * ```json
 * { "error": "Scheduled task not found", "code": "NOT_FOUND", "details": { "taskId": "t1" } }
 * ```
 *
 * - `code` (always): a registry code of `shared/apiErrors.js`. The client picks
 *   its message with the i18n key `apiErrors.<code>`.
 * - `details` (only when there is something to say): a plain object whose
 *   members are the interpolation parameters of that message. It never holds `code`.
 * - `error` (always): an English fallback text for callers without i18n. For a
 *   4xx it is the message that was thrown; for a 5xx the message too, when it
 *   passes `publicMessage`, else a fixed text. The real message is always logged.
 *
 * OAuth endpoints keep their RFC 6749 body, `{ error, error_description }`.
 *
 * @module utils/errorResponse
 */

import { readFileSync } from 'node:fs';
import { ZodError } from 'zod';
import {
  API_ERROR_CODES,
  GENERIC_ERROR_CODES,
  LLM_API_ERROR_CODES
} from '../../shared/apiErrors.js';
import { StorageError, storageHttpStatus } from '../storage/errors.js';
import { isLLMError } from '../services/loop/contracts/errors.js';
import { ServiceError } from './ServiceError.js';

const FALLBACK_TEXT = JSON.parse(
  readFileSync(new URL('../../shared/i18n/en.json', import.meta.url), 'utf8')
).apiErrors;

/** The generic code of an HTTP status, for errors that only carry a status. */
const CODE_BY_STATUS = Object.freeze(
  Object.fromEntries(
    Object.entries(GENERIC_ERROR_CODES)
      .filter(([code]) => code !== 'VALIDATION_FAILED' && code !== 'TIMEOUT')
      .map(([code, status]) => [status, code])
  )
);

/** The RFC 6749 error code of an HTTP status, for OAuth endpoints. */
function rfcCodeOf(status) {
  if (status === 401) return 'invalid_client';
  if (status === 403) return 'access_denied';
  if (status === 429 || status === 503) return 'temporarily_unavailable';
  if (status >= 500) return 'server_error';
  return 'invalid_request';
}

/**
 * The English fallback text of a code.
 *
 * @param {string} code
 * @returns {string}
 */
export function fallbackText(code) {
  return FALLBACK_TEXT[code] || FALLBACK_TEXT.INTERNAL_ERROR;
}

function httpStatusOf(error) {
  const status = error?.status ?? error?.statusCode;
  return Number.isInteger(status) && status >= 400 && status <= 599 ? status : null;
}

/**
 * Shapes in a message that a caller must not see on a 5xx: file paths and file names,
 * URLs, hosts, IPs and ports, stack frames, errno codes, credential words, token-like
 * runs and SQL. The list is deliberately blunt: a message that trips one of them is
 * replaced by the code's fixed text, never edited.
 */
const UNSAFE_IN_MESSAGE = [
  /[\\/][\w.@-]+[\\/]/, // path segments: a/b/
  /\b[A-Za-z]:\\/, // Windows drive paths
  /\b[\w-]+\.(?:js|mjs|cjs|jsx|ts|json|ya?ml|env|pem|key|log|sh)\b/i, // file names
  /node_modules/i,
  /\b(?:https?|wss?|ftp|file|ldaps?|postgres|mongodb|redis):\/\//i, // URLs
  /\b\d{1,3}(?:\.\d{1,3}){3}\b/, // IPv4
  /\b(?:[0-9a-f]{1,4}:){2,}[0-9a-f]{0,4}\b/i, // IPv6
  /:\d{2,5}\b/, // host:port
  /\bat\s+\S+\s*\(|\n\s*at\s/, // stack frames
  /\bE[A-Z]{3,}\b/, // errno codes (ECONNREFUSED, ENOENT)
  /\b(?:pass(?:word|wd)?|secret|token|api[_-]?key|authori[sz]ation|bearer|cookie|credential|private[_ ]key|session)s?\b/i,
  /[A-Za-z0-9_\-+/=]{24,}/, // long token-like runs
  /\b(?:select|insert|update|delete)\b[\s\S]*\b(?:from|into|set|where)\b/i, // SQL
  /[\u0000-\u001f\u007f]/ // control characters, newlines
];

const MAX_PUBLIC_MESSAGE_LENGTH = 200;

/**
 * The message of a 5xx when it is safe to show, else null.
 *
 * @param {unknown} message
 * @returns {string|null}
 */
export function publicMessage(message) {
  if (typeof message !== 'string') return null;
  const text = message.trim();
  if (!text || text.length > MAX_PUBLIC_MESSAGE_LENGTH) return null;
  return UNSAFE_IN_MESSAGE.some(pattern => pattern.test(text)) ? null : text;
}

/**
 * Whether the message of an error is one of ours to show: not a bug of the runtime
 * (`TypeError` and kin read like "Cannot read properties of undefined (reading 'x')",
 * which describes our code) and not a system error (`errno`, `syscall`).
 *
 * @param {unknown} error
 * @returns {boolean}
 */
function hasShowableMessage(error) {
  if (!(error instanceof Error)) return false;
  const internal = [TypeError, RangeError, ReferenceError, SyntaxError, EvalError, URIError];
  if (internal.some(type => error instanceof type) || error instanceof AggregateError) return false;
  return error.errno === undefined && error.syscall === undefined;
}

function classifyStorage(error) {
  const status = storageHttpStatus(error) ?? API_ERROR_CODES[error.code] ?? 500;
  const code = Object.hasOwn(API_ERROR_CODES, error.code) ? error.code : 'STORAGE_ERROR';
  return { status, code, message: error.message };
}

function classifyLlm(error) {
  const known = Object.hasOwn(LLM_API_ERROR_CODES, error.code) || error.code in GENERIC_ERROR_CODES;
  const code = known ? error.code : 'PROVIDER_ERROR';
  const details = {};
  if (error.retryAfterMs != null) details.retryAfterMs = error.retryAfterMs;
  if (error.provider) details.provider = error.provider;
  if (error.modelId) details.modelId = error.modelId;
  return {
    status: API_ERROR_CODES[code],
    code,
    details: Object.keys(details).length ? details : undefined,
    // A provider's text is not ours to show; the client has the code's message.
    message: fallbackText(code)
  };
}

function classifyZod(error) {
  return {
    status: 400,
    code: 'VALIDATION_FAILED',
    details: {
      issues: error.issues.map(issue => ({
        path: issue.path.join('.'),
        code: issue.code,
        message: issue.message
      }))
    },
    message: fallbackText('VALIDATION_FAILED')
  };
}

// Errors of Express and its middleware (body-parser, ...) carry only a status; their
// messages describe the request, not the server.
function classifyHttp(error, status) {
  const code = CODE_BY_STATUS[status] || (status >= 500 ? 'INTERNAL_ERROR' : 'BAD_REQUEST');
  return {
    status,
    code,
    details: typeof error.type === 'string' ? { type: error.type } : undefined,
    message: fallbackText(code)
  };
}

/** What an error stands for: status, code, details and the thrown message. */
function classify(error) {
  if (error instanceof ServiceError) {
    return {
      status: error.status,
      code: error.code,
      details: error.details,
      message: error.message
    };
  }
  if (error instanceof StorageError) return classifyStorage(error);
  if (isLLMError(error)) return classifyLlm(error);
  if (error instanceof ZodError) return classifyZod(error);
  const status = httpStatusOf(error);
  if (status && typeof error.expose === 'boolean') return classifyHttp(error, status);
  return {
    status: 500,
    code: 'INTERNAL_ERROR',
    message: hasShowableMessage(error) ? error.message : fallbackText('INTERNAL_ERROR')
  };
}

/**
 * The response an error becomes.
 *
 * @param {unknown} error - Whatever was thrown or passed to `next`
 * @param {Object} [options]
 * @param {boolean} [options.rfc=false] - Answer in the RFC 6749 shape (OAuth endpoints)
 * @returns {{status: number, body: Object, headers: Object<string, string>}}
 */
export function toErrorResponse(error, { rfc = false } = {}) {
  const { status, code, details, message } = classify(error);
  // A 4xx shows what was thrown. A 5xx shows it only when it is safe (publicMessage):
  // it may otherwise name paths, hosts, credentials or provider text. The real message
  // is always logged by the error middleware.
  const text = (status >= 500 ? publicMessage(message) : message) || fallbackText(code);
  const headers = {};
  if (details?.retryAfterMs > 0)
    headers['Retry-After'] = String(Math.ceil(details.retryAfterMs / 1000));
  if (rfc) {
    return { status, body: { error: rfcCodeOf(status), error_description: text }, headers };
  }
  return {
    status,
    body: { error: text, code, ...(details ? { details } : {}) },
    headers
  };
}
