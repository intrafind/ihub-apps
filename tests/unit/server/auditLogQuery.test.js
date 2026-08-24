import { describe, it, expect, jest, beforeAll, afterAll } from '@jest/globals';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'fs';
import os from 'os';
import path from 'path';

// pathUtils resolves the app root via import.meta.url, which babel-jest's CJS
// transform cannot evaluate — and the tests need the audit log to live in a
// temp directory anyway. getRootDir() is only called while a query runs, so the
// factory can read a value assigned in beforeAll.
let mockAuditRoot;
jest.mock('../../../server/pathUtils.js', () => ({
  getRootDir: () => mockAuditRoot
}));

// The service only reads `audit` settings out of the platform config, and the
// real configCache pulls in the whole authorization stack (import.meta again).
jest.mock('../../../server/configCache.js', () => ({
  __esModule: true,
  default: { getPlatform: () => ({}) }
}));

import { queryAuditLog } from '../../../server/services/AuditLogService.js';

const auditDir = () => path.join(mockAuditRoot, 'contents', 'data', 'audit-log');

/** Entries are written across two days so the date-range filter is exercised too. */
const DAY_ONE = '2026-08-20';
const DAY_TWO = '2026-08-21';

function entry({ ts, actor, action, resource, result, source, summary, ip, requestId, admin }) {
  const record = {
    id: `id-${ts}`,
    ts,
    action,
    resource,
    resourceId: `${resource}-1`,
    summary: summary ?? '',
    result: result ?? 'success',
    source: source ?? 'admin',
    requestId: requestId ?? `req-${ts}`
  };
  // Entries written before the actor migration carry a plain `admin` string
  // instead of an `actor` object; both shapes must match an actor filter.
  if (admin !== undefined) record.admin = admin;
  else record.actor = { id: actor, username: actor, groups: [], authenticated: true };
  if (ip !== undefined) record.ip = ip;
  return record;
}

const DAY_ONE_ENTRIES = [
  entry({ ts: `${DAY_ONE}T09:00:00.000Z`, actor: 'alice', action: 'login', resource: 'auth' }),
  entry({ ts: `${DAY_ONE}T09:05:00.000Z`, actor: 'alice', action: 'logout', resource: 'auth' }),
  entry({
    ts: `${DAY_ONE}T10:00:00.000Z`,
    actor: 'alice',
    action: 'create',
    resource: 'app',
    summary: 'Created the chat app',
    ip: '10.1.2.0'
  }),
  entry({
    ts: `${DAY_ONE}T11:00:00.000Z`,
    actor: 'Doe, John',
    action: 'update',
    resource: 'app',
    summary: 'Renamed the app',
    requestId: 'req-abc-123'
  }),
  entry({
    ts: `${DAY_ONE}T12:00:00.000Z`,
    action: 'delete',
    resource: 'model',
    admin: 'legacy-admin',
    result: 'failure'
  })
];

const DAY_TWO_ENTRIES = [
  entry({ ts: `${DAY_TWO}T08:00:00.000Z`, actor: 'bob', action: 'login', resource: 'auth' }),
  entry({
    ts: `${DAY_TWO}T08:30:00.000Z`,
    actor: 'bob',
    action: 'login',
    resource: 'auth',
    result: 'failure'
  }),
  entry({
    ts: `${DAY_TWO}T09:00:00.000Z`,
    actor: 'bob',
    action: 'update',
    resource: 'user',
    source: 'web',
    summary: 'Disabled a user'
  })
];

// Every entry across both days, plus one line that is not valid JSON and one
// day outside the range the tests query.
const OUT_OF_RANGE = [
  entry({ ts: '2026-07-01T09:00:00.000Z', actor: 'carol', action: 'create', resource: 'source' })
];

function writeDay(date, entries, { malformed = false } = {}) {
  const lines = entries.map(e => JSON.stringify(e));
  if (malformed) lines.splice(1, 0, '{ not json');
  writeFileSync(path.join(auditDir(), `${date}.jsonl`), `${lines.join('\n')}\n`, 'utf8');
}

/** The default range for every test below: exactly the two seeded days. */
const range = { from: DAY_ONE, to: DAY_TWO };

const actorsOf = result => result.entries.map(e => e.actor?.username ?? e.admin);
const actionsOf = result => result.entries.map(e => e.action);

beforeAll(() => {
  mockAuditRoot = mkdtempSync(path.join(os.tmpdir(), 'ihub-audit-log-'));
  mkdirSync(auditDir(), { recursive: true });
  writeDay(DAY_ONE, DAY_ONE_ENTRIES, { malformed: true });
  writeDay(DAY_TWO, DAY_TWO_ENTRIES);
  writeDay('2026-07-01', OUT_OF_RANGE);
});

afterAll(() => {
  rmSync(mockAuditRoot, { recursive: true, force: true });
});

describe('queryAuditLog date range and parsing', () => {
  it('returns every entry in the range, newest first, skipping malformed lines', async () => {
    const result = await queryAuditLog({ ...range, limit: 100 });

    expect(result.total).toBe(DAY_ONE_ENTRIES.length + DAY_TWO_ENTRIES.length);
    expect(result.entries).toHaveLength(result.total);
    const timestamps = result.entries.map(e => e.ts);
    expect(timestamps).toEqual([...timestamps].sort().reverse());
  });

  it('ignores files outside the date range', async () => {
    const result = await queryAuditLog({ ...range, limit: 100 });
    expect(actorsOf(result)).not.toContain('carol');
  });

  it('paginates over the filtered set', async () => {
    const all = await queryAuditLog({ ...range, limit: 100 });
    const firstPage = await queryAuditLog({ ...range, limit: 3, offset: 0 });
    const secondPage = await queryAuditLog({ ...range, limit: 3, offset: 3 });

    expect(firstPage.total).toBe(all.total);
    expect(secondPage.total).toBe(all.total);
    expect(firstPage.entries.map(e => e.id)).toEqual(all.entries.slice(0, 3).map(e => e.id));
    expect(secondPage.entries.map(e => e.id)).toEqual(all.entries.slice(3, 6).map(e => e.id));
  });

  it('returns an empty result when the audit directory does not exist', async () => {
    const result = await queryAuditLog({ from: '1999-01-01', to: '1999-01-02', facets: true });
    expect(result).toEqual({ entries: [], total: 0, facets: expect.any(Object) });
  });
});

describe('queryAuditLog result window', () => {
  it('returns the same page whatever the window size, and an exact total', async () => {
    // The scan keeps only `offset + limit` entries, so a small page must not
    // change which rows come back or what `total` reports.
    const all = await queryAuditLog({ ...range, limit: 100 });
    for (const [limit, offset] of [
      [1, 0],
      [1, 5],
      [2, 3],
      [7, 1]
    ]) {
      const page = await queryAuditLog({ ...range, limit, offset });
      expect(page.total).toBe(all.total);
      expect(page.entries.map(e => e.id)).toEqual(
        all.entries.slice(offset, offset + limit).map(e => e.id)
      );
    }
  });

  it('counts the total past the end of the window', async () => {
    const page = await queryAuditLog({ ...range, limit: 1 });
    expect(page.entries).toHaveLength(1);
    expect(page.total).toBe(DAY_ONE_ENTRIES.length + DAY_TWO_ENTRIES.length);
  });

  it('still counts and facets correctly with a zero-size window', async () => {
    const result = await queryAuditLog({ ...range, limit: 0, facets: true });
    expect(result.entries).toEqual([]);
    expect(result.total).toBe(DAY_ONE_ENTRIES.length + DAY_TWO_ENTRIES.length);
    expect(result.facets.action.find(o => o.value === 'login').count).toBe(3);
  });

  it('reports a total beyond the window while filtering', async () => {
    const page = await queryAuditLog({ ...range, actionExclude: ['login', 'logout'], limit: 1 });
    expect(page.entries).toHaveLength(1);
    expect(page.total).toBe(4);
  });
});

describe('queryAuditLog single-value filters (backward compatibility)', () => {
  it('matches a single action', async () => {
    const result = await queryAuditLog({ ...range, action: 'login', limit: 100 });
    expect(result.total).toBe(3);
    expect(new Set(actionsOf(result))).toEqual(new Set(['login']));
  });

  it('matches a single resource', async () => {
    const result = await queryAuditLog({ ...range, resource: 'app', limit: 100 });
    expect(result.total).toBe(2);
  });

  it('matches a single actor', async () => {
    const result = await queryAuditLog({ ...range, actor: 'bob', limit: 100 });
    expect(result.total).toBe(3);
    expect(new Set(actorsOf(result))).toEqual(new Set(['bob']));
  });

  it('treats a missing result field as success', async () => {
    const success = await queryAuditLog({ ...range, result: 'success', limit: 100 });
    const failure = await queryAuditLog({ ...range, result: 'failure', limit: 100 });
    expect(failure.total).toBe(2);
    expect(success.total + failure.total).toBe(DAY_ONE_ENTRIES.length + DAY_TWO_ENTRIES.length);
  });

  it('matches legacy entries that carry `admin` instead of `actor`', async () => {
    const result = await queryAuditLog({ ...range, actor: 'legacy-admin', limit: 100 });
    expect(result.total).toBe(1);
    expect(result.entries[0].admin).toBe('legacy-admin');
  });

  it('returns nothing for a value no entry has', async () => {
    const result = await queryAuditLog({ ...range, resource: 'nonexistent', limit: 100 });
    expect(result.total).toBe(0);
  });
});

describe('queryAuditLog include sets', () => {
  it('matches any value in an array', async () => {
    const result = await queryAuditLog({ ...range, action: ['create', 'update'], limit: 100 });
    expect(result.total).toBe(3);
    expect(new Set(actionsOf(result))).toEqual(new Set(['create', 'update']));
  });

  it("treats '*' as every value, identical to omitting the parameter", async () => {
    const wildcard = await queryAuditLog({ ...range, action: '*', limit: 100 });
    const omitted = await queryAuditLog({ ...range, limit: 100 });
    expect(wildcard.total).toBe(omitted.total);
  });

  it("treats '*' inside an array as every value", async () => {
    const result = await queryAuditLog({ ...range, action: ['login', '*'], limit: 100 });
    expect(result.total).toBe(DAY_ONE_ENTRIES.length + DAY_TWO_ENTRIES.length);
  });

  it('treats an empty array as no filter', async () => {
    const result = await queryAuditLog({ ...range, action: [], limit: 100 });
    expect(result.total).toBe(DAY_ONE_ENTRIES.length + DAY_TWO_ENTRIES.length);
  });

  it('matches an actor whose name contains a comma as one value', async () => {
    const result = await queryAuditLog({ ...range, actor: ['Doe, John'], limit: 100 });
    expect(result.total).toBe(1);
    expect(result.entries[0].actor.username).toBe('Doe, John');
  });
});

describe('queryAuditLog exclude sets', () => {
  it('excludes the listed values and keeps everything else', async () => {
    const result = await queryAuditLog({
      ...range,
      actionExclude: ['login', 'logout'],
      limit: 100
    });
    expect(result.total).toBe(4);
    expect(actionsOf(result)).not.toContain('login');
    expect(actionsOf(result)).not.toContain('logout');
  });

  it("returns nothing for an exclude set of '*' — the select-none state", async () => {
    const result = await queryAuditLog({ ...range, actionExclude: '*', limit: 100 });
    expect(result.total).toBe(0);
    expect(result.entries).toEqual([]);
  });

  it('combines an explicit include-all with an exclusion', async () => {
    const combined = await queryAuditLog({
      ...range,
      action: '*',
      actionExclude: 'login',
      limit: 100
    });
    const excludeOnly = await queryAuditLog({ ...range, actionExclude: 'login', limit: 100 });
    expect(combined.total).toBe(excludeOnly.total);
    expect(actionsOf(combined)).not.toContain('login');
  });

  it('lets exclusion win over inclusion for a value in both sets', async () => {
    const result = await queryAuditLog({
      ...range,
      resource: 'app',
      resourceExclude: 'app',
      limit: 100
    });
    expect(result.total).toBe(0);
  });

  it('subtracts an exclusion from a narrower include set', async () => {
    const result = await queryAuditLog({
      ...range,
      action: ['create', 'update', 'delete'],
      actionExclude: 'delete',
      limit: 100
    });
    expect(new Set(actionsOf(result))).toEqual(new Set(['create', 'update']));
  });

  it('treats the exclusion of an unknown value as a no-op', async () => {
    const excluded = await queryAuditLog({ ...range, actionExclude: 'nonexistent', limit: 100 });
    const unfiltered = await queryAuditLog({ ...range, limit: 100 });
    expect(excluded.total).toBe(unfiltered.total);
  });

  it('excludes an actor whose name contains a comma as one value', async () => {
    const result = await queryAuditLog({ ...range, actorExclude: ['Doe, John'], limit: 100 });
    expect(actorsOf(result)).not.toContain('Doe, John');
    expect(result.total).toBe(DAY_ONE_ENTRIES.length + DAY_TWO_ENTRIES.length - 1);
  });

  it('applies exclusions on several fields at once', async () => {
    const result = await queryAuditLog({
      ...range,
      actionExclude: ['login', 'logout'],
      resourceExclude: 'model',
      limit: 100
    });
    expect(new Set(actionsOf(result))).toEqual(new Set(['create', 'update']));
    expect(result.total).toBe(3);
  });
});

describe('queryAuditLog free-text search', () => {
  it('matches the summary, case-insensitively', async () => {
    const result = await queryAuditLog({ ...range, q: 'CREATED THE CHAT', limit: 100 });
    expect(result.total).toBe(1);
    expect(result.entries[0].summary).toBe('Created the chat app');
  });

  it('matches the resource id', async () => {
    const result = await queryAuditLog({ ...range, q: 'user-1', limit: 100 });
    expect(result.total).toBe(1);
    expect(result.entries[0].resource).toBe('user');
  });

  it('matches the IP and the request id', async () => {
    await expect(queryAuditLog({ ...range, q: '10.1.2.0', limit: 100 })).resolves.toMatchObject({
      total: 1
    });
    await expect(queryAuditLog({ ...range, q: 'abc-123', limit: 100 })).resolves.toMatchObject({
      total: 1
    });
  });

  it('matches the actor name', async () => {
    const result = await queryAuditLog({ ...range, q: 'doe', limit: 100 });
    expect(result.total).toBe(1);
  });

  it('is ignored when blank', async () => {
    const blank = await queryAuditLog({ ...range, q: '   ', limit: 100 });
    const unfiltered = await queryAuditLog({ ...range, limit: 100 });
    expect(blank.total).toBe(unfiltered.total);
  });

  it('combines with the value filters', async () => {
    const result = await queryAuditLog({
      ...range,
      q: 'app',
      actionExclude: 'update',
      limit: 100
    });
    expect(actionsOf(result)).toEqual(['create']);
  });
});

describe('queryAuditLog facets', () => {
  const facetMap = (result, field) =>
    Object.fromEntries(result.facets[field].map(({ value, count }) => [value, count]));

  it('is omitted unless requested', async () => {
    const result = await queryAuditLog({ ...range, limit: 100 });
    expect(result.facets).toBeUndefined();
  });

  it('counts every value in the date range', async () => {
    const result = await queryAuditLog({ ...range, facets: true, limit: 100 });

    expect(facetMap(result, 'action')).toEqual({
      login: 3,
      logout: 1,
      create: 1,
      update: 2,
      delete: 1
    });
    expect(facetMap(result, 'result')).toEqual({ success: 6, failure: 2 });
    expect(facetMap(result, 'source')).toEqual({ admin: 7, web: 1 });
    expect(facetMap(result, 'actor')).toEqual({
      alice: 3,
      bob: 3,
      'Doe, John': 1,
      'legacy-admin': 1
    });
  });

  it('is not narrowed by the value filters, so an unticked option keeps its count', async () => {
    const filtered = await queryAuditLog({
      ...range,
      actionExclude: ['login', 'logout'],
      facets: true,
      limit: 100
    });

    expect(filtered.total).toBe(4);
    // `login` was filtered out of the entries but must stay tickable.
    expect(facetMap(filtered, 'action').login).toBe(3);
  });

  it('is not narrowed by the free-text search either', async () => {
    const searched = await queryAuditLog({ ...range, q: 'doe', facets: true, limit: 100 });
    const unfiltered = await queryAuditLog({ ...range, facets: true, limit: 100 });
    expect(searched.facets).toEqual(unfiltered.facets);
  });

  it('is narrowed by the date range', async () => {
    const dayTwoOnly = await queryAuditLog({
      from: DAY_TWO,
      to: DAY_TWO,
      facets: true,
      limit: 100
    });
    expect(facetMap(dayTwoOnly, 'actor')).toEqual({ bob: 3 });
  });

  it('sorts values by descending count, then by value', async () => {
    const result = await queryAuditLog({ ...range, facets: true, limit: 100 });
    const counts = result.facets.action.map(o => o.count);
    expect(counts).toEqual([...counts].sort((a, b) => b - a));
  });

  it('lists every facetable field even when the range is empty', async () => {
    const result = await queryAuditLog({
      from: '2026-01-01',
      to: '2026-01-02',
      facets: true,
      limit: 100
    });
    expect(Object.keys(result.facets).sort()).toEqual([
      'action',
      'actor',
      'resource',
      'result',
      'source'
    ]);
    expect(result.facets.action).toEqual([]);
  });
});
