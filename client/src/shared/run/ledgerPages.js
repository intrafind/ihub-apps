/**
 * Paged fetch of a run's ledger projection (`GET /api/runs/:runId/events`).
 *
 * The endpoint pages by raw ledger sequence (`after`, `limit`, default 1000,
 * max 5000) and answers with the projected envelopes, `lastSeq` (the highest
 * sequence the server knows) and `nextAfter` (the last raw sequence the page
 * read). A projected page can be empty while more of the ledger remains —
 * request headers, budget events or compactions produce no envelopes — so the
 * walk advances on `nextAfter`, never on the envelopes, until it reaches
 * `lastSeq` or a page makes no progress.
 *
 * @module shared/run/ledgerPages
 */

export const LEDGER_PAGE_SIZE = 1000;
/** Upper bound on pages per re-sync (200 × 1000 ledger events). */
export const MAX_LEDGER_PAGES = 200;

/**
 * @param {(after: number, limit: number) => Promise<{events?: Array, lastSeq?: number, nextAfter?: number}>} fetchPage
 *   Fetch one page: envelopes projected from the ledger events with `seq > after`, at most
 *   `limit` ledger events; `nextAfter` is the last raw sequence read.
 * @param {Object} [opts]
 * @param {number} [opts.pageSize=LEDGER_PAGE_SIZE]
 * @param {number} [opts.maxPages=MAX_LEDGER_PAGES]
 * @returns {Promise<{events: Array, lastSeq: number|null, complete: boolean}>}
 */
export async function fetchAllLedgerEvents(
  fetchPage,
  { pageSize = LEDGER_PAGE_SIZE, maxPages = MAX_LEDGER_PAGES } = {}
) {
  const events = [];
  let after = 0;
  let lastSeq = null;
  for (let page = 0; page < maxPages; page++) {
    const body = await fetchPage(after, pageSize);
    const chunk = Array.isArray(body?.events) ? body.events : [];
    events.push(...chunk);
    if (Number.isInteger(body?.lastSeq)) lastSeq = body.lastSeq;
    // The cursor is the last raw sequence the server read; older servers
    // without `nextAfter` fall back to the highest envelope seq on the page.
    const cursor = Number.isInteger(body?.nextAfter)
      ? body.nextAfter
      : chunk.reduce((max, e) => (Number.isInteger(e?.seq) && e.seq > max ? e.seq : max), after);
    // No progress: the ledger has nothing more on disk.
    if (cursor <= after) return { events, lastSeq, complete: true };
    // Reached the highest sequence the server knows.
    if (lastSeq !== null && cursor >= lastSeq) return { events, lastSeq, complete: true };
    after = cursor;
  }
  return { events, lastSeq, complete: false };
}

export default fetchAllLedgerEvents;
