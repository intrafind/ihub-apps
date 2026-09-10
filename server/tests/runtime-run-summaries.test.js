/**
 * `RunSummaryRepository` and the one-time legacy import, driven against a real
 * filesystem storage provider.
 *
 * Nothing below the repository is stubbed: every case builds a
 * `FilesystemStorageProvider` over its own `mkdtemp` directory, so the
 * document envelope, the per-owner index and the advisory file lease that
 * serializes two writers are the real ones. That matters more here than
 * anywhere else in this issue, because the store this replaces —
 * `execution-registry.json`, one file rewritten in whole by every worker from
 * its own partial map — passed every happy-path test it had and still lost
 * runs the moment two workers wrote at once. The concurrency cases below are
 * that exact race, run against two providers over one directory, which is
 * what two cluster workers on a shared volume look like.
 *
 * Contract: `RUNTIME_STORES_CONTRACT.md` §3 (the `runs` namespace), D4
 * (in-memory ordering, logged caps) and D5 (import once, idempotent,
 * never destructive).
 */
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { FilesystemStorageProvider } from '../storage/providers/filesystem/index.js';
import {
  RunSummaryRepository,
  RUNS_NAMESPACE,
  RUN_SUMMARY_FIELDS,
  normalizeRunSummary
} from '../services/runtime/RunSummaryRepository.js';
import {
  importLegacyRunSummaries,
  IMPORT_STATE_NAMESPACE,
  IMPORT_STATE_KEY
} from '../services/runtime/runSummaryImport.js';

/** One day, for building `startedAt` values that sort predictably. */
const DAY_MS = 24 * 60 * 60 * 1000;

const OWNER = 'user-1';
const OTHER_OWNER = 'user-2';

/**
 * A logger that records instead of printing, so the truncation and
 * degradation cases can assert on what was logged without a wall of JSON in
 * the runner output.
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
 * Bring up a provider and a repository over `baseDir`, creating a scratch
 * directory when none is given.
 *
 * @param {string} [baseDir] - Existing directory to re-open, for the
 *   two-writers-one-volume cases.
 * @returns {Promise<Object>} Provider, repository, captured log lines and the
 *   directory they share.
 */
async function openRepository(baseDir) {
  const dir = baseDir || (await fs.mkdtemp(path.join(os.tmpdir(), 'ihub-run-summaries-')));
  const provider = new FilesystemStorageProvider({ baseDir: dir, flushIntervalMs: 25 });
  await provider.initialize();
  const { lines, logger } = recordingLogger();
  const repository = new RunSummaryRepository({
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
 * Run `fn` with two independent providers over one directory — the shape two
 * cluster workers sharing a volume have.
 *
 * @param {(first: Object, second: Object) => Promise<void>} fn - The test body.
 * @returns {Promise<void>}
 */
async function withTwoRepositories(fn) {
  const first = await openRepository();
  const second = await openRepository(first.baseDir);
  try {
    await fn(first, second);
  } finally {
    await second.provider.shutdown();
    await first.provider.shutdown();
    await fs.rm(first.baseDir, { recursive: true, force: true });
  }
}

/**
 * A summary with every field a writer normally supplies.
 *
 * @param {Object} [overrides] - Fields to change.
 * @returns {Object} Summary input.
 */
function summary(overrides = {}) {
  return {
    runId: 'run-1',
    kind: 'chat',
    ownerId: OWNER,
    identityMode: 'default',
    anonymous: false,
    refs: { chatId: 'chat-1' },
    source: 'ledger',
    status: 'running',
    startedAt: new Date(Date.now() - DAY_MS).toISOString(),
    ...overrides
  };
}

describe('RunSummaryRepository: the runs namespace', () => {
  it('stores the documented record, owned by the run principal', async () => {
    await withRepository(async ({ repository, provider }) => {
      const stored = await repository.put(
        summary({
          workflowId: 'wf-1',
          workflowName: { en: 'Report' },
          models: ['gpt-4o'],
          triggeredBy: { userId: OWNER, kind: 'human' },
          // Not part of the record: a writer's unknown field is dropped
          // rather than stored, so every writer produces one shape.
          somethingElse: 'dropped'
        })
      );

      assert.equal(stored.runId, 'run-1');
      assert.equal(stored.ownerId, OWNER);
      assert.equal(stored.status, 'running');
      assert.deepEqual(stored.refs, { chatId: 'chat-1' });
      assert.equal(stored.archived, false);
      assert.equal(stored.updatedAt, stored.startedAt);
      assert.equal('somethingElse' in stored, false);
      assert.deepEqual(
        Object.keys(stored).filter(key => !RUN_SUMMARY_FIELDS.includes(key)),
        []
      );

      // The owner has to be on the document, not only in its body: the
      // owner-scoped list is served from the store's index, never a scan.
      const doc = await provider.documents.get(RUNS_NAMESPACE, 'run-1');
      assert.equal(doc.ownerId, OWNER);
      assert.deepEqual(await repository.get('run-1'), stored);
    });
  });

  it('merges a patch, protects the run id and never invents a record', async () => {
    await withRepository(async ({ repository }) => {
      const created = await repository.put(summary());
      const patched = await repository.patch('run-1', {
        runId: 'run-hijacked',
        status: 'completed',
        finishReason: 'stop',
        usage: { totalTokens: 42 },
        endedAt: new Date().toISOString()
      });

      assert.equal(patched.runId, 'run-1');
      assert.equal(patched.status, 'completed');
      assert.equal(patched.finishReason, 'stop');
      assert.deepEqual(patched.usage, { totalTokens: 42 });
      assert.equal(patched.startedAt, created.startedAt, 'the start time is not rewritten');
      assert.notEqual(patched.updatedAt, created.updatedAt);
      assert.equal(await repository.get('run-hijacked'), null);

      // A patch describes a change to something that started. Inventing a
      // record here would store a run with no principal.
      assert.equal(await repository.patch('run-missing', { status: 'completed' }), null);
      assert.equal(await repository.get('run-missing'), null);
    });
  });

  it('lists one owner newest-first, with the filters the execution list has', async () => {
    await withRepository(async ({ repository }) => {
      const base = Date.now();
      await repository.put(
        summary({ runId: 'run-old', startedAt: new Date(base - 3 * DAY_MS).toISOString() })
      );
      await repository.put(
        summary({
          runId: 'run-new',
          startedAt: new Date(base - DAY_MS).toISOString(),
          status: 'completed'
        })
      );
      await repository.put(
        summary({
          runId: 'run-middle',
          kind: 'workflow',
          startedAt: new Date(base - 2 * DAY_MS).toISOString()
        })
      );
      await repository.put(summary({ runId: 'run-other', ownerId: OTHER_OWNER }));
      await repository.setArchived('run-old', true);

      const page = await repository.listByOwner(OWNER);
      assert.deepEqual(
        page.items.map(item => item.runId),
        ['run-new', 'run-middle'],
        'newest first, archived hidden by default'
      );
      assert.equal(page.total, 2);
      assert.equal(page.truncated, false);

      assert.deepEqual(
        (await repository.listByOwner(OWNER, { archived: 'only' })).items.map(i => i.runId),
        ['run-old']
      );
      assert.deepEqual(
        (await repository.listByOwner(OWNER, { archived: 'all' })).items.map(i => i.runId),
        ['run-new', 'run-middle', 'run-old']
      );
      assert.deepEqual(
        (await repository.listByOwner(OWNER, { kind: 'workflow' })).items.map(i => i.runId),
        ['run-middle']
      );
      assert.deepEqual(
        (await repository.listByOwner(OWNER, { status: 'completed' })).items.map(i => i.runId),
        ['run-new']
      );

      const paged = await repository.listByOwner(OWNER, { limit: 1, offset: 1 });
      assert.deepEqual(
        paged.items.map(i => i.runId),
        ['run-middle']
      );
      assert.equal(paged.total, 2, 'total counts the matches, not the page');
      assert.deepEqual((await repository.listByOwner(null)).items, []);
    });
  });

  it('never lists an anonymous run, and never indexes it by owner', async () => {
    await withRepository(async ({ repository, provider }) => {
      const anonId = 'anon-0123456789abcdef';
      await repository.put(
        summary({ runId: anonId, ownerId: anonId, anonymous: true, identityMode: 'default' })
      );
      await repository.put(summary());

      assert.deepEqual((await repository.listByOwner(anonId)).items, []);
      assert.deepEqual((await repository.listByOwner(anonId, { archived: 'all' })).items, []);
      assert.deepEqual(
        (await repository.listAll()).items.map(i => i.runId),
        ['run-1']
      );
      assert.equal((await repository.stats()).totalExecutions, 1);

      // Still readable by id — that is how an anonymous run authorizes — but
      // unowned, so it adds no directory to the per-owner index.
      const record = await repository.get(anonId);
      assert.equal(record.anonymous, true);
      assert.equal(record.ownerId, anonId);
      assert.equal((await provider.documents.get(RUNS_NAMESPACE, anonId)).ownerId, null);
    });
  });

  it('serves the admin listing, the search and the stats across owners', async () => {
    await withRepository(async ({ repository }) => {
      const base = Date.now();
      await repository.put(
        summary({
          runId: 'wf-exec-1',
          kind: 'workflow',
          workflowId: 'quarterly-report',
          workflowName: { en: 'Quarterly Report' },
          status: 'completed',
          startedAt: new Date(base - DAY_MS).toISOString()
        })
      );
      await repository.put(
        summary({
          runId: 'wf-exec-2',
          ownerId: OTHER_OWNER,
          kind: 'workflow',
          workflowId: 'invoice-check',
          status: 'failed',
          startedAt: new Date(base - 2 * DAY_MS).toISOString()
        })
      );
      await repository.put(summary({ runId: 'run-archived', status: 'completed', archived: true }));

      const all = await repository.listAll();
      assert.deepEqual(
        all.items.map(i => i.runId).sort(),
        ['run-archived', 'wf-exec-1', 'wf-exec-2'],
        'the admin list has always shown archived runs too'
      );
      assert.deepEqual(
        (await repository.listAll({ status: 'failed' })).items.map(i => i.runId),
        ['wf-exec-2']
      );
      assert.deepEqual(
        (await repository.listAll({ search: 'QUARTERLY' })).items.map(i => i.runId),
        ['wf-exec-1'],
        'search is case-insensitive over the workflow name'
      );
      assert.deepEqual(
        (await repository.listAll({ search: OTHER_OWNER })).items.map(i => i.runId),
        ['wf-exec-2']
      );

      const stats = await repository.stats();
      assert.equal(stats.totalExecutions, 3);
      assert.equal(stats.totalUsers, 2);
      assert.equal(stats.byStatus.completed, 2);
      assert.equal(stats.byStatus.failed, 1);
    });
  });

  it('lists the runs paused on a checkpoint, newest first', async () => {
    await withRepository(async ({ repository }) => {
      const base = Date.now();
      await repository.put(
        summary({
          runId: 'wf-exec-paused-old',
          status: 'paused',
          pendingCheckpoint: { id: 'ckpt-1' },
          startedAt: new Date(base - 2 * DAY_MS).toISOString()
        })
      );
      await repository.put(
        summary({
          runId: 'wf-exec-paused-new',
          status: 'paused',
          pendingCheckpoint: { id: 'ckpt-2' },
          startedAt: new Date(base - DAY_MS).toISOString()
        })
      );
      await repository.put(summary({ runId: 'wf-exec-paused-nothing', status: 'paused' }));
      await repository.put(summary({ runId: 'wf-exec-running' }));

      assert.deepEqual(
        (await repository.getPendingCheckpoints()).map(i => i.runId),
        ['wf-exec-paused-new', 'wf-exec-paused-old']
      );
    });
  });

  it('removes a run and reports whether anything went', async () => {
    await withRepository(async ({ repository }) => {
      await repository.put(summary());
      assert.equal(await repository.remove('run-1'), true);
      assert.equal(await repository.get('run-1'), null);
      assert.equal(await repository.remove('run-1'), false);
    });
  });

  it('degrades to a no-op with no storage provider', async () => {
    const { lines, logger } = recordingLogger();
    const repository = new RunSummaryRepository({ logger });

    assert.equal(repository.isAvailable(), false);
    assert.equal(await repository.put(summary()), null);
    assert.equal(await repository.get('run-1'), null);
    assert.equal(await repository.patch('run-1', { status: 'completed' }), null);
    assert.equal(await repository.remove('run-1'), false);
    assert.deepEqual(await repository.listByOwner(OWNER), {
      items: [],
      total: 0,
      truncated: false
    });
    assert.deepEqual(await repository.listAll(), { items: [], total: 0, truncated: false });
    assert.deepEqual(await repository.stats(), {
      totalExecutions: 0,
      totalUsers: 0,
      byStatus: {}
    });
    assert.deepEqual(await repository.getPendingCheckpoints(), []);
    assert.deepEqual(
      lines.filter(line => line.level === 'error'),
      [],
      'unavailable storage is a supported state, not an error'
    );
  });

  it('refuses a run id that is not usable as a key, without throwing', async () => {
    await withRepository(async ({ repository, lines }) => {
      assert.equal(await repository.put(summary({ runId: '../escape' })), null);
      assert.equal(await repository.get('../escape'), null);
      assert.equal(await repository.remove('../escape'), false);
      assert.deepEqual(
        lines.filter(line => line.level === 'error'),
        []
      );
    });
  });
});

describe('RunSummaryRepository: concurrent writers', () => {
  it('keeps every run when two workers record runs at the same time', async () => {
    // The race the single `execution-registry.json` lost data to: each worker
    // held a different subset in memory and rewrote the whole file from it.
    await withTwoRepositories(async (first, second) => {
      const writes = [];
      for (let i = 0; i < 12; i += 1) {
        const repository = i % 2 === 0 ? first.repository : second.repository;
        writes.push(
          repository.put(
            summary({
              runId: `wf-exec-${i}`,
              ownerId: i % 3 === 0 ? OTHER_OWNER : OWNER,
              startedAt: new Date(Date.now() - i * 1000).toISOString()
            })
          )
        );
      }
      await Promise.all(writes);

      const seen = (await first.repository.listAll()).items.map(item => item.runId).sort();
      assert.equal(seen.length, 12, 'no worker erased another worker s runs');
      assert.deepEqual(seen, Array.from({ length: 12 }, (_, i) => `wf-exec-${i}`).sort());

      // Both workers see the same namespace, which the per-process registry
      // Map never managed: a run started on worker 2 was invisible to worker 1.
      const fromSecond = await second.repository.listByOwner(OWNER);
      assert.equal(fromSecond.total, 8);
      assert.deepEqual(
        fromSecond.items.map(i => i.runId),
        (await first.repository.listByOwner(OWNER)).items.map(i => i.runId)
      );
    });
  });

  it('loses no field when two workers patch one run at the same time', async () => {
    await withTwoRepositories(async (first, second) => {
      await first.repository.put(summary());

      const patches = [
        { currentNode: 'node-a' },
        { status: 'paused' },
        { model: 'gpt-4o' },
        { workflowId: 'wf-1' },
        { inputPreview: 'hello' },
        { finishReason: 'stop' },
        { identityMode: 'pseudonymized' },
        { source: 'registry' }
      ];
      await Promise.all(
        patches.map((fields, index) =>
          (index % 2 === 0 ? first.repository : second.repository).patch('run-1', fields)
        )
      );

      const record = await second.repository.get('run-1');
      for (const fields of patches) {
        const [[key, value]] = Object.entries(fields);
        assert.equal(record[key], value, `patch of ${key} survived`);
      }
      assert.equal(record.ownerId, OWNER, 'the owner survived every read-modify-write');
    });
  });

  it('serializes a delete against a concurrent patch', async () => {
    await withTwoRepositories(async (first, second) => {
      await first.repository.put(summary());
      const [, patched] = await Promise.all([
        first.repository.remove('run-1'),
        second.repository.patch('run-1', { status: 'completed' })
      ]);

      const record = await first.repository.get('run-1');
      if (patched === null) {
        // The delete won: the patch refused to resurrect the record.
        assert.equal(record, null);
      } else {
        // The patch won: the delete then removed the patched record.
        assert.equal(patched.status, 'completed');
        assert.equal(record, null);
      }
    });
  });
});

describe('normalizeRunSummary', () => {
  it('produces one closed shape whatever the writer supplies', async () => {
    const record = normalizeRunSummary({ runId: 'run-1' });
    assert.deepEqual(Object.keys(record).sort(), [...RUN_SUMMARY_FIELDS].sort());
    assert.equal(record.status, 'running', 'a summary with no status describes a start');
    assert.equal(record.updatedAt, record.startedAt);
    assert.equal(record.anonymous, false);
    assert.equal(record.archived, false);
    assert.deepEqual(record.refs, {});
    assert.deepEqual(record.models, []);
    assert.equal(normalizeRunSummary({}).runId, null, 'no key is invented');
    assert.equal(normalizeRunSummary({ runId: 'r', workflowName: 'Plain' }).workflowName, 'Plain');
    assert.deepEqual(normalizeRunSummary({ runId: 'r', workflowName: { en: 'L' } }).workflowName, {
      en: 'L'
    });
  });
});

/**
 * Write a legacy per-day ledger index file.
 *
 * @param {string} indexDir - Directory holding `<YYYY-MM-DD>.jsonl` files.
 * @param {string} day - `YYYY-MM-DD`.
 * @param {Object[]} entries - Lines to write.
 * @returns {Promise<string>} The file written.
 */
async function writeIndexFile(indexDir, day, entries) {
  await fs.mkdir(indexDir, { recursive: true });
  const file = path.join(indexDir, `${day}.jsonl`);
  await fs.writeFile(file, entries.map(entry => JSON.stringify(entry)).join('\n') + '\n', 'utf8');
  return file;
}

/**
 * Write a legacy `execution-registry.json`.
 *
 * @param {string} file - Target path.
 * @param {Object[]} executions - Registry records.
 * @returns {Promise<string>} The file written.
 */
async function writeRegistryFile(file, executions) {
  await fs.mkdir(path.dirname(file), { recursive: true });
  const body = JSON.stringify({ version: 1, savedAt: new Date().toISOString(), executions });
  await fs.writeFile(file, body, 'utf8');
  return file;
}

/**
 * A legacy installation: an index directory and a registry file, both
 * populated, plus a repository over a provider of its own.
 *
 * @param {(ctx: Object) => Promise<void>} fn - The test body.
 * @returns {Promise<void>}
 */
async function withLegacyInstall(fn) {
  const ctx = await openRepository();
  const legacyDir = await fs.mkdtemp(path.join(os.tmpdir(), 'ihub-run-legacy-'));
  const indexDir = path.join(legacyDir, 'run-log', 'index');
  const registryFile = path.join(legacyDir, 'workflow-state', 'execution-registry.json');
  try {
    await fn({ ...ctx, legacyDir, indexDir, registryFile });
  } finally {
    await ctx.provider.shutdown();
    await fs.rm(ctx.baseDir, { recursive: true, force: true });
    await fs.rm(legacyDir, { recursive: true, force: true });
  }
}

describe('importLegacyRunSummaries', () => {
  it('carries the ledger index and the execution registry into the namespace', async () => {
    await withLegacyInstall(async ({ repository, indexDir, registryFile, lines }) => {
      await writeIndexFile(indexDir, '2026-01-01', [
        {
          ts: '2026-01-01T10:00:00.000Z',
          runId: 'chat-1',
          kind: 'chat',
          principalId: OWNER,
          anonymous: false,
          refs: { chatId: 'c-1' },
          status: 'running'
        },
        {
          ts: '2026-01-01T10:05:00.000Z',
          runId: 'chat-1',
          kind: 'chat',
          principalId: OWNER,
          anonymous: false,
          status: 'completed',
          finishReason: 'stop',
          usage: { totalTokens: 12 },
          endedAt: '2026-01-01T10:05:00.000Z'
        },
        {
          ts: '2026-01-01T11:00:00.000Z',
          runId: 'anon-abcdef',
          kind: 'chat',
          principalId: 'anon-abcdef',
          anonymous: true,
          status: 'completed'
        },
        {
          ts: '2026-01-01T12:00:00.000Z',
          runId: 'chat-deleted',
          kind: 'chat',
          principalId: OWNER,
          anonymous: false,
          status: 'running'
        },
        { ts: '2026-01-01T12:30:00.000Z', runId: 'chat-deleted', deleted: true },
        'not json at all'
      ]);
      await writeIndexFile(indexDir, '2026-01-02', [
        {
          ts: '2026-01-02T09:00:00.000Z',
          runId: 'wf-exec-1',
          kind: 'workflow',
          principalId: 'p-hash-of-u2',
          anonymous: false,
          refs: { executionId: 'wf-exec-1' },
          status: 'running'
        }
      ]);
      await writeRegistryFile(registryFile, [
        {
          executionId: 'wf-exec-1',
          userId: OTHER_OWNER,
          workflowId: 'quarterly',
          workflowName: { en: 'Quarterly' },
          status: 'completed',
          startedAt: '2026-01-02T09:00:00.000Z',
          updatedAt: '2026-01-02T09:30:00.000Z',
          completedAt: '2026-01-02T09:30:00.000Z',
          source: 'ui',
          inputPreview: 'Q4 numbers',
          models: ['gpt-4o'],
          triggeredBy: { userId: OTHER_OWNER, kind: 'human' },
          archived: false
        },
        {
          executionId: 'wf-exec-agent',
          userId: 'agent:profile-7',
          workflowId: 'agent-run',
          status: 'running',
          startedAt: '2026-01-03T09:00:00.000Z',
          updatedAt: '2026-01-03T09:00:00.000Z',
          source: 'agent'
        }
      ]);

      const result = await importLegacyRunSummaries({
        repository,
        indexDir,
        registryFile,
        logger: { ...console, ...recordingLogger().logger }
      });

      assert.equal(result.ran, true);
      assert.equal(result.imported, 3, 'chat-1, wf-exec-1 and wf-exec-agent');
      assert.equal(result.truncated, false);

      const chat = await repository.get('chat-1');
      assert.equal(chat.ownerId, OWNER);
      assert.equal(chat.status, 'completed');
      assert.equal(chat.startedAt, '2026-01-01T10:00:00.000Z', 'the run/start line dates the run');
      assert.equal(chat.endedAt, '2026-01-01T10:05:00.000Z');
      assert.deepEqual(chat.refs, { chatId: 'c-1' });
      assert.deepEqual(chat.usage, { totalTokens: 12 });

      // The registry wins on every field it carries, including the owner: it
      // holds the raw user id that "my executions" lists by, while the ledger
      // may have recorded a pseudonymized principal for the same run.
      const workflow = await repository.get('wf-exec-1');
      assert.equal(workflow.ownerId, OTHER_OWNER);
      assert.equal(workflow.kind, 'workflow');
      assert.equal(workflow.status, 'completed');
      assert.deepEqual(workflow.workflowName, { en: 'Quarterly' });
      assert.equal(workflow.inputPreview, 'Q4 numbers');
      assert.deepEqual(workflow.triggeredBy, { userId: OTHER_OWNER, kind: 'human' });

      assert.equal((await repository.get('wf-exec-agent')).kind, 'agent');
      assert.equal(await repository.get('anon-abcdef'), null, 'anonymous runs are never imported');
      assert.equal(await repository.get('chat-deleted'), null, 'a tombstoned run stays deleted');
      assert.deepEqual(
        lines.filter(line => line.level === 'error'),
        []
      );
    });
  });

  it('leaves the legacy files exactly as they were', async () => {
    await withLegacyInstall(async ({ repository, indexDir, registryFile }) => {
      const indexFile = await writeIndexFile(indexDir, '2026-02-01', [
        {
          ts: '2026-02-01T10:00:00.000Z',
          runId: 'chat-2',
          kind: 'chat',
          principalId: OWNER,
          status: 'completed'
        }
      ]);
      await writeRegistryFile(registryFile, [
        {
          executionId: 'wf-exec-9',
          userId: OWNER,
          workflowId: 'wf',
          status: 'completed',
          startedAt: '2026-02-01T10:00:00.000Z'
        }
      ]);
      const before = {
        index: await fs.readFile(indexFile, 'utf8'),
        registry: await fs.readFile(registryFile, 'utf8')
      };

      await importLegacyRunSummaries({ repository, indexDir, registryFile });

      assert.equal(await fs.readFile(indexFile, 'utf8'), before.index);
      assert.equal(await fs.readFile(registryFile, 'utf8'), before.registry);
      assert.deepEqual(await fs.readdir(indexDir), ['2026-02-01.jsonl']);
    });
  });

  it('is idempotent, and never overwrites a record the live path wrote', async () => {
    await withLegacyInstall(async ({ repository, provider, indexDir, registryFile }) => {
      await writeIndexFile(indexDir, '2026-03-01', [
        {
          ts: '2026-03-01T10:00:00.000Z',
          runId: 'chat-3',
          kind: 'chat',
          principalId: OWNER,
          status: 'running'
        }
      ]);
      await writeRegistryFile(registryFile, []);

      const first = await importLegacyRunSummaries({ repository, indexDir, registryFile });
      assert.equal(first.imported, 1);

      // The marker short-circuits the whole thing on the next boot.
      const second = await importLegacyRunSummaries({ repository, indexDir, registryFile });
      assert.deepEqual(second, {
        ran: false,
        reason: 'already-imported',
        imported: 0,
        skipped: 0,
        truncated: false,
        candidates: 0
      });
      const marker = await provider.documents.get(IMPORT_STATE_NAMESPACE, IMPORT_STATE_KEY);
      assert.ok(marker.data.completedAt);

      // A forced re-import (a retry after a crash, a manual re-run) must not
      // overwrite the newer record the running server has since written.
      await repository.patch('chat-3', { status: 'completed', finishReason: 'stop' });
      const third = await importLegacyRunSummaries({
        repository,
        indexDir,
        registryFile,
        force: true
      });
      assert.equal(third.ran, true);
      assert.equal(third.imported, 0);
      assert.equal(third.skipped, 1);
      assert.equal((await repository.get('chat-3')).status, 'completed');
    });
  });

  it('imports newest-first up to the bound and says it truncated', async () => {
    await withLegacyInstall(async ({ repository, indexDir, registryFile }) => {
      await writeIndexFile(indexDir, '2026-04-01', [
        {
          ts: '2026-04-01T08:00:00.000Z',
          runId: 'chat-oldest',
          kind: 'chat',
          principalId: OWNER,
          status: 'completed'
        },
        {
          ts: '2026-04-01T09:00:00.000Z',
          runId: 'chat-newest',
          kind: 'chat',
          principalId: OWNER,
          status: 'completed'
        }
      ]);
      await writeRegistryFile(registryFile, []);

      const result = await importLegacyRunSummaries({
        repository,
        indexDir,
        registryFile,
        maxRuns: 1
      });

      assert.equal(result.imported, 1);
      assert.equal(result.truncated, true);
      assert.equal(result.candidates, 2);
      assert.ok(await repository.get('chat-newest'), 'the bound keeps the runs a user looks for');
      assert.equal(await repository.get('chat-oldest'), null);
    });
  });

  it('does nothing, and reports why, when there is nothing to read', async () => {
    await withLegacyInstall(async ({ repository, legacyDir }) => {
      const result = await importLegacyRunSummaries({
        repository,
        indexDir: path.join(legacyDir, 'missing', 'index'),
        registryFile: path.join(legacyDir, 'missing', 'execution-registry.json')
      });
      assert.equal(result.ran, true);
      assert.equal(result.imported, 0);
      assert.equal(result.candidates, 0);
    });
  });

  it('skips a truncated registry rather than failing the boot', async () => {
    await withLegacyInstall(async ({ repository, indexDir, registryFile }) => {
      await writeIndexFile(indexDir, '2026-05-01', [
        {
          ts: '2026-05-01T10:00:00.000Z',
          runId: 'chat-4',
          kind: 'chat',
          principalId: OWNER,
          status: 'completed'
        }
      ]);
      await fs.mkdir(path.dirname(registryFile), { recursive: true });
      await fs.writeFile(registryFile, '{"version":1,"executions":[{"executionId":"wf-', 'utf8');

      const result = await importLegacyRunSummaries({ repository, indexDir, registryFile });
      assert.equal(result.ran, true);
      assert.equal(result.imported, 1, 'the readable half is still carried over');
      assert.ok(await repository.get('chat-4'));
    });
  });

  it('reports unavailable storage instead of throwing', async () => {
    const result = await importLegacyRunSummaries({
      repository: new RunSummaryRepository({ logger: recordingLogger().logger }),
      indexDir: path.join(os.tmpdir(), 'ihub-does-not-exist', 'index'),
      registryFile: path.join(os.tmpdir(), 'ihub-does-not-exist', 'execution-registry.json')
    });
    assert.equal(result.ran, false);
    assert.equal(result.reason, 'storage-unavailable');
  });
});
