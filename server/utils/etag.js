// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * ETags for variants of a cached list (the list a user may see, the apps a
 * disabled feature hides, ...).
 */

import { createHash } from 'node:crypto';

/**
 * The first eight hex digits of the MD5 of `value`. A short fingerprint for an
 * ETag, not a security hash.
 *
 * @param {string} value
 * @returns {string}
 */
export function shortHash(value) {
  return createHash('md5').update(value).digest('hex').substring(0, 8);
}

/**
 * An ETag for a variant of a cached list: `suffix` goes inside the quotes, so
 * `"abc"` becomes `"abc-suffix"` — still one valid entity tag.
 *
 * @param {string} etag - The list's ETag
 * @param {string} suffix - What tells the variant apart
 * @returns {string}
 */
export function etagWithSuffix(etag, suffix) {
  if (typeof etag === 'string' && etag.length > 1 && etag.endsWith('"')) {
    return `${etag.slice(0, -1)}-${suffix}"`;
  }
  return `${etag}-${suffix}`;
}

/**
 * The ETag of a subset of a list, told apart by the ids it holds. Sorting the
 * ids first makes it independent of the list's order.
 *
 * @param {string|null} baseEtag - The ETag of the whole list
 * @param {Array<string>} ids - The ids of the entries the subset holds
 * @param {string} [prefix=''] - Put before the hash, to tell kinds of subset apart
 * @returns {string}
 */
export function etagForIds(baseEtag, ids, prefix = '') {
  // Plain code-unit order, on purpose: `localeCompare` would make the ETag depend on the
  // server's locale, and workers of one cluster must agree on it.
  const sorted = [...ids].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  return etagWithSuffix(baseEtag, `${prefix}${shortHash(JSON.stringify(sorted))}`);
}

/**
 * Revision of the response bodies behind the ETags that routes set from a
 * config hash (see {@link responseEtag}). Bump it whenever such a route
 * changes the shape of what it answers while the config behind it stays the
 * same.
 */
export const RESPONSE_SHAPE_REVISION = 2;

/**
 * The ETag a route sends for a body built from cached config, when the ETag
 * comes from the config's hash rather than from the body itself.
 *
 * Such an ETag outlives a change to the body's shape: after an upgrade that
 * turned `GET /api/models` from a bare array into `{ items }`, the browser
 * still sent the old ETag, the server answered 304, and the browser served
 * the array it had cached — the client read `items` from it and showed "No
 * models available". The revision makes the ETag differ whenever the shape
 * does, so the first request after such an upgrade gets the new body.
 *
 * @param {string|null|undefined} etag - The config-derived ETag
 * @returns {string|null|undefined} The ETag to send; empty values pass through
 */
export function responseEtag(etag) {
  if (!etag) return etag;
  return etagWithSuffix(etag, `r${RESPONSE_SHAPE_REVISION}`);
}
