// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * The document etag rule, in one place.
 *
 * `DocumentStore` contracts the etag as derived from the document's data and
 * nothing else, so that two providers holding the same document report the
 * same value and a migration can verify a copy by comparing etags. That rule
 * was previously written out three times — once in each filesystem store and
 * once in the conformance suite — and shared nowhere, so the next provider
 * would have reimplemented it from prose against a hard-coded gate.
 *
 * Two shapes of document, one rule each:
 *
 * - **Enveloped** namespaces store a body the provider owns the encoding of,
 *   so the digest is over {@link serializeDocument} — canonical, because key
 *   order is the writer's incidental choice and a backend that stores bodies
 *   structurally hands them back in its own order.
 * - **Raw** namespaces are a view over files an installation edits by hand, so
 *   the file *is* the document and the digest is over its bytes exactly as
 *   stored. Two files whose parsed data is equal but whose formatting differs
 *   are different documents — which is what lets a compare-and-set notice a
 *   hand edit.
 *
 * Both end at {@link documentEtag}; they differ only in what they hand it.
 *
 * The conformance suite deliberately does **not** import `documentEtag`. A
 * suite that computes the expected value with the implementation under test
 * cannot fail when that implementation is wrong, so it keeps its own digest
 * expression, and its strongest assertions compare two etags the provider
 * reported against each other rather than against any recomputation.
 *
 * @module storage/etag
 */
import crypto from 'node:crypto';
import { canonicalJson } from './canonicalJson.js';

/**
 * Serialize an enveloped document's body for digesting and sizing.
 *
 * @param {any} data - Document body as passed to `put`
 * @returns {string} The canonical serialization
 */
export function serializeDocument(data) {
  return canonicalJson(data);
}

/**
 * sha256 hex of an already-serialized document body.
 *
 * This is a content digest for cache validation and compare-and-set, not a
 * credential derivation: it is never compared against a user-supplied secret
 * and never authenticates anything. A fast hash is the right tool, and it has
 * to stay one, because the value is contracted to be reproducible by any
 * provider holding the same document.
 *
 * CodeQL reaches this sink from config loaders that carry secret-shaped fields
 * and reads it as a password hash. It is not one. What *would* make it one:
 * handing a document's etag to a caller who could use it to confirm a guessed
 * secret. Re-examine this suppression if an etag ever becomes externally
 * visible for a document that stores credentials.
 *
 * @param {string} serialized - Canonical JSON, or a raw namespace's stored bytes
 * @returns {string} Hex digest
 */
export function documentEtag(serialized) {
  return crypto.createHash('sha256').update(serialized, 'utf8').digest('hex'); // lgtm[js/insufficient-password-hash] -- entity tag over a document body, not a stored password
}

/** Characters buffered before they are handed to the hash. */
const DIGEST_CHUNK = 64 * 1024;

/**
 * A value after its own `toJSON()`, as `JSON.stringify` sees it.
 *
 * @param {any} value - Raw value
 * @param {string} key - Property name or array index it was found under
 * @returns {any}
 */
function toJsonValue(value, key) {
  if (value === null) return null;
  const type = typeof value;
  if ((type === 'object' || type === 'bigint') && typeof value.toJSON === 'function') {
    value = value.toJSON(key);
  }
  // Boxed primitives serialize as the primitive.
  if (value instanceof Number || value instanceof String || value instanceof Boolean) {
    return value.valueOf();
  }
  return value;
}

/**
 * Whether `JSON.stringify` leaves a value out of an object (and writes `null`
 * for it in an array).
 *
 * @param {any} value - Value after {@link toJsonValue}
 * @returns {boolean}
 */
function isOmitted(value) {
  const type = typeof value;
  return type === 'undefined' || type === 'function' || type === 'symbol';
}

/**
 * Order two keys by UTF-16 code units — exactly what `Array.prototype.sort`
 * does without a comparator, written out so it is visibly locale-independent.
 *
 * @param {string} a
 * @param {string} b
 * @returns {number}
 */
function compareCodeUnits(a, b) {
  if (a < b) return -1;
  return a > b ? 1 : 0;
}

/** An array-index property name, which JavaScript objects order numerically. */
const ARRAY_INDEX = /^(?:0|[1-9]\d*)$/;
const MAX_ARRAY_INDEX = 2 ** 32 - 2;

/**
 * The order `canonicalJson` emits an object's keys in.
 *
 * `canonicalJson` sorts the keys and then rebuilds the object by assignment,
 * so its output follows the property order of a freshly built object rather
 * than the sort alone: array-index keys (`"9"`, `"10"`) come first in numeric
 * order, the rest follow in sorted order. And assigning an own `__proto__` key
 * sets the prototype instead of a property, so that key never reaches its
 * output at all. The etag is defined by that output, so both are mirrored.
 *
 * @param {Object} value - Plain object
 * @returns {string[]} Keys in emission order
 */
function canonicalKeyOrder(value) {
  const indices = [];
  const names = [];
  for (const key of Object.keys(value)) {
    if (ARRAY_INDEX.test(key) && Number(key) <= MAX_ARRAY_INDEX) indices.push(key);
    else if (key !== '__proto__') names.push(key);
  }
  if (indices.length > 1) indices.sort((a, b) => Number(a) - Number(b));
  if (names.length > 1) names.sort(compareCodeUnits);
  return indices.length === 0 ? names : indices.concat(names);
}

/**
 * `etag` and `size` of an enveloped document's body, without serializing it.
 *
 * Exactly `documentEtag(serializeDocument(data))` and the UTF-8 byte length of
 * that serialization, but streamed: the canonical text is produced piece by
 * piece straight into the hash, so neither the whole string nor the key-sorted
 * copy of every object `canonicalJson` builds on the way ever exists. That is
 * what a metadata-only listing pays per document — on a workflow state of tens
 * of megabytes it was the larger half of the boot spike in #3624.
 *
 * Follows `JSON.stringify` in everything but key order, as `canonicalJson`
 * does: `toJSON` is applied, `undefined`, functions and symbols are dropped
 * from objects and become `null` in arrays, non-finite numbers are `null`.
 * Primitives are still escaped by `JSON.stringify`, one at a time, so the
 * escaping cannot drift from the serializer. A body that serializes to nothing
 * at all is digested as `null`, the body the document stores record for it.
 *
 * @param {any} data - Document body
 * @returns {{etag: string, size: number}} Digest and byte length
 */
export function documentDigest(data) {
  const hash = crypto.createHash('sha256');
  let size = 0;
  let buffer = '';
  const emit = text => {
    buffer += text;
    if (buffer.length >= DIGEST_CHUNK) {
      hash.update(buffer, 'utf8');
      size += Buffer.byteLength(buffer, 'utf8');
      buffer = '';
    }
  };

  const write = value => {
    if (value === null) {
      emit('null');
      return;
    }
    if (typeof value !== 'object') {
      // Non-finite numbers become null and a bigint throws, as in the serializer.
      emit(JSON.stringify(value));
      return;
    }
    if (Array.isArray(value)) {
      emit('[');
      for (let i = 0; i < value.length; i += 1) {
        if (i > 0) emit(',');
        const item = toJsonValue(value[i], String(i));
        if (isOmitted(item)) emit('null');
        else write(item);
      }
      emit(']');
      return;
    }
    emit('{');
    let first = true;
    for (const name of canonicalKeyOrder(value)) {
      const member = toJsonValue(value[name], name);
      if (isOmitted(member)) continue;
      emit(first ? '"' : ',"');
      first = false;
      emit(JSON.stringify(name).slice(1));
      emit(':');
      write(member);
    }
    emit('}');
  };

  const root = toJsonValue(data, '');
  write(isOmitted(root) ? null : root);
  if (buffer.length > 0) {
    hash.update(buffer, 'utf8');
    size += Buffer.byteLength(buffer, 'utf8');
  }
  return { etag: hash.digest('hex'), size }; // lgtm[js/insufficient-password-hash] -- entity tag over a document body, not a stored password
}
