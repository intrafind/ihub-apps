// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * Workflow state on the storage provider: `WorkflowStateRepository`, the
 * checkpoint path through `StateManager`, the two boot sweeps that read it,
 * and the legacy `<executionId>/latest.json` directories.
 *
 * The namespace shares a directory with the layout it replaces, so almost
 * every case here is really about the union of the two halves. The one that
 * matters most is the partly migrated installation: a scanner that saw only
 * the documents would report an installation full of interrupted runs as
 * empty — leaving every one of them stuck at `running` for ever.
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
  workflowStateOwnerId,
  getWorkflowStateRepository
} from '../services/workflow/WorkflowStateRepository.js';
import { StorageBootstrapError, shutdownStorageBootstrap } from '../storage/bootstrap.js';
import {
  StateManager,
  WorkflowStatus,
  getStateManager,
  resetStateManager
} from '../services/workflow/StateManager.js';
import { resetExecutionRegistry } from '../services/workflow/ExecutionRegistry.js';
import { WorkflowEngine } from '../services/workflow/WorkflowEngine.js';
import runLog from '../services/loop/RunLog.js';
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
 * @param {string} [baseDir] - Existing directory to re-open.
 * @returns {Promise<Object>} Provider, repository, log lines and directory.
 */
async function openRepository(baseDir) {
  const dir = baseDir || (await fs.mkdtemp(path.join(os.tmpdir(), 'ihub-wf-state-')));
  const provider = new FilesystemStorageProvider({ baseDir: dir, flushIntervalMs: 25 });
  await provider.initialize();
  const { lines, logger } = recordingLogger();
  const repository = new WorkflowStateRepository({
    documents: provider.documents,
    locks: provider.locks,
    logger
  });
  return { baseDir: dir, provider, repository, lines };
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
 * Store a state the way `StateManager` checkpoints it.
 *
 * @param {WorkflowStateRepository} repository - Repository to write through.
 * @param {string} executionId - Execution identifier.
 * @param {Object} body - State to write.
 * @returns {Promise<void>}
 */
async function writeState(repository, executionId, body) {
  await repository.write(executionId, body, { ownerId: workflowStateOwnerId(body) });
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

  it('reads a state that is not a state, or an unusable id, as absent', async () => {
    await withRepository(async ({ repository, provider }) => {
      await provider.documents.put(WORKFLOW_STATE_NAMESPACE, 'wf-exec-junk', { hello: 'world' });
      assert.equal(await repository.read('wf-exec-junk'), null);
      assert.equal(await repository.read('wf-exec-missing'), null);
      assert.equal(await repository.read('../escape'), null, 'an unusable id reads as absent');
    });
  });

  it('removes a state and reports whether anything went', async () => {
    await withRepository(async ({ repository, provider }) => {
      await repository.write('wf-exec-1', state('wf-exec-1'));
      assert.equal(await repository.remove('wf-exec-1'), true);
      assert.equal(await provider.documents.get(WORKFLOW_STATE_NAMESPACE, 'wf-exec-1'), null);
      assert.equal(await repository.remove('wf-exec-1'), false);
      assert.equal(await repository.remove('../escape'), false);
    });
  });

  it('scans the namespace as metadata or with the states, with an optional prefix', async () => {
    await withRepository(async ({ repository }) => {
      await repository.write('wf-exec-a', state('wf-exec-a'));
      await repository.write('wf-exec-b', state('wf-exec-b'));
      await repository.write('wf-child-1', state('wf-child-1'));

      const summaries = await repository.listSummaries();
      assert.deepEqual(summaries.items.map(item => item.executionId).sort(), [
        'wf-child-1',
        'wf-exec-a',
        'wf-exec-b'
      ]);
      assert.equal(summaries.truncated, false);
      for (const item of summaries.items) {
        assert.equal(Number.isFinite(item.updatedAt), true, 'every entry can be aged');
        assert.equal('state' in item, false, 'no body is read for a metadata scan');
      }
      assert.deepEqual(
        (await repository.listSummaries({ prefix: 'wf-exec-' })).items
          .map(item => item.executionId)
          .sort(),
        ['wf-exec-a', 'wf-exec-b']
      );

      const full = await repository.list({ prefix: 'wf-exec-' });
      assert.equal(full.items.length, 2);
      for (const item of full.items) {
        assert.equal(item.state.executionId, item.executionId);
      }
    });
  });

  it('never lists the legacy execution registry file as an execution', async () => {
    await withRepository(async ({ repository, provider }) => {
      await provider.documents.put(WORKFLOW_STATE_NAMESPACE, 'execution-registry', {
        version: 1,
        executions: []
      });
      assert.deepEqual((await repository.listSummaries()).items, []);
      assert.equal(await repository.remove('execution-registry'), false);
    });
  });

  it('refuses to be built without the provider documents', () => {
    assert.throws(() => new WorkflowStateRepository({}), TypeError);
  });

  it('the shared repository needs a bootstrapped provider', async () => {
    await shutdownStorageBootstrap();
    assert.throws(() => getWorkflowStateRepository(), StorageBootstrapError);
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

  it('marks interrupted executions failed', async () => {
    await withRepository(async ({ repository, provider }) => {
      await repository.write('wf-exec-doc', state('wf-exec-doc'), { ownerId: OWNER });
      await writeState(repository, 'wf-exec-legacy', state('wf-exec-legacy'));
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
      await writeState(repository, 'wf-child-1', state('wf-child-1'));

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

  it('also sweeps a workflow a chat started, but not one paused for input', async () => {
    // `@workflow` runs carry the chat's run id and are never resumed, so one
    // left running died with the process. A paused one can still be answered.
    await withRepository(async ({ repository }) => {
      await repository.write('workflow-chat-1', state('workflow-chat-1'), { ownerId: OWNER });
      await repository.write(
        'workflow-chat-paused',
        state('workflow-chat-paused', { status: WorkflowStatus.PAUSED }),
        { ownerId: OWNER }
      );

      const result = await sweepOrphanedExecutions({ requireSchedulerOwner: false, repository });

      assert.equal(result.marked, 1);
      assert.equal((await repository.read('workflow-chat-1')).status, 'failed');
      assert.equal((await repository.read('workflow-chat-paused')).status, WorkflowStatus.PAUSED);
    });
  });

  it('leaves a chat’s workflow that another worker is running alone', async () => {
    // The chat's request, and with it the workflow, landed on another worker:
    // this process's `activeStates` never saw it.
    await withRepository(async ({ repository }) => {
      const live = state('workflow-chat-live');
      live.data = { ...live.data, _chatId: 'chat-live' };
      await repository.write('workflow-chat-live', live, { ownerId: OWNER });
      await repository.write('workflow-chat-dead', state('workflow-chat-dead'), {
        ownerId: OWNER
      });
      const asked = [];

      const result = await sweepOrphanedExecutions({
        requireSchedulerOwner: false,
        repository,
        heldByAnotherWorker: (executionId, stored) => {
          asked.push(executionId);
          return stored.data?._chatId === 'chat-live';
        }
      });

      assert.equal(result.marked, 1);
      assert.equal((await repository.read('workflow-chat-live')).status, WorkflowStatus.RUNNING);
      assert.equal((await repository.read('workflow-chat-dead')).status, 'failed');
      assert.deepEqual(asked.sort(), ['workflow-chat-dead', 'workflow-chat-live']);
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
});

describe('resume through the repository', () => {
  it('finds the interrupted runs that were checkpointed', async () => {
    await withRepository(async ({ repository }) => {
      await writeState(repository, 'wf-exec-running', state('wf-exec-running'));
      await writeState(
        repository,
        'wf-exec-pending',
        state('wf-exec-pending', { status: WorkflowStatus.PENDING })
      );
      await writeState(
        repository,
        'wf-exec-done',
        state('wf-exec-done', { status: WorkflowStatus.COMPLETED })
      );
      await writeState(repository, 'wf-child-1', state('wf-child-1'));

      const candidates = await findResumableExecutions(repository);
      assert.deepEqual(
        candidates.map(candidate => candidate.executionId).sort(),
        ['wf-exec-pending', 'wf-exec-running'],
        'terminal runs and sub-workflow states are not resumable'
      );
      assert.equal(candidates[0].state.workflowId, 'wf-1');
    });
  });

  it('resumes what it can and skips what it cannot resolve', async () => {
    await withRepository(async ({ repository }) => {
      await writeState(repository, 'wf-exec-known', state('wf-exec-known'));
      await writeState(
        repository,
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
        repository,
        resolveDefinition: candidate =>
          candidate.workflowId === 'wf-1' ? { definition: { id: 'wf-1' } } : null
      });

      assert.deepEqual(result.resumed, ['wf-exec-known']);
      assert.deepEqual(result.skipped, ['wf-exec-unknown']);
      assert.deepEqual(resumed, ['wf-exec-known']);
    });
  });
});

describe('the chat an execution belongs to', () => {
  const definition = {
    id: 'wf-1',
    nodes: [
      { id: 'start', type: 'start' },
      { id: 'end', type: 'end' }
    ],
    edges: [{ source: 'start', target: 'end' }]
  };

  it('is the server’s to say, never the start data’s', async () => {
    await withRepository(async ({ repository }) => {
      const engine = new WorkflowEngine({ stateManager: new StateManager({ repository }) });
      engine._runExecutionLoop = async () => {};
      const started = [];
      const startRun = runLog.startRun;
      runLog.startRun = async args => {
        started.push(args);
        return { runId: args.runId };
      };
      try {
        // Start data an API caller posted, claiming somebody's chat.
        const claimed = await engine.start(
          definition,
          { input: 'q', _chatId: 'chat-of-someone-else', _appId: 'chat' },
          { executionId: 'wf-exec-claimed' }
        );
        // The chat's workflow bridge.
        const bridged = await engine.start(
          definition,
          { input: 'q', _chatId: 'chat-of-someone-else' },
          { executionId: 'workflow-bridged', chat: { chatId: 'chat-1', appId: 'app-1' } }
        );

        assert.equal(claimed.data._chatId, undefined);
        assert.equal(claimed.data._appId, undefined);
        assert.equal(started[0].refs.chatId, undefined);
        assert.equal(started[0].refs.appId, undefined);
        assert.equal(bridged.data._chatId, 'chat-1');
        assert.equal(bridged.data._appId, 'app-1');
        assert.equal(started[1].refs.chatId, 'chat-1');
        assert.equal(started[1].refs.appId, 'app-1');
      } finally {
        runLog.startRun = startRun;
      }
    });
  });
});
