/**
 * Unit tests for client/src/shared/run/ledgerPages.js — paged ledger re-sync.
 */
import { fetchAllLedgerEvents } from '../../../client/src/shared/run/ledgerPages';

/**
 * A raw ledger of n records; only records for which `projects(seq)` is true produce an envelope.
 * The cursor stands for the last raw sequence a page read, and a page that read nothing has none,
 * as the route answers it.
 */
function serve(n, { projects = () => true } = {}) {
  const calls = [];
  const fetchPage = async (cursor, limit) => {
    calls.push([cursor, limit]);
    const after = cursor ? Number(cursor.slice(1)) : 0;
    const raw = [];
    for (let seq = after + 1; seq <= n && raw.length < limit; seq++) raw.push(seq);
    return {
      items: raw.filter(projects).map(seq => ({ v: 2, seq, type: 'meta' })),
      nextCursor: raw.length ? `c${raw[raw.length - 1]}` : null
    };
  };
  return { fetchPage, calls };
}

describe('fetchAllLedgerEvents', () => {
  test('walks every page on the cursor until a page reads nothing', async () => {
    const { fetchPage, calls } = serve(2500);
    const { events, complete } = await fetchAllLedgerEvents(fetchPage, { pageSize: 1000 });

    expect(events).toHaveLength(2500);
    expect(events[2499].seq).toBe(2500);
    expect(complete).toBe(true);
    // Three pages with records, then the empty one that tells the walk it is over.
    expect(calls).toEqual([
      [null, 1000],
      ['c1000', 1000],
      ['c2000', 1000],
      ['c2500', 1000]
    ]);
  });

  test('a page that projects to no envelopes still advances (headers, budget events, compactions)', async () => {
    // the first 1000 raw records produce nothing; later ones do
    const { fetchPage } = serve(3000, { projects: seq => seq > 1000 && seq % 2 === 0 });
    const res = await fetchAllLedgerEvents(fetchPage, { pageSize: 1000 });
    expect(res.complete).toBe(true);
    expect(res.events).toHaveLength(1000);
    expect(res.events[0].seq).toBe(1002);
    expect(res.events[999].seq).toBe(3000);
  });

  test('an empty ledger is one request', async () => {
    const { fetchPage, calls } = serve(0);
    const res = await fetchAllLedgerEvents(fetchPage);
    expect(res.events).toEqual([]);
    expect(res.complete).toBe(true);
    expect(calls).toHaveLength(1);
  });

  test('stops when the server sends the cursor it was given', async () => {
    const calls = [];
    const fetchPage = async cursor => {
      calls.push(cursor);
      return { items: [{ v: 2, seq: 1, type: 'meta' }], nextCursor: 'stuck' };
    };
    const res = await fetchAllLedgerEvents(fetchPage, { pageSize: 10 });
    expect(res.complete).toBe(true);
    expect(calls).toEqual([null, 'stuck']);
  });

  test('honours the page bound and reports an incomplete projection', async () => {
    const { fetchPage } = serve(5000);
    const res = await fetchAllLedgerEvents(fetchPage, { pageSize: 1000, maxPages: 2 });
    expect(res.events).toHaveLength(2000);
    expect(res.complete).toBe(false);
  });
});
