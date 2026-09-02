/**
 * Unit tests for client/src/shared/run/ledgerPages.js — paged ledger re-sync.
 */
import { fetchAllLedgerEvents } from '../../../client/src/shared/run/ledgerPages';

const ledger = n => Array.from({ length: n }, (_, i) => ({ v: 2, seq: i + 1, type: 'meta' }));

function serve(events, { lastSeq = events.length } = {}) {
  const calls = [];
  const fetchPage = async (after, limit) => {
    calls.push([after, limit]);
    return { events: events.filter(e => e.seq > after).slice(0, limit), lastSeq };
  };
  return { fetchPage, calls };
}

describe('fetchAllLedgerEvents', () => {
  test('walks every page until the ledger end and returns them as one projection', async () => {
    const { fetchPage, calls } = serve(ledger(2500));
    const { events, lastSeq, complete } = await fetchAllLedgerEvents(fetchPage, { pageSize: 1000 });
    expect(events).toHaveLength(2500);
    expect(events[2499].seq).toBe(2500);
    expect(lastSeq).toBe(2500);
    expect(complete).toBe(true);
    expect(calls).toEqual([
      [0, 1000],
      [1000, 1000],
      [2000, 1000]
    ]);
  });

  test('an empty ledger is one request', async () => {
    const { fetchPage, calls } = serve([], { lastSeq: 0 });
    const res = await fetchAllLedgerEvents(fetchPage);
    expect(res.events).toEqual([]);
    expect(calls).toHaveLength(1);
  });

  test('stops when a page brings nothing new even if the server reports a higher lastSeq', async () => {
    // a live run: the in-memory sequence is ahead of what is on disk
    const { fetchPage, calls } = serve(ledger(1200), { lastSeq: 1300 });
    const res = await fetchAllLedgerEvents(fetchPage, { pageSize: 1000 });
    expect(res.events).toHaveLength(1200);
    expect(res.complete).toBe(true);
    expect(calls).toEqual([
      [0, 1000],
      [1000, 1000],
      [1200, 1000]
    ]);
  });

  test('honours the page bound and reports an incomplete projection', async () => {
    const { fetchPage } = serve(ledger(5000));
    const res = await fetchAllLedgerEvents(fetchPage, { pageSize: 1000, maxPages: 2 });
    expect(res.events).toHaveLength(2000);
    expect(res.complete).toBe(false);
  });
});
