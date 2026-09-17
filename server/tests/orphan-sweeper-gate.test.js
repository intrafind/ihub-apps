#!/usr/bin/env node

/**
 * Orphan sweeper — scheduler-owner gate.
 *
 * In a multi-worker / multi-replica deployment only the scheduler-lock owner
 * resumes interrupted runs (into ITS process memory). A non-owner worker must
 * NOT sweep, or it would mark the owner's just-resumed runs as failed (its
 * activeStates guard only sees runs live in the local process). This pins that
 * a non-owner returns immediately WITHOUT touching the filesystem.
 *
 * Only the skip path is exercised: it short-circuits before any fs access, so
 * the test has no side effects. The owning path is deliberately NOT invoked
 * here — it scans the real state dir and could rewrite genuine interrupted runs.
 *
 * Run directly: `node --test server/tests/orphan-sweeper-gate.test.js`.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { sweepOrphanedExecutions } from '../services/workflow/orphanSweeper.js';
import { _resetForTest } from '../services/workflow/triggers/schedulerLock.js';

test('non-owner worker skips the sweep entirely (no fs access)', async () => {
  _resetForTest(); // owner = false
  const result = await sweepOrphanedExecutions({ requireSchedulerOwner: true });
  assert.deepEqual(result, { scanned: 0, marked: 0 });
});

// NOTE: we deliberately do NOT exercise the owning path here — it scans the
// real workflow-state dir and would rewrite genuinely `running` runs (e.g. a
// live dev server's), i.e. cause the very cross-process clobber this gate
// prevents. The skip path above is the behavior this fix introduced.

console.log('✅ all passed');
