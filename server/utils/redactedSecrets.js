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
 * index, so reordering two providers cannot swap their secrets:
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
import { ServiceError } from './ServiceError.js';

/** What an admin read shows instead of a stored secret. */
export const SECRET_MARKER = '***REDACTED***';

/**
 * Every literal a read or a log may have put in place of a secret. A string
 * equal to one of them is never a real value, so it is refused on write.
 * Free text that merely contains one (an AI notice quoting "[redacted]") is not.
 */
const KNOWN_MARKERS = new Set([SECRET_MARKER, '[redacted]', '[REDACTED]']);

/** The masks `redactUrlSecrets` writes into a URL (`//REDACTED@`, `?token=REDACTED`). */
const URL_MASK_PATTERN = /\/\/REDACTED@|[?&][^=&#]+=REDACTED(?=$|[&#])/;

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
  Object.freeze({ path: 'proxyAuth.jwtProviders[].jwkUrl', kind: 'url' })
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
 * @param {string} path - e.g. `proxyAuth.jwtProviders[].jwkUrl`
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
 */
function walk(next, stored, segments, visit, pointer = []) {
  if (!isPlainObject(next)) return;
  const [segment, ...rest] = segments;
  if (rest.length === 0) {
    visit(next, isPlainObject(stored) ? stored : undefined, segment.key, pointer);
    return;
  }
  const child = next[segment.key];
  const storedChild = isPlainObject(stored) ? stored[segment.key] : undefined;
  if (!segment.array) {
    walk(child, storedChild, rest, visit, [...pointer, segment.key]);
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
    walk(element, key ? storedByKey.get(key) : undefined, rest, visit, [
      ...pointer,
      segment.key,
      String(index)
    ]);
  });
}

/**
 * The form a read shows of a stored value.
 *
 * @param {unknown} value - The stored value
 * @param {'secret'|'url'} kind
 * @returns {unknown} The masked value, or `undefined` to leave the field out
 */
function maskForRead(value, kind) {
  if (kind === 'url') return redactUrlSecrets(value);
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
    value === redactUrlSecrets(storedValue)
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
    walk(next, stored, parsePath(path), (holder, storedHolder, leaf) => {
      const storedHas = storedHolder !== undefined && storedHolder[leaf] !== undefined;
      const storedValue = storedHas ? storedHolder[leaf] : undefined;

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
    });
  }
  return next;
}

/**
 * Whether a string is a redaction marker or a masked URL, never a real value.
 *
 * @param {unknown} value
 * @returns {boolean}
 */
export function isRedactedValue(value) {
  return typeof value === 'string' && (KNOWN_MARKERS.has(value) || URL_MASK_PATTERN.test(value));
}

/**
 * Refuse a body that still holds a redaction marker anywhere.
 *
 * Runs after {@link restoreRedacted}: a marker that survives it had no stored
 * value to stand for (a field the restore does not know, a renamed provider), and
 * storing it would replace a secret with the word "REDACTED".
 *
 * @param {unknown} obj - The body about to be written
 * @param {Array<string>} [basePath] - Path segments of `obj` within the document
 * @throws {ServiceError} `VALIDATION_FAILED` (400) whose `errors[].pointer` names each field
 */
export function assertNoMarkers(obj, basePath = []) {
  const found = [];
  const visit = (value, path) => {
    if (isRedactedValue(value)) {
      found.push(path);
      return;
    }
    if (Array.isArray(value)) value.forEach((item, index) => visit(item, [...path, String(index)]));
    else if (isPlainObject(value)) {
      for (const [key, child] of Object.entries(value)) visit(child, [...path, key]);
    }
  };
  visit(obj, basePath);
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
