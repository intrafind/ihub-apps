// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

// node --test "tests/load/**/*.test.mjs"
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { rateLimitAnalysis, isStubRun } from './report.mjs';

/** One stage, users sending 40 publicApi requests per minute (p99), 4 workers. */
function run(publicApi) {
  const result = {
    meta: {
      config: { rateLimitUsersPerIp: 100 },
      serverLimits: { rateLimits: { publicApi } }
    },
    metrics: { trends: { 'rl.publicApi.perUserMin': { 0: [10, 20, 40] } }, counts: {} }
  };
  const a = { sizing: { workers: 4 }, stats: [{ index: 0, vus: 100 }], capacity: null };
  return rateLimitAnalysis(result, a).rows[0];
}

test('per-IP limiter (no keyBy): budget is limit × workers for all users behind one IP', () => {
  const row = run({ limit: 500, windowMs: 60_000 });
  assert.equal(row.perUserKey, false);
  assert.equal(row.fit, 50); // 500 × 4 / 40
  assert.equal(row.recommended, 2000); // 40 × 100 users × 2 / 4 workers
});

test('per-user limiter (keyBy user): one user against the limit, no worker multiplier', () => {
  const row = run({ limit: 300, windowMs: 60_000, keyBy: 'user', anonymousLimit: 500 });
  assert.equal(row.perUserKey, true);
  assert.equal(row.fit, null);
  assert.equal(row.recommended, 80); // 40 × 2
});

test('keyBy ip keeps the per-IP evaluation', () => {
  assert.equal(run({ limit: 500, windowMs: 60_000, keyBy: 'ip' }).perUserKey, false);
});

test('stub runs are recognised, GPU runs are not', () => {
  const setup = { stub: { id: 'loadtest-stub' } };
  assert.equal(isStubRun({ modelId: 'loadtest-stub', setup }), true);
  assert.equal(isStubRun({ modelId: 'loadtest-gpu', setup }), false);
  assert.equal(isStubRun({ modelId: null, setup }), false);
});
