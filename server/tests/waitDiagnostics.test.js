// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

// node --test server/tests/waitDiagnostics.test.js
//
// The counters behind `diagnostics` in GET /api/admin/system/resources:
// bucket placement, percentiles (also of bucket differences, which is how the
// load-test report gets per-stage numbers), lock prefixes and the snapshot.

import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import {
  BUCKET_BOUNDS_MS,
  Histogram,
  getWaitDiagnostics,
  lockPrefix,
  lockStats,
  percentileFromBuckets,
  registerGauge,
  resetWaitDiagnosticsForTests,
  timeAsync
} from '../telemetry/waitDiagnostics.js';

beforeEach(() => resetWaitDiagnosticsForTests());

test('a sample lands in the first bucket whose bound holds it', () => {
  const h = new Histogram();
  h.record(0.3); // <= 1
  h.record(1); // <= 1 (bounds are inclusive)
  h.record(7); // <= 10
  h.record(99_999); // open bucket
  assert.equal(h.buckets[0], 2);
  assert.equal(h.buckets[BUCKET_BOUNDS_MS.indexOf(10)], 1);
  assert.equal(h.buckets[BUCKET_BOUNDS_MS.length], 1);
  assert.equal(h.count, 4);
  assert.equal(h.maxMs, 99_999);
});

test('percentiles are bucket upper bounds, capped at the max', () => {
  const h = new Histogram();
  for (let i = 0; i < 95; i++) h.record(3); // <= 5
  for (let i = 0; i < 5; i++) h.record(400); // <= 500
  const json = h.toJSON();
  assert.equal(json.p50, 5);
  assert.equal(json.p95, 5);
  assert.equal(percentileFromBuckets(json.buckets, 0.96), 500);
  // The max caps the bound: nothing took longer than 400 ms.
  assert.equal(percentileFromBuckets(json.buckets, 0.99, json.maxMs), 400);
  assert.equal(percentileFromBuckets(new Array(15).fill(0), 0.95), null);
});

test('percentiles of a bucket difference describe only the window', () => {
  const h = new Histogram();
  for (let i = 0; i < 100; i++) h.record(1);
  const before = h.toJSON().buckets;
  for (let i = 0; i < 10; i++) h.record(2000);
  const after = h.toJSON().buckets;
  const delta = after.map((n, i) => n - before[i]);
  assert.equal(percentileFromBuckets(delta, 0.5), 2500);
});

test('locks are reported by name prefix, or by component without one', () => {
  assert.equal(lockPrefix('chat:abc', 'FilesystemLockManager'), 'chat');
  assert.equal(lockPrefix('project-owner:u1', 'x'), 'project-owner');
  assert.equal(lockPrefix('users.json.lock', 'FileLock'), 'FileLock');
});

test('the snapshot carries every group, gauges and the thread-pool size', async () => {
  lockStats('chat').acquisitions += 1;
  await timeAsync('storage', 'documents.get:chats', async () => 'ok');
  await assert.rejects(
    timeAsync('storage', 'documents.put:chats', async () => {
      throw new Error('disk full');
    })
  );
  registerGauge('testGauge', () => 7);
  registerGauge('brokenGauge', () => {
    throw new Error('nope');
  });

  const snap = JSON.parse(JSON.stringify(getWaitDiagnostics()));
  assert.deepEqual(snap.bucketBoundsMs, [...BUCKET_BOUNDS_MS]);
  assert.ok(snap.uvThreadpoolSize >= 1);
  assert.equal(snap.locks.chat.acquisitions, 1);
  assert.equal(snap.locks.chat.wait.buckets.length, BUCKET_BOUNDS_MS.length + 1);
  assert.equal(snap.storage['documents.get:chats'].count, 1);
  assert.equal(snap.storage['documents.put:chats'].errors, 1);
  assert.equal(snap.gauges.testGauge, 7);
  assert.equal(snap.gauges.brokenGauge, null);
});
