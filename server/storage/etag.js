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
import crypto from 'crypto';
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
