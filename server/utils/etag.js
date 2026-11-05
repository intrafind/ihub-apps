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
  const sorted = [...ids].sort();
  return etagWithSuffix(baseEtag, `${prefix}${shortHash(JSON.stringify(sorted))}`);
}
