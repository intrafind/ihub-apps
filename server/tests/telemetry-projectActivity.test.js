// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

// node --test server/tests/telemetry-projectActivity.test.js
//
// The project working set, the cluster union behind it and the ActivityTracker
// built on the same union (#3652). The cluster bus itself is exercised in
// clusterBus.test.js; here the other workers' answers are injected.

import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import projectActivityTracker, {
  PROJECT_WINDOWS_MINUTES,
  projectTextChars
} from '../telemetry/ProjectActivityTracker.js';
import activityTracker from '../telemetry/ActivityTracker.js';
import { mergeEntries } from '../telemetry/clusterUnion.js';
import {
  countIndexBuild,
  countIndexCacheEvictions,
  countIndexCacheHit,
  countIndexCacheMiss,
  getIndexCacheStats,
  resetIndexCacheStats
} from '../services/knowledge/indexCacheStats.js';
import { totalIndexCache } from '../services/systemResources.js';

const project = (id, chars) => ({
  id,
  items: [{ id: `${id}-1`, status: 'ready', text: { chars } }]
});

beforeEach(() => {
  projectActivityTracker.reset();
  activityTracker.shutdown();
  activityTracker.userTimestamps.clear();
  activityTracker.chatTimestamps.clear();
  resetIndexCacheStats();
});

test('projectTextChars counts only usable items with a recorded size', () => {
  assert.equal(
    projectTextChars({
      items: [
        { status: 'ready', text: { chars: 100 } },
        { status: 'stale', text: { chars: 50 } },
        { status: 'failed', text: { chars: 999 } },
        { status: 'ready' }
      ]
    }),
    150
  );
  assert.equal(projectTextChars(null), 0);
});

test('working set counts distinct projects per window', () => {
  const now = Date.now();
  projectActivityTracker.recordProjectUse(project('a', 1000));
  projectActivityTracker.recordProjectUse(project('a', 1000)); // same project, once
  projectActivityTracker.recordProjectUse(project('b', 500));
  projectActivityTracker.entries.set('old', { ts: now - 20 * 60_000, chars: 300 });

  const byMinutes = Object.fromEntries(
    projectActivityTracker.getWorkingSet({ now }).map(w => [w.minutes, w])
  );
  assert.deepEqual(PROJECT_WINDOWS_MINUTES, [5, 15, 60]);
  assert.deepEqual(byMinutes[5], { minutes: 5, projects: 2, chars: 1500 });
  assert.deepEqual(byMinutes[15], { minutes: 15, projects: 2, chars: 1500 });
  assert.deepEqual(byMinutes[60], { minutes: 60, projects: 3, chars: 1800 });
});

test('working set is the union across workers, not the sum', () => {
  const now = Date.now();
  projectActivityTracker.recordProjectUse(project('shared', 1000));
  projectActivityTracker.recordProjectUse(project('mine', 200));
  // Another worker used `shared` too, and one project of its own.
  projectActivityTracker.union.setRemoteEntries([
    ['shared', now - 1000, 1000],
    ['theirs', now - 2000, 700]
  ]);

  const five = projectActivityTracker.getWorkingSet({ now })[0];
  assert.equal(five.projects, 3);
  assert.equal(five.chars, 1900);

  // Local view ignores the other workers.
  assert.equal(projectActivityTracker.getWorkingSet({ cluster: false, now })[0].projects, 2);
});

test('mergeEntries keeps the newest entry per id and skips malformed ones', () => {
  const merged = mergeEntries(
    [
      ['a', 10, 'old'],
      ['b', 5, 'b']
    ],
    [['a', 20, 'new'], ['bad'], [1, 2, 3], null],
    'not a list'
  );
  assert.equal(merged.size, 2);
  assert.deepEqual(merged.get('a'), { ts: 20, value: 'new' });
});

test('ActivityTracker counts the union of users and chats across workers', () => {
  activityTracker.configure({ enabled: false, windowMinutes: 5 });
  const now = Date.now();
  activityTracker.recordActivity({ userId: 'alice', chatId: 'c1' });
  activityTracker.userUnion.setRemoteEntries([
    ['alice', now, undefined], // seen on both workers
    ['bob', now, undefined],
    ['stale', now - 10 * 60_000, undefined] // outside the window
  ]);
  activityTracker.chatUnion.setRemoteEntries([['c2', now, undefined]]);

  assert.equal(activityTracker.getActiveUsers(), 2);
  assert.equal(activityTracker.getActiveChats(), 2);
});

test('index cache stats: hit rate, evictions and build time', () => {
  assert.equal(getIndexCacheStats().hitRate, null);
  countIndexCacheMiss();
  countIndexBuild(0.5);
  countIndexCacheHit();
  countIndexCacheHit();
  countIndexCacheHit();
  countIndexCacheEvictions(2);
  countIndexCacheEvictions(0);

  const stats = getIndexCacheStats();
  assert.equal(stats.hits, 3);
  assert.equal(stats.misses, 1);
  assert.equal(stats.hitRate, 0.75);
  assert.equal(stats.evictions, 2);
  assert.equal(stats.builds, 1);
  assert.equal(stats.buildSecondsAvg, 0.5);
});

test('totalIndexCache adds the processes up', () => {
  const total = totalIndexCache([
    { indexCache: { entries: 2, chars: 100, hits: 6, misses: 2, evictions: 1, builds: 2 } },
    { indexCache: { entries: 3, chars: 50, hits: 0, misses: 2, evictions: 0, builds: 2 } },
    {} // the primary reports no cache
  ]);
  assert.equal(total.entries, 5);
  assert.equal(total.chars, 150);
  assert.equal(total.hits, 6);
  assert.equal(total.misses, 4);
  assert.equal(total.hitRate, 0.6);
});
