/**
 * `ExecutionRegistry` over the shared `runs` namespace, driven against a real
 * `FilesystemStorageProvider`.
 *
 * This is the class AC1 is about. It used to be a per-process `Map` flushed
 * in whole to `execution-registry.json`; it is now a projection over one
 * document per execution, and almost everything that makes that projection
 * correct is invisible from the outside:
 *
 *   - the namespace is **shared with the ledger**, which writes a summary for
 *     every chat, utility and child run, so the kind and `wf-child-` filters
 *     are the only thing keeping those out of the workflow listings, the
 *     admin counts, and the boot rescan that flips running executions to
 *     `failed`;
 *   - writes are **fire-and-forget and serialized per execution**, because a
 *     status patch that overtook its create would be dropped;
 *   - the create is a **merge**, because the ledger writes the same document
 *     from a queue of its own;
 *   - the two stores name the same outcomes differently, so a ledger `error`
 *     has to read back as `failed`;
 *   - the in-flight local record wins over the document, and stops doing so
 *     the moment the terminal write lands.
 *
 * Contract: `RUNTIME_STORES_CONTRACT.md` §3, D3 (async reads) and D4.
 */
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { FilesystemStorageProvider } from '../storage/providers/filesystem/index.js';
import { RunSummaryRepository, RUNS_NAMESPACE } from '../services/runtime/RunSummaryRepository.js';
import { ExecutionRegistry } from '../services/workflow/ExecutionRegistry.js';
import { WorkflowStatus } from '../services/workflow/StateManager.js';
import { LEGACY_STATE_FILE } from '../services/workflow/WorkflowStateRepository.js';
import runLog from '../services/loop/RunLog.js';
import { resolvePrincipal } from '../services/loop/runIdentity.js';

const OWNER = 'user-1';
const OTHER_OWNER = 'user-2';

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
 * Bring up a provider, a run summary repository and a registry injected with
 * it, over `baseDir` or a scratch directory of its own.
 *
 * @param {Object} [options]
 * @param {string} [options.baseDir] - Existing directory to re-open, for the
 *   two-workers-one-volume cases.
 * @param {string} [options.stateDir] - Checkpoint directory the recovery scan
 *   reads.
 * @returns {Promise<Object>} Provider, repository, registry and directories.
 */
async function openRegistry({ baseDir, stateDir } = {}) {
  const root = baseDir || (await fs.mkdtemp(path.join(os.tmpdir(), 'ihub-exec-registry-')));
  const provider = new FilesystemStorageProvider({ baseDir: root, flushIntervalMs: 25 });
  await provider.initialize();
  const summaries = new RunSummaryRepository({
    documents: provider.documents,
    locks: provider.locks,
    logger: recordingLogger().logger
  });
  const { lines, logger } = recordingLogger();
  const registry = new ExecutionRegistry({
    summaries,
    logger,
    ...(stateDir ? { stateDir } : {})
  });
  return { baseDir: root, provider, summaries, registry, lines };
}

/**
 * Run `fn` with a registry of its own, torn down after.
 *
 * @param {(ctx: Object) => Promise<void>} fn - The test body.
 * @param {Object} [options] - Passed to {@link openRegistry}.
 * @returns {Promise<void>}
 */
async function withRegistry(fn, options = {}) {
  const ctx = await openRegistry(options);
  try {
    await fn(ctx);
  } finally {
    await ctx.registry.flushWrites();
    await ctx.provider.shutdown();
    await fs.rm(ctx.baseDir, { recursive: true, force: true });
  }
}

/**
 * Run `fn` with two registries over two providers sharing one directory —
 * the shape two cluster workers on a shared volume have.
 *
 * @param {(first: Object, second: Object) => Promise<void>} fn - The test body.
 * @returns {Promise<void>}
 */
async function withTwoRegistries(fn) {
  const first = await openRegistry();
  const second = await openRegistry({ baseDir: first.baseDir });
  try {
    await fn(first, second);
  } finally {
    await first.registry.flushWrites();
    await second.registry.flushWrites();
    await second.provider.shutdown();
    await first.provider.shutdown();
    await fs.rm(first.baseDir, { recursive: true, force: true });
  }
}

/**
 * Metadata for `register()`, with every field a route supplies.
 *
 * @param {Object} [overrides] - Fields to change.
 * @returns {Object} Registration metadata.
 */
function metadata(overrides = {}) {
  return {
    userId: OWNER,
    workflowId: 'quarterly-report',
    workflowName: { en: 'Quarterly Report' },
    status: WorkflowStatus.RUNNING,
    startedAt: new Date().toISOString(),
    source: 'ui',
    inputPreview: { topic: 'Q4 revenue' },
    models: ['gpt-4o'],
    triggeredBy: { userId: OWNER },
    ...overrides
  };
}

/**
 * Write a run summary straight through the repository, bypassing the
 * registry — how the ledger, another worker or the importer put one there.
 *
 * @param {RunSummaryRepository} summaries - Repository to write through.
 * @param {Object} fields - Summary fields.
 * @returns {Promise<Object|null>} The stored summary.
 */
function seedSummary(summaries, fields) {
  return summaries.put({
    ownerId: OWNER,
    status: WorkflowStatus.RUNNING,
    startedAt: new Date().toISOString(),
    ...fields
  });
}

describe('ExecutionRegistry: the runs namespace', () => {
  it('registers an execution as a document and reads it back translated', async () => {
    await withRegistry(async ({ registry, provider }) => {
      const returned = registry.register('wf-exec-1', metadata());
      assert.equal(returned.executionId, 'wf-exec-1', 'register() answers synchronously');
      await registry.flushWrites('wf-exec-1');

      const doc = await provider.documents.get(RUNS_NAMESPACE, 'wf-exec-1');
      assert.ok(doc, 'the execution is a document, not only a map entry');
      assert.equal(doc.ownerId, OWNER, 'indexed by its owning principal');
      assert.equal(doc.data.kind, 'workflow');
      assert.equal(doc.data.anonymous, false);
      assert.deepEqual(doc.data.refs, { executionId: 'wf-exec-1' });
      assert.deepEqual(doc.data.inputPreview, { topic: 'Q4 revenue' });

      const read = await registry.get('wf-exec-1');
      assert.equal(read.userId, OWNER, 'ownerId reads back as userId');
      assert.deepEqual(read.workflowName, { en: 'Quarterly Report' });
      assert.equal(read.completedAt, null, 'endedAt reads back as completedAt');
    });
  });

  it('derives an agent run s kind from its service-account principal', async () => {
    await withRegistry(async ({ registry, provider }) => {
      registry.register(
        'wf-exec-agent',
        metadata({ userId: 'agent:researcher', source: 'agent', triggeredBy: { userId: OWNER } })
      );
      await registry.flushWrites();
      assert.equal(
        (await provider.documents.get(RUNS_NAMESPACE, 'wf-exec-agent')).data.kind,
        'agent'
      );
      assert.equal((await registry.getAll()).length, 1);
    });
  });

  it('applies a status patch after the create that must precede it', async () => {
    // Both writes are fire-and-forget from a synchronous caller. A patch that
    // overtook the create would find no document and be dropped, and the run
    // would stay `running` in every listing.
    await withRegistry(async ({ registry, provider }) => {
      registry.register('wf-exec-2', metadata());
      registry.updateStatus('wf-exec-2', WorkflowStatus.PAUSED, {
        currentNode: 'approval',
        pendingCheckpoint: { id: 'ckpt-1', message: 'Approve?' }
      });
      registry.updateStatus('wf-exec-2', WorkflowStatus.COMPLETED);
      await registry.flushWrites();

      const doc = await provider.documents.get(RUNS_NAMESPACE, 'wf-exec-2');
      assert.equal(doc.data.status, WorkflowStatus.COMPLETED);
      assert.ok(doc.data.endedAt, 'a terminal status records when it ended');
      assert.deepEqual(doc.data.workflowName, { en: 'Quarterly Report' });
    });
  });

  it('merges with the ledger s half of the document rather than replacing it', async () => {
    // The ledger records a summary for the same run id at `run/start`, from a
    // write queue of its own. Whichever lands first, the other must not erase
    // the identity mode, the parent run, the model or the cross-references.
    await withRegistry(async ({ registry, summaries }) => {
      await summaries.merge('wf-exec-3', {
        runId: 'wf-exec-3',
        kind: 'workflow',
        ownerId: OWNER,
        identityMode: 'pseudonymized',
        parentRunId: 'wf-exec-parent',
        refs: { executionId: 'wf-exec-3', workflowId: 'quarterly-report', chatId: 'chat-7' },
        model: 'gpt-4o',
        source: 'ledger',
        status: WorkflowStatus.RUNNING,
        startedAt: new Date().toISOString()
      });

      registry.register('wf-exec-3', metadata());
      await registry.flushWrites();

      const stored = await summaries.get('wf-exec-3');
      assert.equal(stored.identityMode, 'pseudonymized', 'the ledger half survived');
      assert.equal(stored.parentRunId, 'wf-exec-parent');
      assert.equal(stored.model, 'gpt-4o');
      assert.deepEqual(stored.refs, {
        executionId: 'wf-exec-3',
        workflowId: 'quarterly-report',
        chatId: 'chat-7'
      });
      assert.deepEqual(stored.workflowName, { en: 'Quarterly Report' }, 'and so did the registry');
      assert.deepEqual(stored.inputPreview, { topic: 'Q4 revenue' });
    });
  });

  it('reads the ledger s terminal vocabulary in the registry s own words', async () => {
    await withRegistry(async ({ registry, summaries }) => {
      await seedSummary(summaries, { runId: 'wf-exec-err', kind: 'workflow', status: 'error' });
      await seedSummary(summaries, { runId: 'wf-exec-abort', kind: 'workflow', status: 'aborted' });

      assert.equal((await registry.get('wf-exec-err')).status, WorkflowStatus.FAILED);
      assert.equal((await registry.get('wf-exec-abort')).status, WorkflowStatus.CANCELLED);
      assert.deepEqual((await registry.getStats()).byStatus, {
        [WorkflowStatus.FAILED]: 1,
        [WorkflowStatus.CANCELLED]: 1
      });
      assert.equal(
        (await summaries.get('wf-exec-err')).status,
        'error',
        'the translation is on read only; the ledger reads its own words back'
      );
    });
  });
});

describe('ExecutionRegistry: the cost of a listing', () => {
  it('serves a burst of listings from one walk of the namespace', async () => {
    // `GET /api/agents/runs` is `authRequired, authenticatedOnly`, so any
    // signed-in user reaches this, and `/api/agents` is not behind the rate
    // limiter. The namespace is shared with every chat and inference run the
    // ledger records, so a listing is a walk of all of them — and the
    // docstring here used to call the scan "administrator-initiated rather
    // than per-request".
    //
    // The scan cannot be narrowed: what separates an execution from a chat run
    // is the stored `kind`, not the key and not the owner. So the repetition
    // is what is bounded.
    await withRegistry(async ({ registry, provider }) => {
      let walks = 0;
      const realScan = provider.documents.scan.bind(provider.documents);
      provider.documents.scan = function scan(ns, opts) {
        if (ns === 'runs') walks += 1;
        return realScan(ns, opts);
      };

      await Promise.all([registry.getAll(), registry.getAll(), registry.getAll()]);
      assert.equal(walks, 1, 'concurrent callers share one in-flight walk');

      await registry.getAll();
      assert.equal(walks, 1, 'and a later caller inside the window reuses it');

      provider.documents.scan = realScan;
    });
  });

  it('never serves a stale view of this process own runs', async () => {
    // The memo holds the *store* half only. A caller's own run is merged from
    // memory on every call, because serving a stale view of it would be a
    // regression against the in-memory registry this replaced — the run the
    // user just started has to appear immediately.
    await withRegistry(async ({ registry }) => {
      await registry.getAll();

      registry.register('wf-exec-fresh', {
        workflowId: 'wf-1',
        userId: 'agent:analyst',
        status: 'running',
        startedAt: new Date().toISOString(),
        source: 'agent'
      });

      const listed = await registry.getAll();
      assert.ok(
        listed.some(run => run.executionId === 'wf-exec-fresh'),
        'a run started inside the memo window is listed at once'
      );
    });
  });
});

describe('ExecutionRegistry: what belongs in an execution listing', () => {
  it('never lists the chat and inference runs that share the namespace', async () => {
    // The ledger writes a summary for every run on the installation. Without
    // the kind filter these appear in the admin executions list and its
    // counts, `getActive()` reports running chats as active workflows, and
    // the boot rescan flips them to `failed` while they are still streaming.
    await withRegistry(async ({ registry, summaries }) => {
      await seedSummary(summaries, { runId: 'chat-1', kind: 'chat' });
      await seedSummary(summaries, { runId: 'utility-1', kind: 'utility' });
      await seedSummary(summaries, { runId: 'wf-child-1', kind: 'workflow' });
      await seedSummary(summaries, {
        runId: 'wf-exec-listed',
        kind: 'workflow',
        workflowId: 'w1'
      });
      await seedSummary(summaries, {
        runId: 'agent-run-1',
        kind: 'agent',
        ownerId: 'agent:researcher'
      });

      assert.deepEqual(
        (await registry.getAll()).map(e => e.executionId).sort(),
        ['agent-run-1', 'wf-exec-listed'],
        'only workflow and agent runs, and never a planner-spawned child'
      );
      assert.deepEqual(
        (await registry.getActive()).map(e => e.executionId).sort(),
        ['agent-run-1', 'wf-exec-listed'],
        'a running chat is not an active execution'
      );
      assert.equal(await registry.get('chat-1'), null, 'and a chat run is not an execution');

      const listed = await registry.list({});
      assert.equal(listed.total, 2);
      assert.equal(listed.stats.totalExecutions, 2);
      assert.equal(listed.stats.totalUsers, 2);
      assert.deepEqual(
        (await registry.getByUser(OWNER)).map(e => e.executionId),
        ['wf-exec-listed'],
        'nor in a user s own list'
      );
    });
  });

  it('finds an owner s executions behind a thousand of their chat runs', async () => {
    // The namespace is shared and `DocumentStore` keys ascend, so `chat-…`
    // sorts before `wf-exec-…`. A bound applied before the kind filter would
    // be spent entirely on chat runs and "My Executions" would be empty for
    // any user with a few months of daily chats.
    await withRegistry(async ({ registry, summaries }) => {
      const base = Date.now();
      for (let i = 0; i < 1005; i += 1) {
        await seedSummary(summaries, {
          runId: `chat-${String(i).padStart(5, '0')}`,
          kind: 'chat',
          status: WorkflowStatus.COMPLETED,
          startedAt: new Date(base - (i + 100) * 1000).toISOString()
        });
      }
      for (let i = 0; i < 3; i += 1) {
        await seedSummary(summaries, {
          runId: `wf-exec-${i}`,
          kind: 'workflow',
          workflowId: 'w1',
          startedAt: new Date(base - i * 1000).toISOString()
        });
      }

      assert.deepEqual(
        (await registry.getByUser(OWNER)).map(e => e.executionId),
        ['wf-exec-0', 'wf-exec-1', 'wf-exec-2'],
        'newest first, and none of them lost to the chat runs'
      );
    });
  });

  it('hides archived runs by default and shows them on request', async () => {
    await withRegistry(async ({ registry, summaries }) => {
      const base = Date.now();
      await seedSummary(summaries, {
        runId: 'wf-exec-live',
        kind: 'workflow',
        workflowId: 'w1',
        startedAt: new Date(base).toISOString()
      });
      await seedSummary(summaries, {
        runId: 'wf-exec-old',
        kind: 'workflow',
        workflowId: 'w1',
        startedAt: new Date(base - 1000).toISOString()
      });

      const archived = await registry.setArchived('wf-exec-old', true);
      assert.equal(archived.archived, true, 'the archive endpoint answers with the record');

      assert.deepEqual(
        (await registry.getByUser(OWNER)).map(e => e.executionId),
        ['wf-exec-live']
      );
      assert.deepEqual(
        (await registry.getByUser(OWNER, { archived: 'only' })).map(e => e.executionId),
        ['wf-exec-old']
      );
      assert.deepEqual(
        (await registry.getByUser(OWNER, { includeArchived: true })).map(e => e.executionId),
        ['wf-exec-live', 'wf-exec-old']
      );
    });
  });

  it('searches, filters, orders and pages the admin listing', async () => {
    await withRegistry(async ({ registry, summaries }) => {
      const base = Date.now();
      await seedSummary(summaries, {
        runId: 'wf-exec-a',
        kind: 'workflow',
        workflowId: 'quarterly-report',
        workflowName: { en: 'Quarterly Report' },
        status: WorkflowStatus.COMPLETED,
        startedAt: new Date(base).toISOString()
      });
      await seedSummary(summaries, {
        runId: 'wf-exec-b',
        kind: 'workflow',
        ownerId: OTHER_OWNER,
        workflowId: 'onboarding',
        workflowName: { en: 'Onboarding' },
        startedAt: new Date(base - 1000).toISOString()
      });

      assert.deepEqual(
        (await registry.list({ status: WorkflowStatus.COMPLETED })).executions.map(
          e => e.executionId
        ),
        ['wf-exec-a']
      );
      assert.deepEqual(
        (await registry.list({ search: 'onboard' })).executions.map(e => e.executionId),
        ['wf-exec-b']
      );
      const page = await registry.list({ limit: 1, offset: 1 });
      assert.deepEqual(
        page.executions.map(e => e.executionId),
        ['wf-exec-b'],
        'newest first, then paged'
      );
      assert.equal(page.total, 2, 'total counts the matches, not the page');
      assert.equal(page.stats.totalExecutions, 2, 'and the counts describe everything');
    });
  });

  it('lists the executions paused on a checkpoint', async () => {
    await withRegistry(async ({ registry, summaries }) => {
      await seedSummary(summaries, {
        runId: 'wf-exec-paused',
        kind: 'workflow',
        status: WorkflowStatus.PAUSED,
        pendingCheckpoint: { id: 'ckpt-1', message: 'Approve?' }
      });
      await seedSummary(summaries, { runId: 'wf-exec-going', kind: 'workflow' });
      await seedSummary(summaries, {
        runId: 'chat-paused',
        kind: 'chat',
        status: WorkflowStatus.PAUSED,
        pendingCheckpoint: { id: 'ckpt-2' }
      });

      assert.deepEqual(
        (await registry.getPendingCheckpoints()).map(e => e.executionId),
        ['wf-exec-paused'],
        'and a paused chat is still not an execution'
      );
    });
  });
});

describe('ExecutionRegistry: the local record and the document', () => {
  it('lets the run this process is driving win over the stored copy', async () => {
    // The local record exists only while this process drives the execution,
    // so its queued write may not have landed yet — which is what keeps a run
    // visible in a listing taken immediately after it started.
    await withRegistry(async ({ registry, summaries }) => {
      await seedSummary(summaries, {
        runId: 'wf-exec-4',
        kind: 'workflow',
        workflowId: 'w1',
        workflowName: { en: 'Stale' },
        status: WorkflowStatus.RUNNING
      });

      registry.register('wf-exec-4', metadata());
      assert.deepEqual(
        (await registry.get('wf-exec-4')).workflowName,
        { en: 'Quarterly Report' },
        'the in-flight record answers, not the document behind it'
      );
      assert.deepEqual(
        (await registry.getByUser(OWNER)).map(e => e.executionId),
        ['wf-exec-4'],
        'and it is in the listing before its write has landed'
      );
      await registry.flushWrites();
    });
  });

  it('stops tracking a finished run, but only once its write has landed', async () => {
    await withRegistry(async ({ registry, summaries }) => {
      registry.register('wf-exec-5', metadata());
      registry.updateStatus('wf-exec-5', WorkflowStatus.COMPLETED);
      assert.equal(
        (await registry.get('wf-exec-5')).status,
        WorkflowStatus.COMPLETED,
        'still answered from memory while the write is queued'
      );

      await registry.flushWrites();
      assert.equal(registry.executions.has('wf-exec-5'), false, 'the map is bounded by what runs');
      const read = await registry.get('wf-exec-5');
      assert.equal(read.status, WorkflowStatus.COMPLETED, 'and the document answers afterwards');
      assert.equal((await summaries.get('wf-exec-5')).status, WorkflowStatus.COMPLETED);
    });
  });

  it('shows one worker s runs to another over the same directory', async () => {
    // The live bug D3 exists to fix: a run started on worker 2 used to be
    // invisible to `my-executions` served by worker 1.
    await withTwoRegistries(async (first, second) => {
      first.registry.register('wf-exec-on-worker-1', metadata());
      second.registry.register('wf-exec-on-worker-2', metadata());
      await first.registry.flushWrites();
      await second.registry.flushWrites();

      assert.deepEqual(
        (await first.registry.getByUser(OWNER)).map(e => e.executionId).sort(),
        ['wf-exec-on-worker-1', 'wf-exec-on-worker-2'],
        'each worker sees both runs'
      );
      assert.deepEqual((await second.registry.getByUser(OWNER)).map(e => e.executionId).sort(), [
        'wf-exec-on-worker-1',
        'wf-exec-on-worker-2'
      ]);
      assert.equal((await second.registry.getStats()).totalExecutions, 2);
    });
  });

  it('removes an execution from the map and the namespace', async () => {
    await withRegistry(async ({ registry, summaries }) => {
      registry.register('wf-exec-6', metadata());
      await registry.flushWrites();

      assert.equal(await registry.remove('wf-exec-6'), true);
      assert.equal(await registry.get('wf-exec-6'), null);
      assert.equal(await summaries.get('wf-exec-6'), null);
      assert.equal(await registry.remove('wf-exec-missing'), false);
    });
  });

  it('keeps working, in memory only, with no storage provider', async () => {
    const registry = new ExecutionRegistry({
      summaries: new RunSummaryRepository({ documents: null }),
      logger: recordingLogger().logger
    });
    registry.register('wf-exec-7', metadata());
    assert.equal((await registry.get('wf-exec-7')).status, WorkflowStatus.RUNNING);

    registry.updateStatus('wf-exec-7', WorkflowStatus.COMPLETED);
    await registry.flushWrites();
    assert.equal(
      (await registry.get('wf-exec-7')).status,
      WorkflowStatus.COMPLETED,
      'a terminal run stays in the map when there is nowhere to persist it'
    );
    assert.deepEqual(
      (await registry.getByUser(OWNER)).map(e => e.executionId),
      ['wf-exec-7']
    );
  });
});

describe('ExecutionRegistry: how the write reaches the document', () => {
  /**
   * A repository that records the operations the registry asks of it.
   *
   * @param {RunSummaryRepository} real - Repository to delegate to.
   * @returns {{calls: string[], store: Object}}
   */
  function recordingStore(real) {
    const calls = [];
    const at =
      name =>
      (...args) => {
        calls.push(name);
        return real[name](...args);
      };
    return {
      calls,
      store: {
        isAvailable: () => real.isAvailable(),
        get: at('get'),
        put: at('put'),
        patch: at('patch'),
        merge: at('merge'),
        remove: at('remove'),
        listAll: (...args) => real.listAll(...args),
        listByOwner: (...args) => real.listByOwner(...args)
      }
    };
  }

  it('creates the summary with one atomic upsert, never a read then a replace', async () => {
    // The document has a second writer on a queue of its own, so a create
    // that read first and replaced second would erase whatever landed in
    // between. There is no window to observe from the outside — only which
    // operation the registry asks the store for.
    await withRegistry(async ({ summaries }) => {
      const { calls, store } = recordingStore(summaries);
      const registry = new ExecutionRegistry({
        summaries: store,
        logger: recordingLogger().logger
      });

      registry.register('wf-exec-atomic', metadata());
      await registry.flushWrites();

      assert.deepEqual(calls, ['merge'], 'one upsert, and no get/put pair behind it');
      assert.equal((await summaries.get('wf-exec-atomic')).workflowId, 'quarterly-report');
    });
  });

  it('survives the ledger s write landing in the middle of its own', async () => {
    // The race staged deterministically: the ledger's queued `run/start`
    // write lands inside the registry's create, wherever the create's own
    // read-and-write boundary happens to be.
    await withRegistry(async ({ summaries }) => {
      const ledgerFields = {
        runId: 'wf-exec-interleaved',
        kind: 'workflow',
        ownerId: OWNER,
        identityMode: 'pseudonymized',
        refs: { executionId: 'wf-exec-interleaved', chatId: 'chat-11' },
        model: 'gpt-4o',
        source: 'ledger',
        status: WorkflowStatus.RUNNING,
        startedAt: new Date().toISOString()
      };
      let landed = false;
      const ledgerWrite = async () => {
        if (landed) return;
        landed = true;
        await summaries.merge('wf-exec-interleaved', ledgerFields);
      };
      const store = {
        isAvailable: () => summaries.isAvailable(),
        get: id => summaries.get(id),
        put: (...args) => summaries.put(...args),
        remove: (...args) => summaries.remove(...args),
        listAll: (...args) => summaries.listAll(...args),
        listByOwner: (...args) => summaries.listByOwner(...args),
        // An upsert is one critical section, so the only place the other
        // writer can get in is before it.
        merge: async (...args) => {
          await ledgerWrite();
          return summaries.merge(...args);
        },
        // A read-then-replace has a window between the two halves, and this
        // is what is in it.
        patch: async (...args) => {
          const result = await summaries.patch(...args);
          await ledgerWrite();
          return result;
        }
      };
      const registry = new ExecutionRegistry({
        summaries: store,
        logger: recordingLogger().logger
      });

      registry.register('wf-exec-interleaved', metadata());
      await registry.flushWrites();

      assert.equal(landed, true, 'the ledger really did write in the window');
      const stored = await summaries.get('wf-exec-interleaved');
      assert.equal(stored.identityMode, 'pseudonymized', 'the ledger half is not erased');
      assert.equal(stored.model, 'gpt-4o');
      assert.deepEqual(stored.refs, {
        executionId: 'wf-exec-interleaved',
        chatId: 'chat-11'
      });
      assert.deepEqual(stored.workflowName, { en: 'Quarterly Report' });
      assert.deepEqual(stored.inputPreview, { topic: 'Q4 revenue' });
    });
  });

  it('applies one execution s writes in the order they were made', async () => {
    // `register()` and the `updateStatus()` milliseconds behind it are both
    // fire-and-forget, so nothing but this queue orders them — and a patch
    // that overtook its create finds no document and is dropped.
    await withRegistry(async () => {
      const order = [];
      /**
       * Hold the first write open long enough that a second one would
       * overtake it if nothing ordered the two.
       *
       * @param {number} ms - Delay.
       * @returns {Promise<void>}
       */
      const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
      const store = {
        isAvailable: () => true,
        get: async () => null,
        merge: async () => {
          order.push('create:start');
          await delay(30);
          order.push('create:end');
          return {};
        },
        patch: async () => {
          order.push('update:start');
          return {};
        },
        put: async () => ({}),
        remove: async () => true,
        listAll: async () => ({ items: [], total: 0, truncated: false }),
        listByOwner: async () => ({ items: [], total: 0, truncated: false })
      };
      const registry = new ExecutionRegistry({
        summaries: store,
        logger: recordingLogger().logger
      });

      registry.register('wf-exec-ordered', metadata());
      registry.updateStatus('wf-exec-ordered', WorkflowStatus.COMPLETED);
      await registry.flushWrites();

      assert.deepEqual(
        order,
        ['create:start', 'create:end', 'update:start'],
        'the status update waits for the create it depends on'
      );
    });
  });
});

/**
 * Write one legacy `<executionId>/latest.json` under `stateDir`.
 *
 * @param {string} stateDir - Directory holding the per-execution states.
 * @param {string} executionId - Execution the state belongs to.
 * @param {Object} state - The state document.
 * @returns {Promise<void>}
 */
async function writeLegacyState(stateDir, executionId, state) {
  await fs.mkdir(path.join(stateDir, executionId), { recursive: true });
  await fs.writeFile(
    path.join(stateDir, executionId, LEGACY_STATE_FILE),
    JSON.stringify(state),
    'utf8'
  );
}

describe('ExecutionRegistry: recovery from checkpoints', () => {
  it('recovers an execution that only has a state directory, and overwrites none', async () => {
    const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), 'ihub-exec-states-'));
    const writeState = (executionId, state) => writeLegacyState(stateDir, executionId, state);
    try {
      await writeState('wf-exec-recovered', {
        executionId: 'wf-exec-recovered',
        workflowId: 'quarterly-report',
        status: WorkflowStatus.RUNNING,
        currentNodes: ['collect'],
        createdAt: new Date().toISOString(),
        data: { _workflow: { startedBy: OWNER } }
      });
      await writeState('wf-child-ignored', {
        executionId: 'wf-child-ignored',
        workflowId: 'sub',
        status: WorkflowStatus.RUNNING,
        data: { _workflow: { startedBy: OWNER } }
      });
      await writeState('wf-exec-live', {
        executionId: 'wf-exec-live',
        workflowId: 'stale-copy',
        status: WorkflowStatus.RUNNING,
        data: { _workflow: { startedBy: 'someone-else' } }
      });

      await withRegistry(
        async ({ registry, summaries }) => {
          // Already known: recovery is degraded by nature and must never
          // overwrite a record another writer put there.
          await seedSummary(summaries, {
            runId: 'wf-exec-live',
            kind: 'workflow',
            workflowId: 'quarterly-report',
            workflowName: { en: 'Quarterly Report' },
            inputPreview: { topic: 'Q4 revenue' }
          });

          await registry.loadFromDisk();

          const recovered = await registry.get('wf-exec-recovered');
          assert.equal(recovered.userId, OWNER);
          assert.equal(recovered.workflowId, 'quarterly-report');
          assert.equal(recovered.currentNode, 'collect');
          assert.equal(recovered.source, null, 'a checkpoint knows no source, and none is guessed');

          assert.equal(
            await registry.get('wf-child-ignored'),
            null,
            'a planner-spawned child is not an execution in its own right'
          );

          const untouched = await summaries.get('wf-exec-live');
          assert.deepEqual(untouched.workflowName, { en: 'Quarterly Report' });
          assert.deepEqual(untouched.inputPreview, { topic: 'Q4 revenue' });
          assert.equal(untouched.workflowId, 'quarterly-report');
        },
        { stateDir }
      );
    } finally {
      await fs.rm(stateDir, { recursive: true, force: true });
    }
  });

  it('does not overwrite a run registered while the scan was reading its state', async () => {
    // Recovery is degraded by nature — a checkpoint knows nothing about the
    // source, the input preview, the models or who triggered the run — so it
    // may only ever create a record that does not exist. The window it has to
    // guard against is its own: the record can appear between the scan's read
    // and its write, which is why the check is repeated under the write queue.
    const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), 'ihub-exec-states-race-'));
    try {
      await writeLegacyState(stateDir, 'wf-exec-appeared', {
        executionId: 'wf-exec-appeared',
        workflowId: 'stale-copy',
        status: WorkflowStatus.RUNNING,
        data: { _workflow: { startedBy: 'someone-else' } }
      });

      await withRegistry(async ({ summaries }) => {
        // The record is invisible to the scan's read and present by the time
        // it writes — another worker registering the run in between.
        let reads = 0;
        const store = {
          isAvailable: () => summaries.isAvailable(),
          get: async id => {
            reads += 1;
            return reads === 1 ? null : summaries.get(id);
          },
          put: (...args) => summaries.put(...args),
          patch: (...args) => summaries.patch(...args),
          merge: (...args) => summaries.merge(...args),
          remove: (...args) => summaries.remove(...args),
          listAll: (...args) => summaries.listAll(...args),
          listByOwner: (...args) => summaries.listByOwner(...args)
        };
        await seedSummary(summaries, {
          runId: 'wf-exec-appeared',
          kind: 'workflow',
          workflowId: 'quarterly-report',
          workflowName: { en: 'Quarterly Report' },
          inputPreview: { topic: 'Q4 revenue' }
        });

        const registry = new ExecutionRegistry({
          summaries: store,
          stateDir,
          logger: recordingLogger().logger
        });
        await registry.loadFromDisk();

        assert.ok(reads >= 2, 'the scan looked again before writing');
        const stored = await summaries.get('wf-exec-appeared');
        assert.equal(stored.workflowId, 'quarterly-report', 'the registered record stands');
        assert.deepEqual(stored.workflowName, { en: 'Quarterly Report' });
        assert.deepEqual(stored.inputPreview, { topic: 'Q4 revenue' });
      });
    } finally {
      await fs.rm(stateDir, { recursive: true, force: true });
    }
  });
});

describe('ExecutionRegistry: the principal the ledger resolved', () => {
  /**
   * Run `fn` with the ledger reporting one identity mode.
   *
   * @param {string} mode - Identity mode to report.
   * @param {() => Promise<void>} fn - Test body.
   * @returns {Promise<void>}
   */
  async function withIdentityMode(mode, fn) {
    const original = runLog.identityMode;
    runLog.identityMode = () => mode;
    try {
      await fn();
    } finally {
      runLog.identityMode = original;
    }
  }

  it('does not overwrite a pseudonymized owner with the raw user id', async () => {
    // The registry is the last writer on a document whose identity the ledger
    // has already resolved. Sending `ownerId: execution.userId` on every write
    // put the raw id into the namespace that `pseudonymized` exists to keep it
    // out of — under `identityMode: 'pseudonymized'`, in the same document —
    // and retired the owner marker for the hash, so listing by the principal
    // id that appears in the run's own events returned nothing.
    await withRegistry(async ({ registry, summaries }) => {
      const hashed = await resolvePrincipal({ id: OWNER }, { mode: 'pseudonymized' });

      // What the ledger writes at `run/start`.
      await seedSummary(summaries, {
        runId: 'wf-exec-pseudo',
        kind: 'workflow',
        ownerId: hashed.id,
        identityMode: 'pseudonymized'
      });

      registry.register('wf-exec-pseudo', metadata());
      await registry.flushWrites('wf-exec-pseudo');
      registry.updateStatus('wf-exec-pseudo', WorkflowStatus.COMPLETED);
      await registry.flushWrites('wf-exec-pseudo');

      const stored = await summaries.get('wf-exec-pseudo');
      assert.equal(stored.ownerId, hashed.id, 'the resolved principal survived');
      assert.notEqual(stored.ownerId, OWNER, 'and the raw id was not written over it');
      assert.equal(stored.identityMode, 'pseudonymized');
      // The registry's own half still landed.
      assert.equal(stored.status, WorkflowStatus.COMPLETED);
      assert.equal(stored.workflowId, metadata().workflowId);
    });
  });

  it('still seeds the owner when it is the one creating the document', async () => {
    // No ledger write came first, so there is nothing to preserve and a
    // summary with no principal would belong to nobody.
    await withRegistry(async ({ registry, summaries }) => {
      registry.register('wf-exec-seeded', metadata());
      await registry.flushWrites('wf-exec-seeded');

      const stored = await summaries.get('wf-exec-seeded');
      assert.equal(stored.ownerId, OWNER);
      assert.equal(stored.anonymous, false);
    });
  });

  it('finds a pseudonymized run when listing by the raw user id', async () => {
    // `getByUser` is handed the raw id every caller has; the document is owned
    // by the hash. Resolving before the index read is what keeps a user's own
    // history listable under that mode.
    await withIdentityMode('pseudonymized', async () => {
      await withRegistry(async ({ registry, summaries }) => {
        const hashed = await resolvePrincipal({ id: OWNER }, { mode: 'pseudonymized' });
        await seedSummary(summaries, {
          runId: 'wf-exec-listed',
          kind: 'workflow',
          ownerId: hashed.id,
          identityMode: 'pseudonymized'
        });

        const listed = await registry.getByUser(OWNER);
        assert.deepEqual(
          listed.map(execution => execution.executionId),
          ['wf-exec-listed']
        );
      });
    });
  });

  it('still finds a run indexed under the raw id, which older summaries are', async () => {
    await withIdentityMode('pseudonymized', async () => {
      await withRegistry(async ({ registry, summaries }) => {
        await seedSummary(summaries, {
          runId: 'wf-exec-legacy',
          kind: 'workflow',
          ownerId: OWNER,
          identityMode: 'pseudonymized'
        });

        const listed = await registry.getByUser(OWNER);
        assert.deepEqual(
          listed.map(execution => execution.executionId),
          ['wf-exec-legacy']
        );
      });
    });
  });
});
