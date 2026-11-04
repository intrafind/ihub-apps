// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

import { describe, it, expect, jest, beforeEach, afterEach } from '@jest/globals';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

let mockRoot;
jest.mock('../../../../server/utils/contentsPath.js', () => ({
  getContentsPath: (...segments) => require('node:path').join(mockRoot, ...segments)
}));
jest.mock('../../../../server/utils/logger.js', () => ({
  __esModule: true,
  default: { error: () => {}, warn: () => {}, info: () => {}, debug: () => {} }
}));
jest.mock('../../../../server/feedbackStorage.js', () => ({
  cleanupFeedback: async () => ({ removed: 0 })
}));

import {
  appendUsageRecord,
  flushQueue,
  listEventDays,
  readDayEvents,
  cleanupEvents,
  eventFileFor
} from '../../../../server/services/UsageEventLog.js';
import {
  generateDailyRollups,
  readDailyRollup,
  readMonthlyRollup,
  runRollups,
  dailyRollupFile
} from '../../../../server/services/UsageAggregator.js';
import {
  resolveRange,
  computeWindow,
  getUsageSummary,
  getUsageBreakdown,
  getUsageReliability,
  getFeedbackSummary,
  clearUsageQueryCache,
  UsageQueryError
} from '../../../../server/services/usage/usageQuery.js';

const NOW = Date.parse('2026-11-04T12:30:00.000Z');

const call = (ts, over = {}) => ({
  v: 2,
  type: 'llm_call',
  ts,
  surf: 'chat',
  uid: 'alice',
  app: 'chat',
  model: 'gpt',
  prov: 'openai',
  st: 'ok',
  pt: 100,
  ct: 10,
  src: 'provider',
  lat: 800,
  tc: 0,
  ...over
});

function writeDay(date, records) {
  fs.mkdirSync(path.dirname(eventFileFor(date)), { recursive: true });
  fs.writeFileSync(eventFileFor(date), records.map(r => JSON.stringify(r)).join('\n') + '\n');
}

function age(file, ms) {
  const t = new Date(ms);
  fs.utimesSync(file, t, t);
}

beforeEach(() => {
  mockRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'usage-storage-'));
  clearUsageQueryCache();
});
afterEach(() => fs.rmSync(mockRoot, { recursive: true, force: true }));

describe('daily event files', () => {
  it('appends each record to the file of its UTC day', async () => {
    appendUsageRecord(call('2026-11-03T23:59:59.000Z'));
    appendUsageRecord(call('2026-11-04T00:00:01.000Z'));
    await flushQueue();
    expect(await listEventDays()).toEqual(['2026-11-03', '2026-11-04']);
    expect(await readDayEvents('2026-11-04')).toHaveLength(1);
  });

  it('skips torn lines and records of another schema', async () => {
    fs.mkdirSync(path.dirname(eventFileFor('2026-11-04')), { recursive: true });
    fs.writeFileSync(
      eventFileFor('2026-11-04'),
      `${JSON.stringify(call('2026-11-04T01:00:00.000Z'))}\n{"type":"chat_request","ts":"x"}\n{"v":2,"ty`
    );
    expect(await readDayEvents('2026-11-04')).toHaveLength(1);
  });

  it('retention deletes whole day files older than eventRetentionDays', async () => {
    writeDay('2026-07-01', [call('2026-07-01T10:00:00.000Z')]);
    writeDay('2026-11-01', [call('2026-11-01T10:00:00.000Z')]);
    expect(await cleanupEvents(90, NOW)).toBe(1);
    expect(await listEventDays()).toEqual(['2026-11-01']);
    expect(await cleanupEvents(-1, NOW)).toBe(0);
  });
});

describe('incremental rollups', () => {
  it('rebuilds today, yesterday, missing and changed days only', async () => {
    writeDay('2026-10-01', [call('2026-10-01T10:00:00.000Z')]);
    writeDay('2026-11-03', [call('2026-11-03T10:00:00.000Z')]);
    writeDay('2026-11-04', [call('2026-11-04T10:00:00.000Z')]);

    const first = await generateDailyRollups({ now: NOW });
    expect(first.days).toEqual(['2026-10-01', '2026-11-03', '2026-11-04']);

    // History whose rollup is newer than its events is not read again.
    age(eventFileFor('2026-10-01'), NOW - 1000 * 60 * 60 * 24 * 30);
    const second = await generateDailyRollups({ now: NOW });
    expect(second.days).toEqual(['2026-11-03', '2026-11-04']);

    // A late write to an old day makes it dirty.
    fs.appendFileSync(
      eventFileFor('2026-10-01'),
      JSON.stringify(call('2026-10-01T11:00:00.000Z')) + '\n'
    );
    age(dailyRollupFile('2026-10-01'), NOW - 1000 * 60 * 60 * 24 * 31);
    const third = await generateDailyRollups({ now: NOW });
    expect(third.days).toContain('2026-10-01');
    expect((await readDailyRollup('2026-10-01')).totals.requests).toBe(2);
  });

  it('writes monthly rollups of the months it touched', async () => {
    writeDay('2026-11-03', [call('2026-11-03T10:00:00.000Z')]);
    writeDay('2026-11-04', [call('2026-11-04T10:00:00.000Z')]);
    const stats = await runRollups({ eventRetentionDays: 90 }, { now: NOW });
    expect(stats).toMatchObject({ daysGenerated: 2, monthsGenerated: 1 });
    const month = await readMonthlyRollup('2026-11');
    expect(month).toMatchObject({ month: '2026-11', days: 2 });
    expect(month.totals.requests).toBe(2);
  });
});

describe('ranges', () => {
  it('resolves the named ranges and their previous periods', () => {
    const today = resolveRange({ range: 'today' }, NOW);
    expect(today.granularity).toBe('hour');
    expect(new Date(today.from).toISOString()).toBe('2026-11-04T00:00:00.000Z');
    expect(today.previous.from).toBe(today.from - 86400000);

    const week = resolveRange({ range: '7d' }, NOW);
    expect(week.granularity).toBe('day');
    expect(new Date(week.from).toISOString()).toBe('2026-10-29T00:00:00.000Z');
    expect(new Date(week.previous.from).toISOString()).toBe('2026-10-22T00:00:00.000Z');

    const custom = resolveRange({ range: 'custom', from: '2026-10-01', to: '2026-10-31' }, NOW);
    expect(new Date(custom.to).toISOString()).toBe('2026-10-31T23:59:59.999Z');

    expect(() => resolveRange({ range: 'forever' }, NOW)).toThrow(UsageQueryError);
    expect(() => resolveRange({ range: 'custom', from: '2026-10-31', to: '2026-10-01' })).toThrow(
      UsageQueryError
    );
  });

  it('serves today live, without waiting for a rollup', async () => {
    writeDay('2026-11-04', [
      call('2026-11-04T09:10:00.000Z'),
      call('2026-11-04T11:10:00.000Z', { uid: 'bob' })
    ]);
    const { rollup, series } = await computeWindow(resolveRange({ range: 'today' }, NOW));
    expect(rollup.totals.requests).toBe(2);
    expect(series).toHaveLength(13);
    expect(series[9]).toMatchObject({ t: '2026-11-04T09:00:00.000Z', requests: 1 });
  });

  it('uses a stored rollup only while it is current', async () => {
    writeDay('2026-11-01', [call('2026-11-01T10:00:00.000Z')]);
    await generateDailyRollups({ now: NOW, all: true });
    fs.appendFileSync(
      eventFileFor('2026-11-01'),
      JSON.stringify(call('2026-11-01T11:00:00.000Z')) + '\n'
    );
    age(dailyRollupFile('2026-11-01'), NOW - 1000 * 60 * 60 * 48);
    const { rollup } = await computeWindow(resolveRange({ range: '7d' }, NOW));
    expect(rollup.totals.requests).toBe(2);
  });
});

describe('queries', () => {
  beforeEach(() => {
    writeDay('2026-10-25', [call('2026-10-25T10:00:00.000Z', { pt: 10, ct: 0 })]);
    writeDay('2026-11-03', [
      call('2026-11-03T10:00:00.000Z', {
        uid: 'bob',
        grp: ['it'],
        app: 'translate',
        model: 'claude',
        pt: 50
      }),
      call('2026-11-03T10:05:00.000Z', { st: 'error', err: 'TIMEOUT', pt: 0, ct: 0 })
    ]);
    writeDay('2026-11-04', [
      call('2026-11-04T10:00:00.000Z', { grp: ['sales'] }),
      {
        v: 2,
        type: 'feedback',
        ts: '2026-11-04T10:01:00.000Z',
        uid: 'alice',
        app: 'chat',
        model: 'gpt',
        rating: 4
      }
    ]);
  });

  it('summarizes the range against the previous period', async () => {
    const summary = await getUsageSummary({ range: '7d' }, NOW);
    expect(summary.totals).toMatchObject({
      requests: 3,
      activeUsers: 2,
      errors: 1,
      feedbackCount: 1
    });
    expect(summary.previous.requests).toBe(1);
    expect(summary.series).toHaveLength(7);
    expect(summary.topModels.map(r => r.key)).toEqual(['gpt', 'claude']);
  });

  it('breaks down by any dimension with per-model sub-rows and sorting', async () => {
    const users = await getUsageBreakdown(
      { range: '7d', dimension: 'user', sort: 'key', order: 'asc' },
      NOW
    );
    expect(users.rows.map(r => r.key)).toEqual(['alice', 'bob']);
    expect(users.rows[0].models[0]).toMatchObject({ key: 'gpt', requests: 2 });
    const groups = await getUsageBreakdown({ range: '7d', dimension: 'group' }, NOW);
    expect(groups.rows.map(r => r.key).sort()).toEqual(['it', 'sales']);
    await expect(getUsageBreakdown({ range: '7d', dimension: 'secret' }, NOW)).rejects.toThrow(
      UsageQueryError
    );
  });

  it('reports errors by code and provider', async () => {
    const rel = await getUsageReliability({ range: '7d' }, NOW);
    expect(rel.byError).toEqual([{ code: 'TIMEOUT', count: 1, byProvider: { openai: 1 } }]);
    expect(rel.byProvider[0]).toMatchObject({ key: 'openai', requests: 3, errors: 1 });
  });

  it('summarizes feedback', async () => {
    const fb = await getFeedbackSummary({ range: '7d' }, NOW);
    expect(fb).toMatchObject({ total: 1, averageRating: 4 });
    expect(fb.perApp.chat.total).toBe(1);
  });
});
