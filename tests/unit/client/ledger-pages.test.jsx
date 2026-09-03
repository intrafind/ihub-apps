/**
 * Unit tests for client/src/shared/run/ledgerPages.js — paged ledger re-sync.
 */
import { fetchAllLedgerEvents } from '../../../client/src/shared/run/ledgerPages';

/** A raw ledger of n records; only records for which `projects(seq)` is true produce an envelope. */
function serve(n, { lastSeq = n, projects = () => true } = {}) {
  const calls = [];
  const fetchPage = async (after, limit) => {
    calls.push([after, limit]);
    const raw = [];
    for (let seq = after + 1; seq <= n && raw.length < limit; seq++) raw.push(seq);
    return {
      events: raw.filter(projects).map(seq => ({ v: 2, seq, type: 'meta' })),
      lastSeq,
      nextAfter: raw.length ? raw[raw.length - 1] : after
    };
  };
  return { fetchPage, calls };
}

describe('fetchAllLedgerEvents', () => {
  test('walks every page on the raw cursor until the ledger end', async () => {
    const { fetchPage, calls } = serve(2500);
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

  test('a page that projects to no envelopes still advances (headers, budget events, compactions)', async () => {
    // the first 1000 raw records produce nothing; later ones do
    const { fetchPage, calls } = serve(3000, { projects: seq => seq > 1000 && seq % 2 === 0 });
    const res = await fetchAllLedgerEvents(fetchPage, { pageSize: 1000 });
    expect(res.complete).toBe(true);
    expect(res.events).toHaveLength(1000);
    expect(res.events[0].seq).toBe(1002);
    expect(res.events[999].seq).toBe(3000);
    expect(calls).toEqual([
      [0, 1000],
      [1000, 1000],
      [2000, 1000]
    ]);
  });

  test('an empty ledger is one request', async () => {
    const { fetchPage, calls } = serve(0, { lastSeq: 0 });
    const res = await fetchAllLedgerEvents(fetchPage);
    expect(res.events).toEqual([]);
    expect(res.complete).toBe(true);
    expect(calls).toHaveLength(1);
  });

  test('stops when a page makes no progress even if the server reports a higher lastSeq', async () => {
    // a live run: the in-memory sequence is ahead of what is on disk
    const { fetchPage, calls } = serve(1200, { lastSeq: 1300 });
    const res = await fetchAllLedgerEvents(fetchPage, { pageSize: 1000 });
    expect(res.events).toHaveLength(1200);
    expect(res.complete).toBe(true);
    expect(calls).toEqual([
      [0, 1000],
      [1000, 1000],
      [1200, 1000]
    ]);
  });

  test('falls back to the highest envelope seq when the server sends no cursor', async () => {
    const calls = [];
    const fetchPage = async (after, limit) => {
      calls.push(after);
      const events = [];
      for (let seq = after + 1; seq <= Math.min(after + limit, 1500); seq++) {
        events.push({ v: 2, seq, type: 'meta' });
      }
      return { events, lastSeq: 1500 };
    };
    const res = await fetchAllLedgerEvents(fetchPage, { pageSize: 1000 });
    expect(res.events).toHaveLength(1500);
    expect(calls).toEqual([0, 1000]);
  });

  test('honours the page bound and reports an incomplete projection', async () => {
    const { fetchPage } = serve(5000);
    const res = await fetchAllLedgerEvents(fetchPage, { pageSize: 1000, maxPages: 2 });
    expect(res.events).toHaveLength(2000);
    expect(res.complete).toBe(false);
  });
});
