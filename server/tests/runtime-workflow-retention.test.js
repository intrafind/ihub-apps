/**
 * Workflow state retention — the daily sweep this issue adds, driven against
 * a real filesystem storage provider.
 *
 * This is the one place in the consolidation where behaviour changes on
 * purpose: nothing deleted terminal workflow state on a timer before, and
 * `wf-child-*` sub-workflow states were never deleted at all. So the cases
 * below pin down exactly what goes and what stays — a `paused` execution is
 * waiting for a person and must survive any age, and a sweep configured with
 * a non-positive `retentionDays` must do nothing at all rather than treat
 * "keep for zero days" as "delete everything".
 *
 * The clock is injected rather than the files backdated, except in the
 * scheduler case, which has no clock seam and uses a legacy checkpoint whose
 * mtime says it is old.
 *
 * Contract: `RUNTIME_STORES_CONTRACT.md` §5 (new retention) and §7.
 */
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, it, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { FilesystemStorageProvider } from '../storage/providers/filesystem/index.js';
import {
  WorkflowStateRepository,
  WORKFLOW_STATE_NAMESPACE,
  LEGACY_STATE_FILE
} from '../services/workflow/WorkflowStateRepository.js';
import { WorkflowStatus } from '../services/workflow/StateManager.js';
import { RunSummaryRepository } from '../services/runtime/RunSummaryRepository.js';
import {
  sweepWorkflowStates,
  startWorkflowStateRetention,
  stopWorkflowStateRetention,
  workflowRetentionSettings,
  DEFAULT_RETENTION_DAYS
} from '../services/workflow/workflowRetention.js';

/** One day in milliseconds — the unit retention is configured in. */
const DAY_MS = 24 * 60 * 60 * 1000;

const OWNER = 'user-1';

/**
 * A logger that records instead of printing.
 *
 * @returns {{lines: Array<Object>, logger: Object}}
 */
function recordingLogger() {
  const lines = [];
  const at = level => (message, meta) => lines.push({ level, message, meta });
  return {
    lines,
    logger: { debug: at('debug'), info: at('info'), warn: at('warn'), error: at('error') }
  };
}

/**
 * A workflow execution state.
 *
 * @param {string} executionId - Execution identifier.
 * @param {string} status - Execution status.
 * @param {Object} [overrides] - Fields to change.
 * @returns {Object} The state.
 */
function state(executionId, status, overrides = {}) {
  const now = new Date().toISOString();
  return {
    executionId,
    workflowId: 'wf-1',
    status,
    currentNodes: [],
    completedNodes: [],
    failedNodes: [],
    data: { _workflow: { startedBy: OWNER } },
    history: [],
    checkpoints: [],
    errors: [],
    createdAt: now,
    updatedAt: now,
    startedAt: now,
    completedAt: status === WorkflowStatus.RUNNING ? null : now,
    ...overrides
  };
}

/**
 * Bring up a provider, a state repository and a run summary repository over
 * one scratch directory — the three the sweep needs.
 *
 * @param {(ctx: Object) => Promise<void>} fn - The test body.
 * @returns {Promise<void>}
 */
async function withStores(fn) {
  const baseDir = await fs.mkdtemp(path.join(os.tmpdir(), 'ihub-wf-retention-'));
  const provider = new FilesystemStorageProvider({ baseDir, flushIntervalMs: 25 });
  await provider.initialize();
  const stateDir = path.join(baseDir, WORKFLOW_STATE_NAMESPACE);
  await fs.mkdir(stateDir, { recursive: true });
  const { logger } = recordingLogger();
  const repository = new WorkflowStateRepository({
    documents: provider.documents,
    locks: provider.locks,
    stateDir,
    logger
  });
  const runSummaries = new RunSummaryRepository({
    documents: provider.documents,
    locks: provider.locks,
    logger
  });
  try {
    await fn({ baseDir, stateDir, provider, repository, runSummaries });
  } finally {
    await provider.shutdown();
    await fs.rm(baseDir, { recursive: true, force: true });
  }
}

/**
 * Write a state in the legacy `<executionId>/latest.json` layout.
 *
 * @param {string} stateDir - The state directory.
 * @param {string} executionId - Execution identifier.
 * @param {Object} body - State to write.
 * @returns {Promise<string>} The file written.
 */
async function writeLegacyState(stateDir, executionId, body) {
  const dir = path.join(stateDir, executionId);
  await fs.mkdir(dir, { recursive: true });
  const file = path.join(dir, LEGACY_STATE_FILE);
  await fs.writeFile(file, JSON.stringify(body), 'utf8');
  return file;
}

/**
 * Whether a path exists.
 *
 * @param {string} target - Path to probe.
 * @returns {Promise<boolean>}
 */
async function exists(target) {
  try {
    await fs.access(target);
    return true;
  } catch {
    return false;
  }
}

/**
 * Poll `check` until it is true or the budget runs out.
 *
 * Used only where an implementation schedules its own work; each step is well
 * under the "no sleeps" budget and a satisfied condition returns immediately.
 *
 * @param {() => Promise<boolean>|boolean} check - The condition.
 * @param {Object} [options]
 * @param {number} [options.timeoutMs=2000] - Total budget.
 * @param {string} [options.what='condition'] - Named in the failure.
 * @returns {Promise<void>}
 */
async function until(check, { timeoutMs = 2000, what = 'condition' } = {}) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (await check()) return;
    if (Date.now() > deadline) throw new Error(`Timed out waiting for ${what}`);
    await new Promise(resolve => setTimeout(resolve, 10));
  }
}

/**
 * Seed a state plus its run summary, so the sweep has both to remove.
 *
 * @param {Object} ctx - Stores from {@link withStores}.
 * @param {string} executionId - Execution identifier.
 * @param {string} status - Execution status.
 * @param {Object} [overrides] - State fields to change.
 * @returns {Promise<void>}
 */
async function seed(ctx, executionId, status, overrides = {}) {
  await ctx.repository.write(executionId, state(executionId, status, overrides), {
    ownerId: OWNER
  });
  await ctx.runSummaries.put({
    runId: executionId,
    kind: 'workflow',
    ownerId: OWNER,
    status,
    startedAt: new Date().toISOString()
  });
}

describe('workflowRetentionSettings', () => {
  it('reads the platform block and defaults what it does not find', () => {
    assert.deepEqual(workflowRetentionSettings({}), {
      retentionDays: DEFAULT_RETENTION_DAYS,
      cleanupEnabled: true
    });
    assert.deepEqual(workflowRetentionSettings({ workflowState: { retentionDays: 7 } }), {
      retentionDays: 7,
      cleanupEnabled: true
    });
    assert.deepEqual(
      workflowRetentionSettings({ workflowState: { retentionDays: 0, cleanupEnabled: false } }),
      { retentionDays: 0, cleanupEnabled: false }
    );
    assert.equal(
      workflowRetentionSettings({ workflowState: { retentionDays: 'soon' } }).retentionDays,
      DEFAULT_RETENTION_DAYS,
      'a value that is not a number falls back rather than disabling the sweep'
    );
  });
});

describe('sweepWorkflowStates', () => {
  it('removes terminal states, their summaries and their sub-workflow states', async () => {
    await withStores(async ctx => {
      await seed(ctx, 'wf-exec-completed', WorkflowStatus.COMPLETED);
      await seed(ctx, 'wf-exec-failed', WorkflowStatus.FAILED);
      await seed(ctx, 'wf-exec-cancelled', WorkflowStatus.CANCELLED);
      await seed(ctx, 'wf-child-1', WorkflowStatus.COMPLETED);
      await seed(ctx, 'wf-exec-paused', WorkflowStatus.PAUSED);
      await seed(ctx, 'wf-exec-running', WorkflowStatus.RUNNING);
      // A run whose document was imported from the old layout still has its
      // directory; retention owes the disk both halves.
      await writeLegacyState(
        ctx.stateDir,
        'wf-exec-completed',
        state('wf-exec-completed', WorkflowStatus.COMPLETED)
      );
      await writeLegacyState(
        ctx.stateDir,
        'wf-exec-legacy',
        state('wf-exec-legacy', WorkflowStatus.COMPLETED)
      );
      await ctx.runSummaries.put({
        runId: 'wf-exec-legacy',
        kind: 'workflow',
        ownerId: OWNER,
        status: WorkflowStatus.COMPLETED,
        startedAt: new Date().toISOString()
      });

      const fresh = await sweepWorkflowStates({
        repository: ctx.repository,
        runSummaries: ctx.runSummaries,
        retentionDays: 30
      });
      assert.equal(fresh.removed, 0, 'nothing is old enough yet');
      assert.equal(fresh.scanned, 7);

      const swept = await sweepWorkflowStates({
        repository: ctx.repository,
        runSummaries: ctx.runSummaries,
        retentionDays: 30,
        now: () => Date.now() + 40 * DAY_MS
      });

      assert.equal(swept.removed, 5, 'three terminal, one child and one legacy-only');
      assert.equal(swept.summariesRemoved, 5);
      for (const id of [
        'wf-exec-completed',
        'wf-exec-failed',
        'wf-exec-cancelled',
        'wf-child-1',
        'wf-exec-legacy'
      ]) {
        assert.equal(await ctx.repository.read(id), null, `${id} state removed`);
        assert.equal(await ctx.runSummaries.get(id), null, `${id} summary removed`);
        assert.equal(
          await exists(path.join(ctx.stateDir, id)),
          false,
          `${id} legacy directory removed`
        );
      }

      // Nothing that could still be live is touched, whatever its age.
      assert.equal((await ctx.repository.read('wf-exec-paused')).status, WorkflowStatus.PAUSED);
      assert.equal((await ctx.repository.read('wf-exec-running')).status, WorkflowStatus.RUNNING);
      assert.ok(await ctx.runSummaries.get('wf-exec-paused'));
      assert.ok(await ctx.runSummaries.get('wf-exec-running'));
    });
  });

  it('keeps a state whose own timestamps say it is recent', async () => {
    // A directory restored from a backup, or a state the orphan sweeper
    // rewrote: whichever of the two clocks is newer decides, so the effect is
    // a run kept longer, never one deleted early.
    await withStores(async ctx => {
      const claimedRecent = new Date(Date.now() + 35 * DAY_MS).toISOString();
      await seed(ctx, 'wf-exec-restored', WorkflowStatus.COMPLETED, {
        completedAt: claimedRecent,
        updatedAt: claimedRecent
      });
      await seed(ctx, 'wf-exec-really-old', WorkflowStatus.COMPLETED);

      const result = await sweepWorkflowStates({
        repository: ctx.repository,
        runSummaries: ctx.runSummaries,
        retentionDays: 30,
        now: () => Date.now() + 40 * DAY_MS
      });

      assert.equal(result.removed, 1);
      assert.ok(await ctx.repository.read('wf-exec-restored'));
      assert.equal(await ctx.repository.read('wf-exec-really-old'), null);
    });
  });

  it('does nothing at all when retention is switched off', async () => {
    await withStores(async ctx => {
      await seed(ctx, 'wf-exec-completed', WorkflowStatus.COMPLETED);

      for (const retentionDays of [0, -1, Number.NaN]) {
        const result = await sweepWorkflowStates({
          repository: ctx.repository,
          runSummaries: ctx.runSummaries,
          retentionDays,
          now: () => Date.now() + 400 * DAY_MS
        });
        assert.deepEqual(result, { removed: 0, scanned: 0, summariesRemoved: 0 });
      }
      assert.ok(await ctx.repository.read('wf-exec-completed'));
      assert.ok(await ctx.runSummaries.get('wf-exec-completed'));
    });
  });

  it('leaves a summary alone when its state could not be removed', async () => {
    await withStores(async ctx => {
      await seed(ctx, 'wf-exec-stuck', WorkflowStatus.COMPLETED);
      const failing = {
        listSummaries: (...args) => ctx.repository.listSummaries(...args),
        read: (...args) => ctx.repository.read(...args),
        remove: async () => {
          throw new Error('disk is read-only');
        }
      };

      const result = await sweepWorkflowStates({
        repository: failing,
        runSummaries: ctx.runSummaries,
        retentionDays: 30,
        now: () => Date.now() + 40 * DAY_MS
      });

      assert.equal(result.removed, 0);
      assert.equal(result.summariesRemoved, 0);
      assert.ok(
        await ctx.runSummaries.get('wf-exec-stuck'),
        'a run with state but no summary would be invisible while still taking up space'
      );
    });
  });
});

describe('startWorkflowStateRetention', () => {
  afterEach(() => {
    // The sweep timer is module state; a leaked one would make the next start
    // a no-op and the next case a mystery.
    stopWorkflowStateRetention();
  });

  it('sweeps once immediately, so a misconfiguration shows at boot', async () => {
    await withStores(async ctx => {
      const old = Date.now() - 90 * DAY_MS;
      const oldIso = new Date(old).toISOString();
      const file = await writeLegacyState(
        ctx.stateDir,
        'wf-exec-ancient',
        state('wf-exec-ancient', WorkflowStatus.COMPLETED, {
          createdAt: oldIso,
          updatedAt: oldIso,
          completedAt: oldIso
        })
      );
      // The scan dates a legacy entry by its file, so age the file too.
      await fs.utimes(file, new Date(old), new Date(old));
      await ctx.runSummaries.put({
        runId: 'wf-exec-ancient',
        kind: 'workflow',
        ownerId: OWNER,
        status: WorkflowStatus.COMPLETED,
        startedAt: oldIso
      });

      const stop = startWorkflowStateRetention({
        repository: ctx.repository,
        runSummaries: ctx.runSummaries,
        getPlatformConfig: () => ({ workflowState: { retentionDays: 30 } }),
        intervalMs: 60_000
      });

      await until(async () => (await ctx.repository.read('wf-exec-ancient')) === null, {
        what: 'the boot sweep to remove the ancient execution'
      });
      assert.equal(await ctx.runSummaries.get('wf-exec-ancient'), null);
      assert.equal(typeof stop, 'function');
      assert.equal(
        startWorkflowStateRetention({ repository: ctx.repository }),
        stopWorkflowStateRetention,
        'starting twice does not sweep twice'
      );
      stop();
    });
  });

  it('respects cleanupEnabled: false and a retentionDays of zero', async () => {
    await withStores(async ctx => {
      const old = Date.now() - 90 * DAY_MS;
      const oldIso = new Date(old).toISOString();
      const file = await writeLegacyState(
        ctx.stateDir,
        'wf-exec-ancient',
        state('wf-exec-ancient', WorkflowStatus.COMPLETED, {
          createdAt: oldIso,
          updatedAt: oldIso,
          completedAt: oldIso
        })
      );
      await fs.utimes(file, new Date(old), new Date(old));

      for (const workflowState of [
        { retentionDays: 30, cleanupEnabled: false },
        { retentionDays: 0 }
      ]) {
        startWorkflowStateRetention({
          repository: ctx.repository,
          runSummaries: ctx.runSummaries,
          getPlatformConfig: () => ({ workflowState }),
          intervalMs: 60_000
        });
        // Let the immediate tick run to completion before judging it.
        await new Promise(resolve => setTimeout(resolve, 25));
        assert.ok(
          await ctx.repository.read('wf-exec-ancient'),
          `nothing swept with ${JSON.stringify(workflowState)}`
        );
        stopWorkflowStateRetention();
      }
    });
  });
});
