// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * One marker, one restore, one refusal for secrets that admin reads redact.
 *
 * An admin GET never returns a stored secret: it answers {@link SECRET_MARKER}
 * (or, for a URL, the URL with its credentials masked). Pages send that body
 * back on save, so every writer must put the stored value back where it finds
 * the mask, and must never persist a mask. Before this module the marker was
 * defined in three route files and each restored a different subset of fields;
 * a field the restore did not list was saved as the literal marker, and a field
 * the GET left out (`proxyAuth.jwtProviders[].jwkUrl`) was deleted on save.
 *
 * Secret locations are described by dotted paths. A segment ending in `[]` is an
 * array whose elements are matched by `name` (falling back to `id`), never by
 * index, so reordering two providers cannot swap their secrets. A last segment
 * `*` stands for every key of the object before it (a map of headers), and
 * applies to the keys the body being written has:
 *
 * ```js
 * restoreRedacted(next, stored, [
 *   { path: 'auth.jwtSecret' },
 *   { path: 'proxyAuth.jwtProviders[].jwkUrl', kind: 'url' }
 * ]);
 * ```
 *
 * Rules on save (`mode: 'save'`), applied only where the enclosing object is
 * present in `next`:
 * - field omitted → keep the stored value
 * - field is the marker (or the masked form of the stored URL) → keep the stored value
 * - field is `null` → clear it (the key is removed)
 * - anything else → the new value
 *
 * @module utils/redactedSecrets
 */

import { redactUrlSecrets } from './urlSecrets.js';
import { isSecretQueryParamName } from './secretNames.js';
import { isSecretName } from './secretRedaction.js';
import { ServiceError } from './ServiceError.js';

/** What an admin read shows instead of a stored secret. */
export const SECRET_MARKER = '***REDACTED***';

/**
 * Every literal a read or a log may have put in place of a secret. A string
 * equal to one of them is never a real value, so it is refused on write.
 * Free text that merely contains one (an AI notice quoting "[redacted]") is not.
 */
const KNOWN_MARKERS = new Set([SECRET_MARKER, '[redacted]', '[REDACTED]']);

/** The user-info mask `redactUrlSecrets` writes into a URL (`//REDACTED@`). */
const USER_INFO_MASK = '//REDACTED@';

/** The query value mask `redactUrlSecrets` writes into a URL (`?token=REDACTED`). */
const QUERY_VALUE_MASK = '=REDACTED';

/**
 * Whether the `=` at `equalsAt` ends a query parameter name: a `?` or `&`
 * followed by at least one character that is none of `=`, `&`, `#`.
 *
 * Walks back from the `=` and stops at the first `=`, `&` or `#`, so the walks
 * for all masks of one string together read it at most once.
 *
 * @param {string} value
 * @param {number} equalsAt - Index of the `=` of a {@link QUERY_VALUE_MASK}
 * @returns {boolean}
 */
function endsQueryParamName(value, equalsAt) {
  for (let index = equalsAt - 1; index >= 0; index--) {
    const char = value[index];
    if (char === '=' || char === '#') return false;
    const nameIsEmpty = index === equalsAt - 1;
    // `&` ends every name; `?` may also be part of a longer one (`a?b?c=`).
    if (char === '&') return !nameIsEmpty;
    if (char === '?' && !nameIsEmpty) return true;
  }
  return false;
}

/**
 * Whether a string holds a mask `redactUrlSecrets` writes into a URL:
 * `//REDACTED@`, or a query value `REDACTED` that ends the string or is
 * followed by `&` or `#` (`?token=REDACTED`). Plain string code, linear in the
 * length of `value`, because admin input reaches it.
 *
 * @param {string} value
 * @returns {boolean}
 */
function hasUrlMask(value) {
  if (value.includes(USER_INFO_MASK)) return true;
  for (
    let at = value.indexOf(QUERY_VALUE_MASK);
    at !== -1;
    at = value.indexOf(QUERY_VALUE_MASK, at + 1)
  ) {
    const end = at + QUERY_VALUE_MASK.length;
    const endsValue = end === value.length || value[end] === '&' || value[end] === '#';
    if (endsValue && endsQueryParamName(value, at)) return true;
  }
  return false;
}

/**
 * The secrets of `config/platform.json` that the admin read redacts.
 *
 * `jwkUrl` is a public JWKS address, shown with credentials masked; the rest
 * are secrets shown as {@link SECRET_MARKER}. Integration secrets (OIDC, LDAP,
 * NTLM) live in the credential store and are referenced by `*Ref` ids.
 */
export const PLATFORM_SECRET_PATHS = Object.freeze([
  Object.freeze({ path: 'auth.jwtSecret' }),
  Object.freeze({ path: 'localAuth.jwtSecret' }),
  Object.freeze({ path: 'speech.azure.subscriptionKey' }),
  Object.freeze({ path: 'proxyAuth.jwtProviders[].jwkUrl', kind: 'url' }),
  // Every OTLP exporter header (`Authorization: Bearer …`, API keys).
  Object.freeze({ path: 'telemetry.exporters.otlp.headers.*' })
]);

/**
 * Whether a value is an environment variable placeholder like `${NAME}`.
 * Placeholders are not secrets and are shown as they are.
 *
 * @param {unknown} value
 * @returns {boolean}
 */
export function isEnvVarPlaceholder(value) {
  return typeof value === 'string' && /^\$\{[A-Z_][A-Z0-9_]*\}$/i.test(value);
}

/** @param {unknown} value */
function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/**
 * Split a dotted secret path into segments: `{ key, array }`.
 *
 * @param {string} path - e.g. `proxyAuth.jwtProviders[].jwkUrl` or `telemetry.exporters.otlp.headers.*`
 * @returns {Array<{key: string, array: boolean}>}
 */
function parsePath(path) {
  return path
    .split('.')
    .map(segment =>
      segment.endsWith('[]')
        ? { key: segment.slice(0, -2), array: true }
        : { key: segment, array: false }
    );
}

/** The identity of an array element: its `name`, else its `id`. */
function elementKey(element) {
  if (!isPlainObject(element)) return undefined;
  if (typeof element.name === 'string' && element.name) return `name:${element.name}`;
  if (typeof element.id === 'string' && element.id) return `id:${element.id}`;
  return undefined;
}

/**
 * Walk `next` and `stored` in step along a secret path and call `visit` once
 * for each object that holds the secret's leaf in `next`.
 *
 * @param {Object} next - The body being written (or read)
 * @param {Object|null|undefined} stored - The stored body, or nothing
 * @param {Array<{key: string, array: boolean}>} segments
 * @param {(holder: Object, storedHolder: Object|undefined, leaf: string, pointer: string[]) => void} visit
 * @param {string[]} [pointer] - The path walked so far
 * @param {Object} [options]
 * @param {boolean} [options.storedKeys=false] - A `*` leaf also visits the keys
 *   only `stored` has (rollback: the current secrets stay), creating the
 *   holding object in `next` when only `stored` has one
 */
function walk(next, stored, segments, visit, pointer = [], options = {}) {
  if (!isPlainObject(next)) return;
  const [segment, ...rest] = segments;
  if (rest.length === 0) {
    const storedHolder = isPlainObject(stored) ? stored : undefined;
    if (segment.key === '*') {
      const keys = new Set(Object.keys(next));
      if (options.storedKeys && storedHolder) {
        for (const key of Object.keys(storedHolder)) keys.add(key);
      }
      for (const key of keys) visit(next, storedHolder, key, pointer);
      return;
    }
    visit(next, storedHolder, segment.key, pointer);
    return;
  }
  const storedChild = isPlainObject(stored) ? stored[segment.key] : undefined;
  // Rollback of a `*` path: an object the snapshot lacks along the way (the
  // `otlp` above `headers`) is created, so the current secrets below it stay.
  // A `null` is replaced only on the map itself: a `null` above it (no OTLP
  // exporter at all) is a stored state of its own and stays.
  if (
    options.storedKeys &&
    segments.at(-1).key === '*' &&
    !segment.array &&
    (next[segment.key] === undefined || (next[segment.key] === null && rest.length === 1)) &&
    isPlainObject(storedChild)
  ) {
    next[segment.key] = {};
  }
  const child = next[segment.key];
  if (!segment.array) {
    walk(child, storedChild, rest, visit, [...pointer, segment.key], options);
    return;
  }
  if (!Array.isArray(child)) return;
  const storedByKey = new Map();
  if (Array.isArray(storedChild)) {
    for (const element of storedChild) {
      const key = elementKey(element);
      if (key && !storedByKey.has(key)) storedByKey.set(key, element);
    }
  }
  child.forEach((element, index) => {
    const key = elementKey(element);
    walk(
      element,
      key ? storedByKey.get(key) : undefined,
      rest,
      visit,
      [...pointer, segment.key, String(index)],
      options
    );
  });
}

/** A query parameter name as written, decoded where it can be. */
function decodeParamName(name) {
  try {
    return decodeURIComponent(name.replaceAll('+', ' '));
  } catch {
    return name;
  }
}

/**
 * A URL with every credential masked: user info and the parameters
 * `redactUrlSecrets` knows, plus every query parameter whose name looks like a
 * credential by the rule the action-test redaction uses (`isSecretName`:
 * `apiKey`, `X-Amz-Signature`, `refresh_token`, …). Only the
 * values change, so the rest of the URL reads as stored. Read and restore both
 * use this one function, so a masked URL sent back is recognized exactly.
 *
 * @param {unknown} value
 * @returns {unknown} The masked URL, or `value` when it is not a string
 */
export function maskUrlCredentials(value) {
  if (typeof value !== 'string') return value;
  const url = redactUrlSecrets(value);
  let masked = '';
  let index = 0;
  while (index < url.length) {
    const param = queryParamAt(url, index);
    const name = param.name === undefined ? undefined : decodeParamName(param.name);
    // Both rules on the decoded name: `redactUrlSecrets` only knows the
    // spellings as written, so `%63ode=` (`code`) or `%73ig=` (`sig`) reach here.
    const masks =
      name !== undefined &&
      param.value !== 'REDACTED' &&
      (isSecretName(name) || isSecretQueryParamName(name));
    masked += masks ? `${url[index]}${param.name}=REDACTED` : url.slice(index, param.end);
    index = param.end;
  }
  return masked;
}

/** Whether a character is whitespace, as `\s` in a regular expression. */
function isWhitespace(char) {
  return /\s/.test(char);
}

/**
 * Read the query parameter that starts at `start`: `?` or `&`, a name of at
 * least one character that is none of `=`, `&`, `#` or whitespace, `=`, and a
 * value up to the next `&`, `#` or whitespace.
 *
 * When there is none, `end` skips every character that cannot start one: the
 * name run that a `?` begins also covers every `?` inside it, so none of them
 * can start a parameter either. That keeps {@link maskUrlCredentials} linear.
 *
 * @param {string} url
 * @param {number} start
 * @returns {{end: number, name?: string, value?: string}} `name` and `value`
 *   are set only when a parameter starts at `start`
 */
function queryParamAt(url, start) {
  if (url[start] !== '?' && url[start] !== '&') return { end: start + 1 };
  let nameEnd = start + 1;
  while (nameEnd < url.length && !'=&#'.includes(url[nameEnd]) && !isWhitespace(url[nameEnd])) {
    nameEnd++;
  }
  if (nameEnd === start + 1) return { end: start + 1 };
  if (url[nameEnd] !== '=') return { end: nameEnd };
  let valueEnd = nameEnd + 1;
  while (valueEnd < url.length && !'&#'.includes(url[valueEnd]) && !isWhitespace(url[valueEnd])) {
    valueEnd++;
  }
  return {
    end: valueEnd,
    name: url.slice(start + 1, nameEnd),
    value: url.slice(nameEnd + 1, valueEnd)
  };
}

/**
 * The form a read shows of a stored value.
 *
 * @param {unknown} value - The stored value
 * @param {'secret'|'url'} kind
 * @returns {unknown} The masked value, or `undefined` to leave the field out
 */
function maskForRead(value, kind) {
  if (kind === 'url') return maskUrlCredentials(value);
  if (value === undefined || value === null || value === '') return undefined;
  if (isEnvVarPlaceholder(value)) return value;
  return SECRET_MARKER;
}

/**
 * Whether `value` is what a read made of `storedValue` — the marker, or the
 * masked form of a stored URL — so the stored value belongs in its place.
 *
 * @param {unknown} value
 * @param {unknown} storedValue
 * @param {'secret'|'url'} kind
 * @returns {boolean}
 */
function isMaskOf(value, storedValue, kind) {
  if (value === SECRET_MARKER) return true;
  return (
    kind === 'url' &&
    typeof value === 'string' &&
    typeof storedValue === 'string' &&
    value !== storedValue &&
    value === maskUrlCredentials(storedValue)
  );
}

/**
 * A copy of `obj` with every secret path masked for an admin read.
 *
 * Secrets become {@link SECRET_MARKER} (an empty secret is left out, a
 * `${ENV}` placeholder is kept); URLs keep their address with user info and
 * token query parameters masked.
 *
 * @param {Object|null|undefined} obj - A stored body (not modified)
 * @param {ReadonlyArray<{path: string, kind?: 'secret'|'url'}>} [secretPaths]
 * @returns {Object|null|undefined} The masked copy, or `obj` when it is not an object
 */
export function redactForRead(obj, secretPaths = PLATFORM_SECRET_PATHS) {
  if (!isPlainObject(obj)) return obj;
  const copy = structuredClone(obj);
  for (const { path, kind = 'secret' } of secretPaths) {
    walk(copy, undefined, parsePath(path), (holder, _stored, leaf) => {
      if (!Object.hasOwn(holder, leaf)) return;
      const masked = maskForRead(holder[leaf], kind);
      if (masked === undefined) delete holder[leaf];
      else holder[leaf] = masked;
    });
  }
  return copy;
}

/**
 * Put stored secrets back into a body about to be written, in place.
 *
 * `mode: 'save'` (an admin save) follows the rules in the module comment.
 * `mode: 'rollback'` (restoring an older snapshot) keeps the CURRENT secret
 * whatever the snapshot holds: a rollback must never bring back a rotated, and
 * possibly leaked, secret, nor write the marker an older snapshot may carry.
 * A secret the current file does not have is removed. URLs (`kind: 'url'`) are
 * ordinary configuration on rollback; only a masked one is restored.
 *
 * @param {Object} next - The body to write (modified)
 * @param {Object|null|undefined} stored - The body stored now
 * @param {ReadonlyArray<{path: string, kind?: 'secret'|'url'}>} [secretPaths]
 * @param {Object} [options]
 * @param {'save'|'rollback'} [options.mode='save']
 * @returns {Object} `next`
 */
export function restoreRedacted(
  next,
  stored,
  secretPaths = PLATFORM_SECRET_PATHS,
  { mode = 'save' } = {}
) {
  for (const { path, kind = 'secret' } of secretPaths) {
    walk(
      next,
      stored,
      parsePath(path),
      (holder, storedHolder, leaf) =>
        restoreLeaf(
          holder,
          // Own keys only: a header named `constructor` is not Object's.
          storedHolder && Object.hasOwn(storedHolder, leaf) ? storedHolder[leaf] : undefined,
          leaf,
          { kind, mode }
        ),
      [],
      { storedKeys: mode === 'rollback' && kind === 'secret' }
    );
  }
  return next;
}

/**
 * Apply the {@link restoreRedacted} rules to one secret field.
 *
 * @param {Object} holder - The object in the body being written that holds the field (modified)
 * @param {unknown} storedValue - The stored value of the field; `undefined` when none
 * @param {string} leaf - The field name
 * @param {Object} options
 * @param {'secret'|'url'} options.kind
 * @param {'save'|'rollback'} options.mode
 */
function restoreLeaf(holder, storedValue, leaf, { kind, mode }) {
  const storedHas = storedValue !== undefined;

  if (mode === 'rollback' && kind === 'secret') {
    if (storedHas) holder[leaf] = storedValue;
    else delete holder[leaf];
    return;
  }

  if (!Object.hasOwn(holder, leaf) || holder[leaf] === undefined) {
    if (mode === 'save' && storedHas) holder[leaf] = storedValue;
    return;
  }
  if (holder[leaf] === null) {
    if (mode === 'save') delete holder[leaf];
    return;
  }
  if (storedHas && isMaskOf(holder[leaf], storedValue, kind)) {
    holder[leaf] = storedValue;
  }
}

/**
 * Whether a string is a redaction marker or a masked URL, never a real value.
 *
 * @param {unknown} value
 * @returns {boolean}
 */
export function isRedactedValue(value) {
  return typeof value === 'string' && (KNOWN_MARKERS.has(value) || hasUrlMask(value));
}

/** The child of a stored value at `key`, or `undefined` when there is none. */
function storedChildOf(stored, key, isArrayIndex) {
  if (isArrayIndex) return Array.isArray(stored) ? stored[Number(key)] : undefined;
  return isPlainObject(stored) && Object.hasOwn(stored, key) ? stored[key] : undefined;
}

/**
 * Refuse a body that still holds a redaction marker.
 *
 * Runs after {@link restoreRedacted}: a marker that survives it had no stored
 * value to stand for (a field the restore does not know, a renamed provider), and
 * storing it would replace a secret with the word "REDACTED".
 *
 * With `options.stored`, only values the write changes are checked: a string
 * equal to the value stored at the same place is left alone, so a value that
 * is already stored (a prompt variable that reads "[REDACTED]", a legacy marker
 * from an older writer) cannot make every later save, or a rollback, fail on a
 * field the request did not touch. Array elements are compared by position.
 *
 * @param {unknown} obj - The body about to be written
 * @param {Array<string>} [basePath] - Path segments of `obj` within the document
 * @param {Object} [options]
 * @param {unknown} [options.stored] - The value stored now at `basePath`;
 *   omitted, every marker is refused
 * @throws {ServiceError} `VALIDATION_FAILED` (400) whose `errors[].pointer` names each field
 */
export function assertNoMarkers(obj, basePath = [], options = {}) {
  const compare = Object.hasOwn(options, 'stored');
  const found = [];
  const visit = (value, stored, path) => {
    if (isRedactedValue(value)) {
      if (!compare || value !== stored) found.push(path);
      return;
    }
    if (Array.isArray(value)) {
      value.forEach((item, index) =>
        visit(item, storedChildOf(stored, String(index), true), [...path, String(index)])
      );
    } else if (isPlainObject(value)) {
      for (const [key, child] of Object.entries(value)) {
        visit(child, storedChildOf(stored, key, false), [...path, key]);
      }
    }
  };
  visit(obj, options.stored, basePath);
  if (found.length === 0) return;
  throw new ServiceError(
    'VALIDATION_FAILED',
    `A redacted placeholder cannot be saved as a value (${found
      .map(path => path.join('.'))
      .join(', ')}). Enter the real value, or leave the field out to keep the stored one.`,
    {
      details: found.map(path => ({
        path,
        code: 'redacted_value',
        message: 'A redacted placeholder cannot be saved as a value'
      }))
    }
  );
}
