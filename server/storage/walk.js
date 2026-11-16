// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * One walk over a namespace, whatever the store behind it can do.
 *
 * Repositories that need a whole namespace (or a whole owner, or a whole key
 * prefix) used to page `list` with a cursor. On the filesystem provider every
 * page re-reads and re-sorts the directory, so a walk of N entries cost O(N)
 * per page. `scan` is the single-pass walk; this module is the one place that
 * picks it, and falls back to paging `list` for a store that has no `scan` —
 * the hand-written test doubles, a provider that has not implemented it.
 *
 * @module storage/walk
 */

/** Page size of the fallback walk: the largest page `list` hands out. */
const PAGE_SIZE = 1000;

/**
 * Every document (or blob entry) of a namespace, in ascending key order.
 *
 * Stop early by breaking out of the loop: with `scan`, the work stops too.
 *
 * @param {Object} store - A {@link module:storage/DocumentStore~DocumentStore},
 *   a {@link module:storage/BlobStore~BlobStore}, or any object with a
 *   cursor-paged `list(ns, opts)`.
 * @param {string} ns - Namespace.
 * @param {Object} [opts] - Passed to `scan` / `list`: `prefix`, and for
 *   documents `ownerId` and `includeData`.
 * @param {number} [opts.limit=1000] - Page size of the fallback walk only, for
 *   a caller that must not hold a thousand large documents at once.
 * @yields {Object} What the store's listing yields, one entry at a time.
 *
 * @example
 * for await (const doc of walkDocuments(documents, 'chat-files', { prefix: 'chat__abc__' })) {
 *   total += doc.data.bytes;
 * }
 */
export async function* walkDocuments(store, ns, opts = {}) {
  const { limit = PAGE_SIZE, ...filter } = opts || {};
  if (store.supportsScan) {
    yield* store.scan(ns, filter);
    return;
  }
  let cursor = null;
  do {
    const page = await store.list(ns, {
      ...filter,
      limit,
      ...(cursor ? { cursor } : {})
    });
    yield* page.items || [];
    cursor = page.nextCursor || null;
  } while (cursor);
}

/**
 * The same walk over a blob namespace (`{ key, bytes }` entries). An alias, so
 * a call site says which facet it walks.
 */
export const walkBlobs = walkDocuments;
