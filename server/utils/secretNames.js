// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * Which names carry credentials, and what a redacted value reads as. Without
 * dependencies on purpose: `secretRedaction.js` re-exports these for the
 * redaction of requests and responses, and `configOverrides.js` uses them while
 * the config cache is still loading, where importing the HTTP layer would close
 * an import cycle.
 *
 * @module utils/secretNames
 */

/** What a redacted value is replaced with. */
export const REDACTED = '[redacted]';

/** Header names that always carry credentials. */
const SECRET_HEADERS = new Set([
  'authorization',
  'proxy-authorization',
  'cookie',
  'set-cookie',
  'x-api-key',
  'api-key',
  'apikey',
  'x-auth-token',
  'x-access-token',
  'x-csrf-token',
  'x-xsrf-token'
]);

/**
 * Key names that look like a credential. Anchored on word parts so that
 * `author`, `tokens_used` or `keyword` are not caught, while `apiKey`,
 * `api_key`, `client_secret`, `accessToken`, `password` and `passwd` are.
 */
const SECRET_KEY_PATTERN =
  /(^|[_\-.])(pass(word|wd)?|secret|client[_-]?secret|api[_-]?key|apikey|access[_-]?token|refresh[_-]?token|id[_-]?token|auth[_-]?token|token|bearer|authorization|cookie|session[_-]?id|private[_-]?key|credentials?|signature)$/i;

/**
 * Whether a key or header name names a credential.
 * @param {string} name
 * @returns {boolean}
 */
export function isSecretName(name) {
  if (typeof name !== 'string' || !name) return false;
  const lower = name.toLowerCase();
  if (SECRET_HEADERS.has(lower)) return true;
  // camelCase → snake for the pattern (`accessToken` → `access_token`).
  const snake = name.replace(/([a-z0-9])([A-Z])/g, '$1_$2');
  return SECRET_KEY_PATTERN.test(snake);
}
