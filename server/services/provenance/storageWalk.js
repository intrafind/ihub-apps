/**
 * Walk a whole document namespace: the single-pass `scan` where the store
 * implements it, else the paged `list` (see DocumentStore#supportsScan).
 *
 * @module services/provenance/storageWalk
 */

const PAGE_SIZE = 500;

/**
 * @param {import('../../storage/DocumentStore.js').DocumentStore} documents
 * @param {string} ns
 * @returns {AsyncGenerator<Object>} documents with `data`
 */
export async function* walkNamespace(documents, ns) {
  if (documents.supportsScan) {
    yield* documents.scan(ns, { includeData: true });
    return;
  }
  let cursor = null;
  do {
    const page = await documents.list(ns, {
      limit: PAGE_SIZE,
      includeData: true,
      ...(cursor ? { cursor } : {})
    });
    yield* page.items || [];
    cursor = page.nextCursor || null;
  } while (cursor);
}
