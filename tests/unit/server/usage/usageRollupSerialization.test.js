// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * Rollup runs are serialized: the hourly run, the startup run and an admin's
 * `POST /api/admin/usage/_rollup` each read the event files and then replace
 * whole rollup files, so overlapping runs could leave an older snapshot in
 * place. In this process they queue; across workers and instances they hold
 * the storage lock `usage-rollups`.
 */
import { describe, it, expect, jest, beforeEach } from '@jest/globals';

/** What happened, in order: `start:<n>` / `end:<n>` per run, `lock:*` per lease. */
let mockTrace = [];
let mockRun = 0;
let mockFailNext = false;
let mockStorage = null;

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
    return [];
  },
  readDayEvents: async () => [],
  eventFileMtime: async () => null,
  getDailyDir: () => '/nonexistent/usage-daily',
  getMonthlyDir: () => '/nonexistent/usage-monthly',
  cleanupEvents: async () => 0
}));

import { runRollups } from '../../../../server/services/UsageAggregator.js';

/** A storage whose lock records its sections but excludes nothing itself. */
function storageWithLock(locking = 'advisory-single-machine') {
  const calls = [];
  return {
    calls,
    getCapabilities: () => ({ locking }),
    locks: {
      withLock: async (name, fn, options) => {
        calls.push({ name, options });
        mockTrace.push('lock:acquire');
        try {
          return await fn();
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
});

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

  it('keeps going after a run that failed', async () => {
    mockFailNext = true;
    const [first, second] = await Promise.allSettled([runRollups(), runRollups()]);
    expect(first.status).toBe('rejected');
    expect(first.reason.message).toBe('event directory unreadable');
    expect(second.status).toBe('fulfilled');
    expect(mockTrace).toEqual(['start:1', 'end:1', 'start:2', 'end:2']);
  });
});
