// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * Revisions of a stored configuration file, for optimistic locking of admin
 * saves (`ETag` on the read, optional `If-Match` on the write).
 *
 * Without it every admin save is last-write-wins: a page opened before another
 * admin's save writes its stale copy over that save. With it, a page that sends
 * back the `ETag` it loaded gets `412 PRECONDITION_FAILED` instead, and the file
 * is left as it is.
 *
 * Three rules keep the revision honest:
 * - It is computed from the STORED body (secrets encrypted, `${ENV}` placeholders
 *   unexpanded), never from the redacted read or the runtime cache: two different
 *   stored secrets must not share a revision, and the cache can lag behind
 *   another worker's write.
 * - The `If-Match` comparison runs inside the store's update lock, on the body
 *   the change is computed from ({@link assertIfMatch} is called from the
 *   `updateJson` / `updatePlatform` mutator), so no write can slip in between.
 * - The response to a successful write carries the new revision, so a client
 *   keeps saving from what it last wrote without reading again.
 *
 * The revision is SHA-256 (base64url) over canonical JSON (keys sorted) of the
 * parsed stored body. Whitespace-only edits of the file therefore keep it; any
 * change of a value changes it. A missing file and an empty object `{}` share
 * one revision.
 *
 * `If-Match` is optional: a write without it behaves as before.
 *
 * @module utils/configRevision
 */

import { createHash } from 'node:crypto';
import { ServiceError } from './ServiceError.js';

/**
 * JSON with object keys in sorted order, so equal bodies hash equally whatever
 * order their keys were written in.
 *
 * @param {unknown} value
 * @returns {string}
 */
function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value !== null && typeof value === 'object') {
    const keys = Object.keys(value)
      .filter(key => value[key] !== undefined)
      .sort();
    return `{${keys.map(key => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(',')}}`;
  }
  return JSON.stringify(value) ?? 'null';
}

/**
 * The revision of a stored configuration body.
 *
 * @param {unknown} stored - The parsed stored body; `null`/`undefined` for a missing file
 * @returns {string} base64url SHA-256, 43 characters
 */
export function revisionOf(stored) {
  const body = stored === null || stored === undefined ? {} : stored;
  return createHash('sha256').update(canonicalJson(body)).digest('base64url');
}

/**
 * Answer with the revision as a strong `ETag`, and keep the response out of
 * every cache: these reads describe secrets and must be fresh to be useful.
 *
 * @param {import('express').Response} res
 * @param {string} revision - From {@link revisionOf}
 */
export function setRevisionHeaders(res, revision) {
  res.set('ETag', `"${revision}"`);
  res.set('Cache-Control', 'no-store');
}

/**
 * The entity tags of an `If-Match` header.
 *
 * @param {string|undefined} header
 * @returns {null|'*'|string[]} `null` when absent, `'*'`, or the listed tags
 *   (quotes removed; weak tags keep their `W/` prefix and so never match)
 */
export function parseIfMatch(header) {
  if (header === undefined || header === null) return null;
  const text = String(header).trim();
  if (text === '') return null;
  if (text === '*') return '*';
  return text
    .split(',')
    .map(tag => tag.trim())
    .filter(Boolean)
    .map(tag => (tag.startsWith('"') && tag.endsWith('"') ? tag.slice(1, -1) : tag));
}

/**
 * Refuse a write whose `If-Match` does not name the stored revision.
 *
 * Call it inside the update lock with the body the write is computed from.
 * No header: nothing is checked (today's behaviour). `*`: the file must exist.
 * Comparison is strong, as RFC 9110 requires for `If-Match`.
 *
 * @param {import('express').Request} req
 * @param {unknown} stored - The stored body, as read under the lock (`null` when missing)
 * @param {string} resource - What the file is, for the error's `details.resource`
 * @throws {ServiceError} `PRECONDITION_FAILED` (412)
 */
export function assertIfMatch(req, stored, resource) {
  const expected = parseIfMatch(req.get('If-Match'));
  if (expected === null) return;
  const exists =
    stored !== null &&
    stored !== undefined &&
    !(typeof stored === 'object' && !Array.isArray(stored) && Object.keys(stored).length === 0);
  if (expected === '*' ? exists : expected.includes(revisionOf(stored))) return;
  throw new ServiceError(
    'PRECONDITION_FAILED',
    `The ${resource} configuration was changed after it was read. Nothing was saved. Reload it, apply your changes again and save.`,
    { details: { resource } }
  );
}
