/**
 * Paging for retention sweeps that look at one bounded page per tick.
 *
 * A sweep that always asks for the first page never gets past it: when those
 * documents are still live, expired documents further on stay stored forever.
 * `SweepPages` remembers where the last page ended, per namespace, and starts
 * over at the first page once a pass reaches the end, so successive ticks walk
 * the whole namespace.
 *
 * @module storage/sweepPages
 */

export class SweepPages {
  constructor() {
    /** @type {Map<string, string>} namespace -> cursor of the next page */
    this.cursors = new Map();
  }

  /**
   * The next page of a namespace.
   *
   * @param {import('./DocumentStore.js').DocumentStore} documents
   * @param {string} ns
   * @param {number} limit
   * @returns {Promise<{items: Object[], nextCursor: string|null}>}
   */
  async next(documents, ns, limit) {
    const cursor = this.cursors.get(ns);
    let page;
    try {
      page = await documents.list(ns, { limit, ...(cursor ? { cursor } : {}) });
    } catch (error) {
      // A cursor the store no longer accepts starts the pass over.
      if (!cursor || error?.code !== 'INVALID_CURSOR') throw error;
      page = await documents.list(ns, { limit });
    }
    if (page?.nextCursor) this.cursors.set(ns, page.nextCursor);
    else this.cursors.delete(ns);
    return page || { items: [], nextCursor: null };
  }
}
