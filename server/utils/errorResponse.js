// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * One error response shape for the whole API: `application/problem+json` (RFC 9457)
 * plus our `code`.
 *
 * ```json
 * {
 *   "type": "urn:ihub:problem:NOT_FOUND",
 *   "title": "Not found",
 *   "status": 404,
 *   "detail": "Scheduled task t1 not found",
 *   "code": "NOT_FOUND",
 *   "details": { "taskId": "t1" }
 * }
 * ```
 *
 * - `type`, `title`, `status`: the problem type (`urn:ihub:problem:<code>`), the English
 *   text of the code, and the HTTP status again.
 * - `detail`: what went wrong in this occurrence. For a 4xx it is the message that was
 *   thrown; for a 5xx the message too, when it passes `publicMessage`, else the title.
 *   The real message is always logged.
 * - `code` (always): a registry code of `shared/apiErrors.js`. The client picks its
 *   message with the i18n key `apiErrors.<code>`.
 * - `details` (only when there is something to say): a plain object whose members are
 *   the interpolation parameters of that message. It never holds `code`.
 * - `errors` (validation only): `[{ pointer, code, message }]`, `pointer` being an
 *   RFC 6901 JSON Pointer to the offending member.
 *
 * OAuth endpoints keep their RFC 6749 body, `{ error, error_description }`.
 *
 * @module utils/errorResponse
 */

import { ZodError } from 'zod';
// A JSON import, not a file read by URL: `import.meta` keeps a module out of reach of the
// jest tests that load it through `pathSecurity` and `responseHelpers`.
import en from '../../shared/i18n/en.json' with { type: 'json' };
import {
  API_ERROR_CODES,
  GENERIC_ERROR_CODES,
  LLM_API_ERROR_CODES
} from '../../shared/apiErrors.js';
import { StorageError, storageHttpStatus } from '../storage/errors.js';
import { isLLMError } from '../services/loop/contracts/errors.js';
import { ServiceError } from './ServiceError.js';

const FALLBACK_TEXT = en.apiErrors;

/** The generic code of an HTTP status, for errors that only carry a status. */
const CODE_BY_STATUS = Object.freeze(
  Object.fromEntries(
    Object.entries(GENERIC_ERROR_CODES)
      .filter(([code]) => code !== 'VALIDATION_FAILED' && code !== 'TIMEOUT')
      .map(([code, status]) => [status, code])
  )
);

/**
 * The generic registry code of an HTTP status (`NOT_FOUND` for 404), for the places that
 * answer with a status and a message only.
 *
 * @param {number} status
 * @returns {string}
 */
export function codeOfStatus(status) {
  return CODE_BY_STATUS[status] || (status >= 500 ? 'INTERNAL_ERROR' : 'BAD_REQUEST');
}

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

/**
 * The title of a problem: the English text of its code. A code the registry does not know
 * (a protocol code of another subsystem, a code carried by a thrown error) takes the text
 * of its status, so a 400 never reads "Internal error".
 */
function titleOf(code, status) {
  return FALLBACK_TEXT[code] || fallbackText(codeOfStatus(status));
}

function httpStatusOf(error) {
  const status = error?.status ?? error?.statusCode;
  return Number.isInteger(status) && status >= 400 && status <= 599 ? status : null;
}

/**
 * Shapes in a message that a caller must not see on a 5xx: file paths and file names,
 * URLs, hosts, IPs and ports, stack frames, errno codes, credential words, token-like
 * runs and SQL (see `looksLikeSql`). The list is deliberately blunt: a message that trips one of them is
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
  /[\u0000-\u001f\u007f]/ // control characters, newlines
];

const SQL_VERB = /\b(?:select|insert|update|delete)\b/i;
const SQL_CLAUSE = /\b(?:from|into|set|where)\b/i;

/** A SQL verb and a SQL clause word in one message. Two plain tests, no backtracking. */
function looksLikeSql(text) {
  return SQL_VERB.test(text) && SQL_CLAUSE.test(text);
}

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
  if (looksLikeSql(text)) return null;
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

/** An RFC 6901 JSON Pointer for a Zod path (array) or a dotted path (string). */
export function jsonPointer(path) {
  const segments = Array.isArray(path) ? path : String(path ?? '').split('.');
  return segments
    .filter(segment => segment !== '')
    .map(segment => `/${String(segment).replaceAll('~', '~0').replaceAll('/', '~1')}`)
    .join('');
}

function classifyZod(error) {
  return {
    status: 400,
    code: 'VALIDATION_FAILED',
    errors: error.issues.map(issue => ({
      pointer: jsonPointer(issue.path),
      code: issue.code,
      message: issue.message
    })),
    message: fallbackText('VALIDATION_FAILED')
  };
}

/**
 * Splits `details.issues` (a list of `{ path, code?, message }`) into the `errors` member.
 * A list of another shape stays in `details`.
 */
function splitIssues(details) {
  const issues = details?.issues;
  const listed =
    Array.isArray(issues) &&
    issues.length > 0 &&
    issues.every(issue => issue && typeof issue === 'object' && typeof issue.message === 'string');
  if (!listed) return { details };
  const rest = { ...details };
  delete rest.issues;
  return {
    details: Object.keys(rest).length ? rest : undefined,
    errors: issues.map(issue => ({
      pointer: jsonPointer(issue.path ?? issue.field),
      code: typeof issue.code === 'string' ? issue.code : 'INVALID',
      message: issue.message
    }))
  };
}

// Errors of Express and its middleware (body-parser, ...) carry only a status; their
// messages describe the request, not the server.
function classifyHttp(error, status) {
  const code = codeOfStatus(status);
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
      ...splitIssues(error.details),
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

/** The problem type of a code: a stable identifier, not a URL to fetch. */
export function problemType(code) {
  return `urn:ihub:problem:${code}`;
}

/** Media type of every error body except the RFC 6749 one of the OAuth endpoints. */
export const PROBLEM_CONTENT_TYPE = 'application/problem+json';

/**
 * The response an error becomes.
 *
 * @param {unknown} error - Whatever was thrown or passed to `next`
 * @param {Object} [options]
 * @param {boolean} [options.rfc=false] - Answer in the RFC 6749 shape (OAuth endpoints)
 * @returns {{status: number, body: Object, headers: Object<string, string>}}
 */
export function toErrorResponse(error, { rfc = false } = {}) {
  const { status, code, details, errors, message } = classify(error);
  // A 4xx shows what was thrown. A 5xx shows it only when it is safe (publicMessage):
  // it may otherwise name paths, hosts, credentials or provider text. The real message
  // is always logged by the error middleware.
  const text = (status >= 500 ? publicMessage(message) : message) || titleOf(code, status);
  const headers = {};
  if (details?.retryAfterMs > 0)
    headers['Retry-After'] = String(Math.ceil(details.retryAfterMs / 1000));
  if (rfc) {
    return { status, body: { error: rfcCodeOf(status), error_description: text }, headers };
  }
  headers['Content-Type'] = PROBLEM_CONTENT_TYPE;
  return {
    status,
    body: {
      type: problemType(code),
      title: titleOf(code, status),
      status,
      detail: text,
      code,
      ...(details ? { details } : {}),
      ...(errors ? { errors } : {})
    },
    headers
  };
}

/**
 * Answers a request with the error response of `error`, without throwing. For the
 * places that must write the response themselves (inside a `try` whose `catch` would
 * answer again, a stream that has not started); everywhere else, throw.
 *
 * @param {import('express').Response} res
 * @param {unknown} error - A `ServiceError` or anything `toErrorResponse` understands
 * @param {Object} [options]
 * @param {boolean} [options.rfc=false]
 * @returns {import('express').Response}
 */
export function sendProblem(res, error, options) {
  const { status, body, headers } = toErrorResponse(error, options);
  for (const [name, value] of Object.entries(headers)) res.setHeader(name, value);
  return res.status(status).json(body);
}
