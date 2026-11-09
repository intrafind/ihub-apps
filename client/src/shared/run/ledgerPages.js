// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * Paged fetch of a run's ledger projection (`GET /api/runs/:runId/events`).
 *
 * The endpoint pages by `cursor` and `limit` (default 1000, max 5000) and answers
 * `{ items, nextCursor }`: the projected envelopes and the cursor after the last raw ledger
 * sequence the page read. A projected page can be empty while more of the ledger remains —
 * request headers, budget events or compactions produce no envelopes — so the walk advances on
 * `nextCursor`, never on the items, and ends when the server has none (a page that read
 * nothing) or sends the cursor it was given.
 *
 * @module shared/run/ledgerPages
 */

export const LEDGER_PAGE_SIZE = 1000;
/** Upper bound on pages per re-sync (200 × 1000 ledger events). */
export const MAX_LEDGER_PAGES = 200;

/**
 * @param {(cursor: string|null, limit: number) => Promise<{items?: Array, nextCursor?: string|null}>} fetchPage
 *   Fetch one page: envelopes projected from the ledger events after `cursor` (the start without
 *   one), at most `limit` ledger events.
 * @param {Object} [opts]
 * @param {number} [opts.pageSize=LEDGER_PAGE_SIZE]
 * @param {number} [opts.maxPages=MAX_LEDGER_PAGES]
 * @returns {Promise<{events: Array, complete: boolean}>}
 */
export async function fetchAllLedgerEvents(
  fetchPage,
  { pageSize = LEDGER_PAGE_SIZE, maxPages = MAX_LEDGER_PAGES } = {}
) {
  const events = [];
  let cursor = null;
  for (let page = 0; page < maxPages; page++) {
    const body = await fetchPage(cursor, pageSize);
    events.push(...(Array.isArray(body?.items) ? body.items : []));
    const next = body?.nextCursor || null;
    // Nothing more on disk, or no progress.
    if (!next || next === cursor) return { events, complete: true };
    cursor = next;
  }
  return { events, complete: false };
}

export default fetchAllLedgerEvents;
