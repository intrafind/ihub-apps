/**
 * Workflow state on the storage provider: `WorkflowStateRepository`, the
 * checkpoint path through `StateManager`, the two boot sweeps that read it,
 * and the one-time import of the legacy `<executionId>/latest.json`
 * directories.
 *
 * The namespace shares a directory with the layout it replaces, so almost
 * every case here is really about the union of the two halves. The one that
 * matters most is the half-imported installation: the import is bounded and
 * idempotent, so a real upgrade sits in that state for a while, and a scanner
 * that saw only the documents would report an installation full of
 * interrupted runs as empty — leaving every one of them stuck at `running`
 * for ever.
 *
 * Contract: `RUNTIME_STORES_CONTRACT.md` §5 and D5.
 */
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { FilesystemStorageProvider } from '../storage/providers/filesystem/index.js';
import {
  WorkflowStateRepository,
  WORKFLOW_STATE_NAMESPACE,
  LEGACY_STATE_FILE,
  IMPORT_STATE_NAMESPACE,
  IMPORT_STATE_KEY,
  importLegacyWorkflowStates,
  workflowStateOwnerId
} from '../services/workflow/WorkflowStateRepository.js';
import {
  StateManager,
  WorkflowStatus,
  getStateManager,
  resetStateManager
} from '../services/workflow/StateManager.js';
import { resetExecutionRegistry } from '../services/workflow/ExecutionRegistry.js';
import { sweepOrphanedExecutions } from '../services/workflow/orphanSweeper.js';
import {
  findResumableExecutions,
  resumeInterruptedRuns
} from '../services/workflow/resumeManager.js';

const OWNER = 'user-1';

/**
 * A logger that records instead of printing.
 *
 * @returns {{lines: Array<{level: string, message: string, meta: Object}>, logger: Object}}
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
 * A workflow execution state, in the shape `StateManager` persists.
 *
 * @param {string} executionId - Execution identifier.
 * @param {Object} [overrides] - Fields to change.
 * @returns {Object} The state.
 */
function state(executionId, overrides = {}) {
  const now = new Date().toISOString();
  return {
    executionId,
    workflowId: 'wf-1',
    status: WorkflowStatus.RUNNING,
    currentNodes: ['node-a'],
    completedNodes: [],
    failedNodes: [],
    data: { _workflow: { startedBy: OWNER }, nodeResults: {} },
    history: [],
    checkpoints: [],
    errors: [],
    createdAt: now,
    updatedAt: now,
    startedAt: now,
    completedAt: null,
    ...overrides
  };
}

/**
 * Bring up a provider and a repository over `baseDir`.
 *
 * The legacy state directory is deliberately the namespace's own directory —
 * that is the on-disk collision this issue has to survive, with
 * `<id>/latest.json` directories sitting beside `<id>.json` documents.
 *
 * @param {string} [baseDir] - Existing directory to re-open.
 * @returns {Promise<Object>} Provider, repository, log lines and directories.
 */
async function openRepository(baseDir) {
  const dir = baseDir || (await fs.mkdtemp(path.join(os.tmpdir(), 'ihub-wf-state-')));
  const provider = new FilesystemStorageProvider({ baseDir: dir, flushIntervalMs: 25 });
  await provider.initialize();
  const stateDir = path.join(dir, WORKFLOW_STATE_NAMESPACE);
  await fs.mkdir(stateDir, { recursive: true });
  const { lines, logger } = recordingLogger();
  const repository = new WorkflowStateRepository({
    documents: provider.documents,
    locks: provider.locks,
    stateDir,
    logger
  });
  return { baseDir: dir, stateDir, provider, repository, lines };
}

/**
 * Run `fn` with a repository over a directory of its own, torn down after.
 *
 * @param {(ctx: Object) => Promise<void>} fn - The test body.
 * @returns {Promise<void>}
 */
async function withRepository(fn) {
  const ctx = await openRepository();
  try {
    await fn(ctx);
  } finally {
    await ctx.provider.shutdown();
    await fs.rm(ctx.baseDir, { recursive: true, force: true });
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
  await fs.writeFile(file, JSON.stringify(body, null, 2), 'utf8');
  return file;
}

describe('WorkflowStateRepository', () => {
  it('stores a state as an owned document', async () => {
    await withRepository(async ({ repository, provider }) => {
      const body = state('wf-exec-1');
      await repository.write('wf-exec-1', body, { ownerId: workflowStateOwnerId(body) });

      const doc = await provider.documents.get(WORKFLOW_STATE_NAMESPACE, 'wf-exec-1');
      assert.equal(doc.ownerId, OWNER, 'the owner is on the document, not only in the body');
      assert.deepEqual(await repository.read('wf-exec-1'), body);

      const agent = state('wf-exec-2', { data: { _agent: { profileId: 'p-7' } } });
      assert.equal(workflowStateOwnerId(agent), 'agent:p-7');
      assert.equal(workflowStateOwnerId(state('wf-exec-3', { data: {} })), null);
    });
  });

  it('reads a legacy directory, and prefers the document when both exist', async () => {
    await withRepository(async ({ repository, stateDir }) => {
      await writeLegacyState(stateDir, 'wf-exec-legacy', state('wf-exec-legacy'));
      assert.equal((await repository.read('wf-exec-legacy')).workflowId, 'wf-1');

      await writeLegacyState(
        stateDir,
        'wf-exec-both',
        state('wf-exec-both', { workflowId: 'old' })
      );
      await repository.write('wf-exec-both', state('wf-exec-both', { workflowId: 'new' }));
      assert.equal(
        (await repository.read('wf-exec-both')).workflowId,
        'new',
        'the document is the newer copy'
      );

      assert.equal(await repository.read('wf-exec-missing'), null);
      assert.equal(await repository.read('../escape'), null, 'an unusable id reads as absent');
    });
  });

  it('reads a legacy directory whose state is unparseable as absent', async () => {
    await withRepository(async ({ repository, stateDir }) => {
      const dir = path.join(stateDir, 'wf-exec-torn');
      await fs.mkdir(dir, { recursive: true });
      await fs.writeFile(path.join(dir, LEGACY_STATE_FILE), '{"executionId":', 'utf8');
      assert.equal(await repository.read('wf-exec-torn'), null);
    });
  });

  it('removes both halves and reports whether anything went', async () => {
    await withRepository(async ({ repository, provider, stateDir }) => {
      await repository.write('wf-exec-1', state('wf-exec-1'));
      await writeLegacyState(stateDir, 'wf-exec-1', state('wf-exec-1'));

      assert.equal(await repository.remove('wf-exec-1'), true);
      assert.equal(await provider.documents.get(WORKFLOW_STATE_NAMESPACE, 'wf-exec-1'), null);
      assert.equal(
        await fs
          .access(path.join(stateDir, 'wf-exec-1'))
          .then(() => true)
          .catch(() => false),
        false
      );
      assert.equal(await repository.remove('wf-exec-1'), false);
    });
  });

  it('scans the union of documents and legacy directories, without duplicates', async () => {
    await withRepository(async ({ repository, stateDir }) => {
      await repository.write('wf-exec-doc', state('wf-exec-doc'));
      await writeLegacyState(stateDir, 'wf-exec-legacy', state('wf-exec-legacy'));
      await writeLegacyState(stateDir, 'wf-exec-both', state('wf-exec-both'));
      await repository.write('wf-exec-both', state('wf-exec-both'));
      await writeLegacyState(stateDir, 'wf-child-1', state('wf-child-1'));

      const summaries = await repository.listSummaries();
      assert.deepEqual(summaries.items.map(item => item.executionId).sort(), [
        'wf-child-1',
        'wf-exec-both',
        'wf-exec-doc',
        'wf-exec-legacy'
      ]);
      assert.equal(summaries.truncated, false);
      assert.equal(
        summaries.items.filter(item => item.executionId === 'wf-exec-both').length,
        1,
        'a state that exists in both halves is listed once'
      );
      for (const item of summaries.items) {
        assert.equal(Number.isFinite(item.updatedAt), true, 'every entry can be aged');
      }

      assert.deepEqual(
        (await repository.listSummaries({ prefix: 'wf-exec-' })).items
          .map(item => item.executionId)
          .sort(),
        ['wf-exec-both', 'wf-exec-doc', 'wf-exec-legacy']
      );
      assert.deepEqual(
        (await repository.listLegacy()).items.map(item => item.executionId).sort(),
        ['wf-child-1', 'wf-exec-both', 'wf-exec-legacy'],
        'the import walks only what is still legacy-only'
      );

      const full = await repository.list({ prefix: 'wf-exec-' });
      assert.equal(full.items.length, 3);
      for (const item of full.items) {
        assert.equal(item.state.executionId, item.executionId);
      }
    });
  });

  it('keeps using the legacy layout when no provider is available', async () => {
    const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), 'ihub-wf-legacy-'));
    const repository = new WorkflowStateRepository({
      stateDir,
      logger: recordingLogger().logger
    });
    try {
      assert.equal(repository.isAvailable(), false);
      await repository.write('wf-exec-1', state('wf-exec-1'), { ownerId: OWNER });
      assert.equal(
        await fs
          .access(path.join(stateDir, 'wf-exec-1', LEGACY_STATE_FILE))
          .then(() => true)
          .catch(() => false),
        true
      );
      assert.equal((await repository.read('wf-exec-1')).executionId, 'wf-exec-1');
      assert.deepEqual(
        (await repository.listSummaries()).items.map(i => i.executionId),
        ['wf-exec-1']
      );
      assert.equal(await repository.remove('wf-exec-1'), true);
    } finally {
      await fs.rm(stateDir, { recursive: true, force: true });
    }
  });
});

describe('StateManager: checkpoints through the repository', () => {
  it('persists a checkpoint as an owned document another process can read', async () => {
    await withRepository(async ({ repository, provider }) => {
      const manager = new StateManager({ repository });
      await manager.create({
        executionId: 'wf-exec-1',
        workflowId: 'wf-1',
        data: { _workflow: { startedBy: OWNER } },
        currentNodes: ['node-a']
      });
      const checkpoint = await manager.checkpoint('wf-exec-1', 'before_llm_call');

      assert.match(checkpoint.checkpointId, /^ckpt-/);
      const doc = await provider.documents.get(WORKFLOW_STATE_NAMESPACE, 'wf-exec-1');
      assert.equal(doc.ownerId, OWNER);
      assert.equal(doc.data.checkpoints.length, 1);
      assert.equal(doc.data.checkpoints[0].reason, 'before_llm_call');

      // A second process holds no `activeStates` entry, so this is the
      // read-through that used to be a raw `latest.json` read.
      const other = new StateManager({ repository });
      const restored = await other.get('wf-exec-1');
      assert.equal(restored.executionId, 'wf-exec-1');
      assert.equal(restored.checkpoints.length, 1);
      assert.equal(other.activeStates.has('wf-exec-1'), true, 'the read-through still caches');
    });
  });

  it('restores from the stored checkpoint', async () => {
    await withRepository(async ({ repository }) => {
      const manager = new StateManager({ repository });
      await manager.create({ executionId: 'wf-exec-1', workflowId: 'wf-1' });
      await manager.update('wf-exec-1', { status: WorkflowStatus.RUNNING });
      await manager.checkpoint('wf-exec-1', 'auto');

      const fresh = new StateManager({ repository });
      const restored = await fresh.restore('wf-exec-1');
      assert.equal(restored.executionId, 'wf-exec-1');
      assert.equal(restored.status, WorkflowStatus.RUNNING);
      assert.ok(restored.restoredAt, 'restore still stamps how the state was recovered');
    });
  });
});

describe('orphan sweep through the repository', () => {
  beforeEach(() => {
    // The sweeper reaches for the process-wide state manager and registry;
    // neither may carry state between cases.
    resetStateManager();
    resetExecutionRegistry();
  });

  afterEach(() => {
    resetStateManager();
    resetExecutionRegistry();
  });

  it('marks interrupted executions failed in both halves of the store', async () => {
    await withRepository(async ({ repository, provider, stateDir }) => {
      await repository.write('wf-exec-doc', state('wf-exec-doc'), { ownerId: OWNER });
      await writeLegacyState(stateDir, 'wf-exec-legacy', state('wf-exec-legacy'));
      await repository.write(
        'wf-exec-pending',
        state('wf-exec-pending', { status: WorkflowStatus.PENDING }),
        { ownerId: OWNER }
      );
      await repository.write(
        'wf-exec-done',
        state('wf-exec-done', { status: WorkflowStatus.COMPLETED }),
        { ownerId: OWNER }
      );
      await writeLegacyState(stateDir, 'wf-child-1', state('wf-child-1'));

      const result = await sweepOrphanedExecutions({
        requireSchedulerOwner: false,
        repository
      });

      assert.equal(result.marked, 3, 'the document, the legacy copy and the pending one');
      for (const id of ['wf-exec-doc', 'wf-exec-legacy', 'wf-exec-pending']) {
        const swept = await repository.read(id);
        assert.equal(swept.status, 'failed', `${id} was marked failed`);
        assert.equal(swept.errors.at(-1).type, 'server_restart');
        assert.ok(swept.completedAt);
      }
      assert.equal((await repository.read('wf-exec-done')).status, WorkflowStatus.COMPLETED);
      assert.equal(
        (await repository.read('wf-child-1')).status,
        WorkflowStatus.RUNNING,
        'a sub-workflow state is never swept on its own'
      );
      assert.equal(
        (await provider.documents.get(WORKFLOW_STATE_NAMESPACE, 'wf-exec-doc')).ownerId,
        OWNER,
        'the owner index survives the rewrite'
      );
    });
  });

  it('leaves a run that is live in this process alone', async () => {
    await withRepository(async ({ repository }) => {
      await repository.write('wf-exec-live', state('wf-exec-live'), { ownerId: OWNER });
      // The guard the sweeper has always relied on: a run the resume manager
      // just picked up lives only in this process's `activeStates`.
      getStateManager().activeStates.set('wf-exec-live', state('wf-exec-live'));

      const result = await sweepOrphanedExecutions({ requireSchedulerOwner: false, repository });
      assert.equal(result.marked, 0);
      assert.equal((await repository.read('wf-exec-live')).status, WorkflowStatus.RUNNING);
    });
  });

  it('sees a half-imported installation, not an empty one', async () => {
    await withRepository(async ({ repository, stateDir, provider }) => {
      // Two interrupted runs on disk in the old layout; the import is bounded
      // to one, which is exactly what a large installation looks like part way
      // through its first boot on the new release.
      await writeLegacyState(stateDir, 'wf-exec-a', state('wf-exec-a'));
      await writeLegacyState(stateDir, 'wf-exec-b', state('wf-exec-b'));

      const imported = await importLegacyWorkflowStates({
        repository,
        maxStates: 1,
        logger: recordingLogger().logger
      });
      assert.equal(imported.imported, 1);
      assert.equal(imported.truncated, true);

      const documents = await provider.documents.list(WORKFLOW_STATE_NAMESPACE, {
        includeData: false
      });
      assert.equal(documents.items.length, 1, 'only half the states are documents');

      const result = await sweepOrphanedExecutions({ requireSchedulerOwner: false, repository });
      assert.equal(result.scanned, 2);
      assert.equal(result.marked, 2, 'both halves were swept');
      assert.equal((await repository.read('wf-exec-a')).status, 'failed');
      assert.equal((await repository.read('wf-exec-b')).status, 'failed');
    });
  });
});

describe('resume through the repository', () => {
  it('finds the interrupted runs a legacy installation still has', async () => {
    await withRepository(async ({ stateDir }) => {
      await writeLegacyState(stateDir, 'wf-exec-running', state('wf-exec-running'));
      await writeLegacyState(
        stateDir,
        'wf-exec-pending',
        state('wf-exec-pending', { status: WorkflowStatus.PENDING })
      );
      await writeLegacyState(
        stateDir,
        'wf-exec-done',
        state('wf-exec-done', { status: WorkflowStatus.COMPLETED })
      );
      await writeLegacyState(stateDir, 'wf-child-1', state('wf-child-1'));

      const candidates = await findResumableExecutions(stateDir);
      assert.deepEqual(
        candidates.map(candidate => candidate.executionId).sort(),
        ['wf-exec-pending', 'wf-exec-running'],
        'terminal runs and sub-workflow states are not resumable'
      );
      assert.equal(candidates[0].state.workflowId, 'wf-1');
    });
  });

  it('resumes what it can and skips what it cannot resolve', async () => {
    await withRepository(async ({ stateDir }) => {
      await writeLegacyState(stateDir, 'wf-exec-known', state('wf-exec-known'));
      await writeLegacyState(
        stateDir,
        'wf-exec-unknown',
        state('wf-exec-unknown', { workflowId: 'gone' })
      );

      const resumed = [];
      const engine = {
        async resumeFromCheckpoint(definition, executionId) {
          resumed.push(executionId);
        }
      };
      const result = await resumeInterruptedRuns({
        engine,
        requireSchedulerOwner: false,
        stateDir,
        resolveDefinition: candidate =>
          candidate.workflowId === 'wf-1' ? { definition: { id: 'wf-1' } } : null
      });

      assert.deepEqual(result.resumed, ['wf-exec-known']);
      assert.deepEqual(result.skipped, ['wf-exec-unknown']);
      assert.deepEqual(resumed, ['wf-exec-known']);
    });
  });
});

describe('importLegacyWorkflowStates', () => {
  it('carries the legacy directories into the namespace, owner and all', async () => {
    await withRepository(async ({ repository, provider, stateDir, lines }) => {
      await writeLegacyState(stateDir, 'wf-exec-1', state('wf-exec-1'));
      await writeLegacyState(
        stateDir,
        'wf-exec-agent',
        state('wf-exec-agent', { data: { _agent: { profileId: 'p-7' } } })
      );
      await writeLegacyState(stateDir, 'wf-child-1', state('wf-child-1'));

      const result = await importLegacyWorkflowStates({
        repository,
        logger: recordingLogger().logger
      });

      assert.equal(result.ran, true);
      assert.equal(result.imported, 3, 'sub-workflow states are carried over too');
      assert.equal(result.truncated, false);
      assert.equal(
        (await provider.documents.get(WORKFLOW_STATE_NAMESPACE, 'wf-exec-1')).ownerId,
        OWNER
      );
      assert.equal(
        (await provider.documents.get(WORKFLOW_STATE_NAMESPACE, 'wf-exec-agent')).ownerId,
        'agent:p-7'
      );
      assert.deepEqual(
        lines.filter(line => line.level === 'error'),
        []
      );
    });
  });

  it('leaves the legacy directories exactly where they are', async () => {
    await withRepository(async ({ repository, stateDir }) => {
      const file = await writeLegacyState(stateDir, 'wf-exec-1', state('wf-exec-1'));
      const before = await fs.readFile(file, 'utf8');

      await importLegacyWorkflowStates({ repository, logger: recordingLogger().logger });

      assert.equal(await fs.readFile(file, 'utf8'), before);
      assert.equal(
        (await repository.listLegacy()).items.length,
        1,
        'the legacy copy is still the fallback for anything not yet carried over'
      );
    });
  });

  it('is idempotent, and never overwrites a newer document', async () => {
    await withRepository(async ({ repository, provider, stateDir }) => {
      await writeLegacyState(stateDir, 'wf-exec-1', state('wf-exec-1', { workflowId: 'old' }));

      const first = await importLegacyWorkflowStates({
        repository,
        logger: recordingLogger().logger
      });
      assert.equal(first.imported, 1);

      const second = await importLegacyWorkflowStates({
        repository,
        logger: recordingLogger().logger
      });
      assert.equal(second.ran, false);
      assert.equal(second.reason, 'already-imported');
      assert.ok(
        (await provider.documents.get(IMPORT_STATE_NAMESPACE, IMPORT_STATE_KEY)).data.completedAt
      );

      // A checkpoint written after the import must not be rolled back by a
      // forced re-run.
      await repository.write('wf-exec-1', state('wf-exec-1', { workflowId: 'new' }));
      const third = await importLegacyWorkflowStates({
        repository,
        force: true,
        logger: recordingLogger().logger
      });
      assert.equal(third.imported, 0);
      assert.equal(third.skipped, 1);
      assert.equal((await repository.read('wf-exec-1')).workflowId, 'new');
    });
  });

  it('reports unavailable storage instead of throwing', async () => {
    const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), 'ihub-wf-noprovider-'));
    try {
      const result = await importLegacyWorkflowStates({
        repository: new WorkflowStateRepository({ stateDir, logger: recordingLogger().logger }),
        logger: recordingLogger().logger
      });
      assert.equal(result.ran, false);
      assert.equal(result.reason, 'storage-unavailable');
    } finally {
      await fs.rm(stateDir, { recursive: true, force: true });
    }
  });
});
