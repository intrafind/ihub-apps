// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * Redaction of secrets in what an admin is shown or what is audited: the
 * request an action test sent, its arguments and its raw response (#2974).
 *
 * Three rules, applied together:
 *
 * 1. **By name.** A header, object key or URL query parameter whose name
 *    looks like a credential (`Authorization`, `Cookie`, `X-Api-Key`,
 *    `password`, `client_secret`, `token`, …) has its value replaced.
 * 2. **By value.** Every secret value the caller knows (the credential the
 *    run resolved, the values of redacted headers) is replaced wherever it
 *    appears, also inside other strings (a token repeated in a URL or a body).
 * 3. **In URLs.** Basic-auth user info and secret query parameters
 *    (`redactUrlSecrets`).
 *
 * @module utils/secretRedaction
 */
import { redactUrlSecrets } from './httpConfig.js';

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

/** Shortest value treated as a secret by value (shorter ones would redact ordinary words). */
const MIN_SECRET_LENGTH = 6;

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

/**
 * The secret candidates in a header value: the whole value and, for
 * `Bearer x` / `Basic x` / `Token x`, the credential after the scheme.
 * @param {string} value
 * @returns {string[]}
 */
function secretsOfHeaderValue(value) {
  const text = String(value ?? '').trim();
  if (!text) return [];
  const out = [text];
  const scheme = /^(bearer|basic|token|apikey|digest)\s+(.+)$/i.exec(text);
  if (scheme) out.push(scheme[2].trim());
  return out;
}

/**
 * Replace every known secret value inside a string.
 * @param {string} text
 * @param {Iterable<string>} secrets
 * @returns {string}
 */
export function scrubSecrets(text, secrets) {
  if (typeof text !== 'string' || !text) return text;
  let out = text;
  // Longest first, so a secret that contains another is replaced whole.
  const list = [...new Set(secrets || [])]
    .filter(s => typeof s === 'string' && s.length >= MIN_SECRET_LENGTH)
    .sort((a, b) => b.length - a.length);
  for (const secret of list) {
    if (out.includes(secret)) out = out.split(secret).join(REDACTED);
  }
  return out;
}

/**
 * A URL with user info, secret query parameters and known secrets redacted.
 * @param {string} url
 * @param {Iterable<string>} [secrets]
 * @returns {string}
 */
export function redactUrl(url, secrets = []) {
  if (typeof url !== 'string') return url;
  let out = redactUrlSecrets(url).replace(/REDACTED/g, REDACTED);
  try {
    const parsed = new URL(out);
    let changed = false;
    for (const key of [...parsed.searchParams.keys()]) {
      if (isSecretName(key) && parsed.searchParams.get(key) !== REDACTED) {
        parsed.searchParams.set(key, REDACTED);
        changed = true;
      }
    }
    if (changed) out = parsed.toString();
  } catch {
    // Not an absolute URL: the regex pass above is what we can do.
  }
  return scrubSecrets(out, secrets);
}

/**
 * Headers with credential headers redacted. Returns the redacted copy and
 * the secret values it found (to scrub them elsewhere too).
 *
 * @param {Object|Headers|Map|Array|undefined} headers
 * @param {Iterable<string>} [secrets]
 * @returns {{headers: Object<string,string>, found: string[]}}
 */
export function redactHeaders(headers, secrets = []) {
  const entries = [];
  if (!headers) return { headers: {}, found: [] };
  if (typeof headers.forEach === 'function' && !Array.isArray(headers)) {
    headers.forEach((value, key) => entries.push([key, value]));
  } else if (Array.isArray(headers)) {
    for (const pair of headers) if (Array.isArray(pair)) entries.push([pair[0], pair[1]]);
  } else if (typeof headers === 'object') {
    entries.push(...Object.entries(headers));
  }
  const found = [];
  const out = {};
  for (const [key, value] of entries) {
    if (isSecretName(String(key))) {
      found.push(...secretsOfHeaderValue(value));
      out[key] = REDACTED;
    } else {
      out[key] = String(value ?? '');
    }
  }
  const all = [...secrets, ...found];
  for (const key of Object.keys(out)) out[key] = scrubSecrets(out[key], all);
  return { headers: out, found };
}

/**
 * A deep copy of a value with secret keys and known secret values redacted.
 * Depth and size are bounded; what is cut is marked.
 *
 * @param {unknown} value
 * @param {Iterable<string>} [secrets]
 * @param {number} [depth]
 * @returns {unknown}
 */
export function redactDeep(value, secrets = [], depth = 0) {
  if (depth > 12) return '[…]';
  if (typeof value === 'string') return scrubSecrets(value, secrets);
  if (Array.isArray(value)) return value.map(item => redactDeep(item, secrets, depth + 1));
  if (value && typeof value === 'object') {
    const out = {};
    for (const [key, item] of Object.entries(value)) {
      out[key] =
        isSecretName(key) && item !== null && item !== undefined && item !== ''
          ? REDACTED
          : redactDeep(item, secrets, depth + 1);
    }
    return out;
  }
  return value;
}

/**
 * The secret values of an object's secret keys (deep), to scrub them where
 * they appear under other names.
 * @param {unknown} value
 * @param {number} [depth]
 * @returns {string[]}
 */
export function secretValuesOf(value, depth = 0) {
  if (depth > 12 || !value || typeof value !== 'object') return [];
  const out = [];
  for (const [key, item] of Object.entries(value)) {
    if (isSecretName(key) && typeof item === 'string' && item) out.push(item);
    else if (item && typeof item === 'object') out.push(...secretValuesOf(item, depth + 1));
  }
  return out;
}

/**
 * A request or response body as text for display, redacted and capped.
 * JSON bodies have their secret keys redacted as well.
 *
 * @param {unknown} body
 * @param {Iterable<string>} secrets
 * @param {number} [maxChars=20000]
 * @returns {{text: string|null, truncated: boolean}}
 */
export function redactBody(body, secrets = [], maxChars = 20_000) {
  if (body === undefined || body === null || body === '') return { text: null, truncated: false };
  let text;
  if (typeof body === 'string') {
    try {
      const parsed = JSON.parse(body);
      text = JSON.stringify(redactDeep(parsed, secrets), null, 2);
    } catch {
      // URL-encoded forms: redact secret fields by name.
      text = /^[^=&\s]+=[^&]*(&[^=&\s]+=[^&]*)*$/.test(body)
        ? body
            .split('&')
            .map(pair => {
              const [key] = pair.split('=');
              return isSecretName(decodeURIComponent(key)) ? `${key}=${REDACTED}` : pair;
            })
            .join('&')
        : body;
      text = scrubSecrets(text, secrets);
    }
  } else if (typeof body === 'object' && !(body instanceof Uint8Array)) {
    if (typeof body.pipe === 'function' || typeof body.getReader === 'function') {
      return { text: '[stream]', truncated: false };
    }
    if (typeof body.toString === 'function' && body.constructor?.name === 'URLSearchParams') {
      return redactBody(body.toString(), secrets, maxChars);
    }
    text = JSON.stringify(redactDeep(body, secrets), null, 2);
  } else if (body instanceof Uint8Array) {
    return { text: `[${body.byteLength} bytes]`, truncated: false };
  } else {
    text = String(body);
  }
  if (text.length > maxChars) return { text: text.slice(0, maxChars), truncated: true };
  return { text, truncated: false };
}
