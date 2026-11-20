// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * Blobs left on a blob store that is no longer the active one.
 *
 * When `storage.blobs.provider` moves the blobs to another backend, what the
 * previous backend holds is not served any more and nothing reads through to
 * it. This finds out whether there is anything there, so the start can say so
 * and name the command that copies it.
 *
 * @module storage/localBlobLeftovers
 */
import { BLOB_NAMESPACES } from './namespaces.js';

/** Keys counted per namespace before the count is reported as "at least". */
export const LEFTOVER_COUNT_CAP = 1000;

/**
 * Count the blobs a store holds in the declared blob namespaces.
 *
 * @param {import('./BlobStore.js').BlobStore} blobs - The store to look at.
 * @param {Object} [options]
 * @param {string[]} [options.namespaces] - Defaults to every `BLOB_NAMESPACES` value.
 * @param {number} [options.cap] - Stop counting a namespace here.
 * @returns {Promise<Array<{namespace: string, count: number, capped: boolean}>>}
 *   One entry per namespace that holds at least one blob; `capped` means
 *   there are at least `count`.
 *
 * @example
 * await findLocalBlobLeftovers(provider.blobs);
 * // [{ namespace: 'chat-files', count: 12, capped: false }]
 */
export async function findLocalBlobLeftovers(
  blobs,
  { namespaces = Object.values(BLOB_NAMESPACES), cap = LEFTOVER_COUNT_CAP } = {}
) {
  const found = [];
  for (const namespace of namespaces) {
    let count = 0;
    let capped = false;
    let cursor = null;
    do {
      const page = await blobs.list(namespace, {
        limit: Math.min(1000, cap - count + 1),
        ...(cursor ? { cursor } : {})
      });
      count += page.items.length;
      cursor = page.nextCursor || null;
      if (count > cap) {
        count = cap;
        capped = true;
        break;
      }
    } while (cursor);
    if (count > 0) found.push({ namespace, count, capped });
  }
  return found;
}
