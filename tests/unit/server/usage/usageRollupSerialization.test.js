// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * Rollup runs are serialized: the hourly run, the startup run and an admin's
 * `POST /api/admin/usage/_rollup` each read the event files and then replace
 * whole rollup files, so overlapping runs could leave an older snapshot in
 * place. In this process they queue; across workers and instances they hold
 * the storage lock `usage-rollups`.
 */
import { describe, it, expect, jest, beforeEach, afterAll } from '@jest/globals';
import fs from 'node:fs';
import path from 'node:path';

/** What happened, in order: `start:<n>` / `end:<n>` per run, `lock:*` per lease. */
let mockTrace = [];
let mockRun = 0;
let mockFailNext = false;
let mockStorage = null;
/** Event days the next runs see, and where their rollups go. */
let mockDays = [];
const mockRollupDir = require('node:fs').mkdtempSync(
  require('node:path').join(require('node:os').tmpdir(), 'usage-rollup-serial-')
);

const tick = () => new Promise(resolve => setTimeout(resolve, 5));

jest.mock('../../../../server/utils/logger.js', () => ({
  __esModule: true,
  default: { error: () => {}, warn: () => {}, info: () => {}, debug: () => {} }
}));
jest.mock('../../../../server/feedbackStorage.js', () => ({
  cleanupFeedback: async () => ({ removed: 0 })
}));
jest.mock('../../../../server/storage/bootstrap.js', () => ({
  getStorage: () => mockStorage,
  readFacet: (provider, facet) => provider?.[facet] || null
}));
// A run is its flush and its listing of the event days; both take a moment,
// so two unserialized runs would interleave.
jest.mock('../../../../server/services/UsageEventLog.js', () => ({
  flushQueue: async () => {
    const n = ++mockRun;
    mockTrace.push(`start:${n}`);
    await tick();
    return 0;
  },
  listEventDays: async () => {
    await tick();
    mockTrace.push(`end:${mockRun}`);
    if (mockFailNext) {
      mockFailNext = false;
      throw new Error('event directory unreadable');
    }
    return mockDays;
  },
  readDayEvents: async () => [],
  eventFileMtime: async () => null,
  getDailyDir: () => require('node:path').join(mockRollupDir, 'daily'),
  getMonthlyDir: () => require('node:path').join(mockRollupDir, 'monthly'),
  cleanupEvents: async () => 0
}));

import { runRollups } from '../../../../server/services/UsageAggregator.js';

/**
 * A storage whose lock records its sections but excludes nothing itself.
 * `isCurrent` answers what the test sets on `lease.current`.
 */
function storageWithLock(locking = 'advisory-single-machine') {
  const calls = [];
  const lease = { name: 'usage-rollups', token: 1, current: true };
  lease.isCurrent = async () => lease.current;
  return {
    calls,
    lease,
    getCapabilities: () => ({ locking }),
    locks: {
      withLock: async (name, fn, options) => {
        calls.push({ name, options });
        mockTrace.push('lock:acquire');
        try {
          return await fn(lease);
        } finally {
          mockTrace.push('lock:release');
        }
      }
    }
  };
}

beforeEach(() => {
  mockTrace = [];
  mockRun = 0;
  mockFailNext = false;
  mockStorage = null;
  mockDays = [];
  fs.rmSync(mockRollupDir, { recursive: true, force: true });
});

afterAll(() => {
  fs.rmSync(mockRollupDir, { recursive: true, force: true });
});

const DAY = '2026-10-15';
const dailyFile = () => path.join(mockRollupDir, 'daily', `${DAY}.json`);
const monthlyFile = () => path.join(mockRollupDir, 'monthly', `${DAY.slice(0, 7)}.json`);
const NOW = Date.parse('2026-11-28T12:00:00Z');
const listed = dir => {
  try {
    return fs.readdirSync(path.join(mockRollupDir, dir));
  } catch {
    return [];
  }
};

describe('runRollups serialization', () => {
  it('runs overlapping calls one after another, in the order they came', async () => {
    const results = await Promise.all([runRollups(), runRollups(), runRollups()]);
    expect(mockTrace).toEqual(['start:1', 'end:1', 'start:2', 'end:2', 'start:3', 'end:3']);
    expect(results).toHaveLength(3);
    for (const stats of results) expect(stats).toMatchObject({ daysGenerated: 0 });
  });

  it('holds the storage lock usage-rollups for each run', async () => {
    mockStorage = storageWithLock();
    await Promise.all([runRollups(), runRollups()]);
    expect(mockTrace).toEqual([
      'lock:acquire',
      'start:1',
      'end:1',
      'lock:release',
      'lock:acquire',
      'start:2',
      'end:2',
      'lock:release'
    ]);
    expect(mockStorage.calls.map(call => call.name)).toEqual(['usage-rollups', 'usage-rollups']);
    // The lease outlives a full rebuild's wait, and is renewed while a run lasts.
    expect(mockStorage.calls[0].options).toMatchObject({ ttlMs: 60_000, waitMs: 600_000 });
  });

  it('does not take a lock that excludes nothing', async () => {
    mockStorage = storageWithLock('none');
    await Promise.all([runRollups(), runRollups()]);
    expect(mockStorage.calls).toHaveLength(0);
    expect(mockTrace).toEqual(['start:1', 'end:1', 'start:2', 'end:2']);
  });

  it('publishes daily and monthly rollups while it holds the lease', async () => {
    mockStorage = storageWithLock();
    mockDays = [DAY];
    const stats = await runRollups();
    expect(stats).toMatchObject({ daysGenerated: 1, monthsGenerated: 1 });
    expect(fs.existsSync(dailyFile())).toBe(true);
    expect(listed('monthly')).toEqual(['2026-10.json']);
  });

  it('stops without publishing once it has lost the lease to another run', async () => {
    mockStorage = storageWithLock();
    mockStorage.lease.current = false;
    mockDays = [DAY];
    await expect(runRollups()).rejects.toThrow(/lost its lease/);
    expect(listed('daily')).toEqual([]);
    expect(listed('monthly')).toEqual([]);
  });

  it('rebuilds a month the run before stopped short of, when it lost the lease after the day', async () => {
    mockStorage = storageWithLock();
    mockDays = [DAY];
    // Current for the daily write, lost for the monthly one.
    const answers = [true, false];
    mockStorage.lease.isCurrent = async () => answers.shift() ?? true;
    await expect(runRollups()).rejects.toThrow(/lost its lease/);
    expect(fs.existsSync(dailyFile())).toBe(true);
    expect(listed('monthly')).toEqual([]);

    // The day is fresh now and not rebuilt again; its month still is.
    const stats = await runRollups();
    expect(stats).toMatchObject({ daysGenerated: 0, monthsGenerated: 1 });
    expect(listed('monthly')).toEqual(['2026-10.json']);
  });

  it('leaves no temporary file behind when the lease cannot be read', async () => {
    mockStorage = storageWithLock();
    mockStorage.lease.isCurrent = async () => {
      throw new Error('fence file unreadable');
    };
    mockDays = [DAY];
    // Like any failed write of one day, it is logged and the run goes on.
    const stats = await runRollups();
    expect(stats).toMatchObject({ daysGenerated: 0 });
    expect(listed('daily')).toEqual([]);
  });

  it('rebuilds a month whose monthly rollup has the same time as a daily one', async () => {
    mockDays = [DAY];
    await runRollups();
    // A filesystem with whole-second timestamps cannot tell which came first.
    const at = new Date('2026-11-01T00:00:00Z');
    fs.utimesSync(dailyFile(), at, at);
    fs.utimesSync(monthlyFile(), at, at);
    const stats = await runRollups();
    expect(stats).toMatchObject({ daysGenerated: 0, monthsGenerated: 1 });
    // The rebuild leaves the monthly rollup newer, so the next run leaves it alone.
    expect(await runRollups()).toMatchObject({ monthsGenerated: 0 });
  });

  it('does not rebuild a month some of whose days daily retention removed', async () => {
    mockDays = [DAY];
    await runRollups();
    const monthlyBefore = fs.readFileSync(monthlyFile(), 'utf8');
    fs.utimesSync(
      monthlyFile(),
      new Date('2026-10-20T00:00:00Z'),
      new Date('2026-10-20T00:00:00Z')
    );
    // 40 days before NOW reaches into 2026-10: that month's earlier days are gone.
    const stats = await runRollups({ dailyRetentionDays: 40 }, { now: NOW });
    expect(stats).toMatchObject({ daysGenerated: 0, monthsGenerated: 0 });
    expect(fs.readFileSync(monthlyFile(), 'utf8')).toBe(monthlyBefore);
  });

  it('does not rebuild months that monthly retention removed', async () => {
    mockDays = [DAY];
    await runRollups({ monthlyRetentionDays: 1 });
    expect(listed('monthly')).toEqual([]);
    const stats = await runRollups({ monthlyRetentionDays: 1 });
    expect(stats).toMatchObject({ daysGenerated: 0, monthsGenerated: 0, monthlyDeleted: 0 });
  });

  it('keeps going after a run that failed', async () => {
    mockFailNext = true;
    const [first, second] = await Promise.allSettled([runRollups(), runRollups()]);
    expect(first.status).toBe('rejected');
    expect(first.reason.message).toBe('event directory unreadable');
    expect(second.status).toBe('fulfilled');
    expect(mockTrace).toEqual(['start:1', 'end:1', 'start:2', 'end:2']);
  });
});
