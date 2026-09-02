/**
 * Paged fetch of a run's ledger projection (`GET /api/runs/:runId/events`).
 *
 * The endpoint pages by ledger sequence (`after`, `limit`, default 1000, max
 * 5000). A re-sync needs the whole run, so this walks the pages until the
 * last returned sequence reaches the ledger's `lastSeq` (or a page brings
 * nothing new) and hands back every envelope for one rebuild.
 *
 * @module shared/run/ledgerPages
 */

export const LEDGER_PAGE_SIZE = 1000;
/** Upper bound on pages per re-sync (200 × 1000 ledger events). */
export const MAX_LEDGER_PAGES = 200;

/**
 * @param {(after: number, limit: number) => Promise<{events?: Array, lastSeq?: number}>} fetchPage
 *   Fetch one page: events with ledger `seq > after`, at most `limit` ledger events.
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
    const maxSeq = chunk.reduce(
      (max, e) => (Number.isInteger(e?.seq) && e.seq > max ? e.seq : max),
      after
    );
    // Nothing new (empty page, or a page that did not advance the cursor):
    // the ledger has no more events on disk.
    if (chunk.length === 0 || maxSeq <= after) return { events, lastSeq, complete: true };
    // Reached the highest sequence the server knows.
    if (lastSeq !== null && maxSeq >= lastSeq) return { events, lastSeq, complete: true };
    after = maxSeq;
  }
  return { events, lastSeq, complete: false };
}

export default fetchAllLedgerEvents;
