/**
 * The run ledger on the storage provider: `RunLog` over `RunLedgerStore`,
 * driven against a real `FilesystemStorageProvider`.
 *
 * The move must be invisible. A run's events, its sequence numbers, its
 * spilled payloads, its listing entry and its retention behaviour all have to
 * look exactly as they did when `RunLog` owned the files itself — including
 * across a restart, and including on an installation whose old per-day index
 * files are still on disk. So these cases assert the *observable* ledger
 * behaviour, and only reach for provider internals where the contract pins
 * them down: the stream naming, and the spill reference that is hashed into
 * `request/header.messagesHash` and copied into the tool message the model
 * reads.
 *
 * Contract: `RUNTIME_STORES_CONTRACT.md` §4, D1 (append stays synchronous),
 * D2 (the spill ref keeps its `path` string) and D5 (legacy data is read, not
 * rewritten).
 */
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { RUN_LOG_EVENTS } from '../../shared/runEvents.js';
import { FilesystemStorageProvider } from '../storage/providers/filesystem/index.js';
import { RunLog } from '../services/loop/RunLog.js';
import { RunLedgerStore, runStreamName } from '../services/loop/runLedgerStore.js';
import { spillRefSchema } from '../services/loop/contracts/runLogEvents.js';
import { RUNS_NAMESPACE } from '../services/runtime/RunSummaryRepository.js';

/** One day, for building retention cut-offs. */
const DAY_MS = 24 * 60 * 60 * 1000;

const USER = { id: 'u1' };

/**
 * A cluster bus that knows about no other worker.
 *
 * Two `RunLog`s in one process would otherwise announce ownership to each
 * other through the real bus and route appends over it. Silencing it forces
 * the sequence-recovery path — the one that has to hold a lock — to be what
 * the test exercises.
 *
 * @returns {Object} A bus with the four methods `RunLog` uses.
 */
function soloBus() {
  return {
    request: async () => null,
    respond: () => () => {},
    hasRemote: () => false,
    createPresenceMap: () => new Map()
  };
}

/**
 * Bring up a provider plus a `RunLog` wired to it.
 *
 * `legacyDir` is the ledger's own directory — the one it used to write
 * everything into. It is kept separate from the provider's base directory so
 * a test can tell which backend a byte landed in.
 *
 * @param {Object} [options]
 * @param {string} [options.storageDir] - Existing provider directory to re-open.
 * @param {string} [options.legacyDir] - Existing ledger directory to re-open.
 * @param {boolean} [options.withProvider=true] - Wire the provider in at all.
 * @param {Object} [options.bus] - Cluster bus override.
 * @returns {Promise<Object>} Provider, run log and both directories.
 */
async function openLedger({ storageDir, legacyDir, withProvider = true, bus } = {}) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'ihub-run-ledger-'));
  const storage = storageDir || path.join(root, 'storage');
  const legacy = legacyDir || path.join(root, 'run-log');
  let provider = null;
  if (withProvider) {
    provider = new FilesystemStorageProvider({ baseDir: storage, flushIntervalMs: 25 });
    await provider.initialize();
  }
  const runLog = new RunLog({
    baseDir: legacy,
    forceEnabled: true,
    getPlatformConfig: () => ({}),
    ...(bus ? { bus } : {}),
    ...(provider
      ? { logs: provider.logs, documents: provider.documents, locks: provider.locks }
      : {})
  });
  return { root, storageDir: storage, legacyDir: legacy, provider, runLog };
}

/**
 * Run `fn` with a ledger of its own, torn down after.
 *
 * @param {(ctx: Object) => Promise<void>} fn - The test body.
 * @param {Object} [options] - Passed to {@link openLedger}.
 * @returns {Promise<void>}
 */
async function withLedger(fn, options = {}) {
  const ctx = await openLedger(options);
  try {
    await fn(ctx);
  } finally {
    await ctx.runLog.stop();
    await ctx.provider?.shutdown();
    await fs.rm(ctx.root, { recursive: true, force: true });
  }
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
 * A `human/event` payload — the smallest schema-valid event a test can append.
 *
 * @param {string} message - Event text.
 * @returns {Object} Event data.
 */
function humanEvent(message) {
  return { kind: 'steer', message, by: 'u1', at: new Date().toISOString() };
}

describe('run ledger: events through the provider', () => {
  it('writes a run stream, reads it back in seq order and reports lastSeq', async () => {
    await withLedger(async ({ runLog, provider, storageDir, legacyDir }) => {
      const { runId } = await runLog.startRun({ kind: 'chat', user: USER });
      runLog.append(runId, RUN_LOG_EVENTS.HUMAN_EVENT, humanEvent('one'));
      runLog.append(runId, RUN_LOG_EVENTS.HUMAN_EVENT, humanEvent('two'));
      await runLog.flush();

      const events = await runLog.readEvents(runId);
      assert.deepEqual(
        events.map(event => [event.seq, event.type]),
        [
          [1, RUN_LOG_EVENTS.RUN_START],
          [2, RUN_LOG_EVENTS.HUMAN_EVENT],
          [3, RUN_LOG_EVENTS.HUMAN_EVENT]
        ]
      );
      assert.equal(await runLog.lastSeq(runId), 3);
      assert.deepEqual(
        (await runLog.readEvents(runId, { afterSeq: 1, limit: 1 })).map(e => e.seq),
        [2],
        'a slice takes the lowest sequence numbers above the cursor'
      );
      assert.equal((await runLog.readStart(runId)).type, RUN_LOG_EVENTS.RUN_START);

      // The documented stream mapping: `run:<id>` lands under `logs/run/`.
      assert.equal(
        await exists(path.join(storageDir, 'logs', 'run', `${runId}.jsonl`)),
        true,
        'the events are in the provider'
      );
      assert.equal(
        await exists(path.join(legacyDir, 'runs', `${runId}.jsonl`)),
        false,
        'and no longer in the ledger directory'
      );
      assert.deepEqual(await provider.logs.read(runStreamName(runId), { afterSeq: 2 }), [
        events[2]
      ]);
    });
  });

  it('keeps append() synchronous and returns the event it just sequenced', async () => {
    // D1: the SSE projection reads `seq` off the return value, and every
    // caller is a fire-and-forget statement. Persisting must not change that.
    await withLedger(async ({ runLog }) => {
      const { runId } = await runLog.startRun({ kind: 'chat', user: USER });
      const event = runLog.append(runId, RUN_LOG_EVENTS.HUMAN_EVENT, humanEvent('now'));
      assert.equal(typeof event.then, 'undefined', 'append returns an event, never a promise');
      assert.equal(event.seq, 2);
      assert.equal(event.runId, runId);

      const seen = [];
      runLog.subscribe(runId, e => seen.push(e.seq));
      runLog.append(runId, RUN_LOG_EVENTS.HUMAN_EVENT, humanEvent('and now'));
      assert.deepEqual(seen, [3], 'subscribers are notified inline, before any I/O');
      await runLog.flush();
      assert.equal(await runLog.lastSeq(runId), 3);
    });
  });

  it('continues a run s sequence after a restart', async () => {
    const first = await openLedger();
    let runId;
    try {
      ({ runId } = await first.runLog.startRun({ kind: 'chat', user: USER }));
      first.runLog.append(runId, RUN_LOG_EVENTS.HUMAN_EVENT, humanEvent('before'));
      await first.runLog.flush();
    } finally {
      await first.runLog.stop();
      await first.provider.shutdown();
    }

    // A fresh provider over the same directory is what a restart looks like.
    const second = await openLedger({
      storageDir: first.storageDir,
      legacyDir: first.legacyDir
    });
    try {
      assert.equal(await second.runLog.lastSeq(runId), 2, 'lastSeq survives the restart');
      await second.runLog.resumeRun(runId, { kind: 'chat' });
      const event = second.runLog.append(runId, RUN_LOG_EVENTS.HUMAN_EVENT, humanEvent('after'));
      assert.equal(event.seq, 3, 'the resumed worker never re-allocates a sequence number');
      await second.runLog.flush();
      assert.deepEqual(
        (await second.runLog.readEvents(runId)).map(e => e.seq),
        [1, 2, 3]
      );
    } finally {
      await second.runLog.stop();
      await second.provider.shutdown();
      await fs.rm(first.root, { recursive: true, force: true });
      await fs.rm(second.root, { recursive: true, force: true });
    }
  });

  it('allocates one sequence per event when two workers recover a run at once', async () => {
    // Neither worker owns the run, so both take the recovery path: flush,
    // read the persisted last sequence, allocate. Without the lease around
    // that read-and-append, both would allocate the same number and the
    // append-only ledger would end up with two events sharing a seq.
    const owner = await openLedger({ bus: soloBus() });
    const { runId } = await owner.runLog.startRun({ kind: 'chat', user: USER });
    await owner.runLog.flush();

    const workers = [];
    for (let i = 0; i < 3; i += 1) {
      workers.push(
        await openLedger({
          storageDir: owner.storageDir,
          legacyDir: owner.legacyDir,
          bus: soloBus()
        })
      );
    }

    try {
      const events = await Promise.all(
        workers.map((worker, index) =>
          worker.runLog.appendRecovered(runId, RUN_LOG_EVENTS.HUMAN_EVENT, humanEvent(`w${index}`))
        )
      );

      const seqs = events.map(event => event.seq).sort((a, b) => a - b);
      assert.deepEqual(seqs, [2, 3, 4], 'every recovering worker got a sequence of its own');

      const persisted = await owner.runLog.readEvents(runId);
      assert.deepEqual(
        persisted.map(event => event.seq),
        [1, 2, 3, 4],
        'and the persisted stream has no duplicate and no gap'
      );
    } finally {
      for (const worker of workers) {
        await worker.runLog.stop();
        await worker.provider.shutdown();
        await fs.rm(worker.root, { recursive: true, force: true });
      }
      await owner.runLog.stop();
      await owner.provider.shutdown();
      await fs.rm(owner.root, { recursive: true, force: true });
    }
  });

  it('behaves exactly as before when no provider is available', async () => {
    await withLedger(
      async ({ runLog, legacyDir }) => {
        const { runId } = await runLog.startRun({ kind: 'chat', user: USER });
        runLog.append(runId, RUN_LOG_EVENTS.HUMAN_EVENT, humanEvent('offline'));
        await runLog.flush();

        assert.equal(await exists(path.join(legacyDir, 'runs', `${runId}.jsonl`)), true);
        assert.deepEqual(
          (await runLog.readEvents(runId)).map(e => e.type),
          [RUN_LOG_EVENTS.RUN_START, RUN_LOG_EVENTS.HUMAN_EVENT]
        );
        assert.equal(await runLog.lastSeq(runId), 2);
        assert.equal((await runLog.readStart(runId)).data.principal.id, 'u1');

        const [listed] = await runLog.listRuns({});
        assert.equal(listed.runId, runId);
        assert.equal(listed.principalId, 'u1');

        const files = await fs.readdir(path.join(legacyDir, 'index'));
        assert.equal(files.length, 1, 'the per-day index is still written');
      },
      { withProvider: false }
    );
  });
});

describe('run ledger: spill references', () => {
  it('keeps the legacy path string while storing the payload as a blob', async () => {
    await withLedger(async ({ runLog, provider, storageDir, legacyDir }) => {
      const { runId } = await runLog.startRun({ kind: 'chat', user: USER });
      const ref = await runLog.spill(runId, 'tool-result.json', { rows: [1, 2, 3] });

      // D2: the reference is schema-validated, copied into the tool message
      // the model reads and hashed into `request/header.messagesHash`, so its
      // shape is part of the contract, not an implementation detail.
      assert.deepEqual(Object.keys(ref).sort(), ['bytes', 'contentType', 'path', 'sha256']);
      assert.equal(ref.path, `spill/${runId}/tool-result.json`);
      assert.equal(ref.contentType, 'application/json');
      assert.equal(ref.bytes, Buffer.byteLength(JSON.stringify({ rows: [1, 2, 3] }), 'utf8'));
      assert.doesNotThrow(() => spillRefSchema.parse(ref));

      assert.equal(await runLog.readSpill(runId, ref), JSON.stringify({ rows: [1, 2, 3] }));
      assert.ok(await provider.logs.getBlob(runStreamName(runId), 'tool-result.json'));
      assert.equal(
        await exists(path.join(storageDir, 'logs', 'run', `${runId}.blobs`)),
        true,
        'the payload is a provider blob'
      );
      assert.equal(
        await exists(path.join(legacyDir, 'spill', runId)),
        false,
        'and not a file in the ledger directory'
      );
    });
  });

  it('sanitizes a hostile spill name and refuses a forged reference', async () => {
    await withLedger(async ({ runLog }) => {
      const { runId } = await runLog.startRun({ kind: 'chat', user: USER });
      const ref = await runLog.spill(runId, '../../etc/passwd', 'payload');

      assert.equal(ref.path.startsWith(`spill/${runId}/`), true);
      assert.equal(ref.path.split('/').length, 3, 'the name stays one path segment');
      assert.equal(await runLog.readSpill(runId, ref), 'payload');

      await assert.rejects(runLog.readSpill(runId, { path: '../../../etc/passwd' }));
      await assert.rejects(runLog.readSpill(runId, { path: '..' }), /Invalid spill reference/);
    });
  });

  it('spills to the ledger directory when there is no provider', async () => {
    await withLedger(
      async ({ runLog, legacyDir }) => {
        const { runId } = await runLog.startRun({ kind: 'chat', user: USER });
        const ref = await runLog.spill(runId, 'payload.json', '{"a":1}');
        assert.equal(ref.path, path.join('spill', runId, 'payload.json'));
        assert.equal(await runLog.readSpill(runId, ref), '{"a":1}');
        assert.equal(await exists(path.join(legacyDir, 'spill', runId, 'payload.json')), true);
      },
      { withProvider: false }
    );
  });
});

describe('run ledger: run summaries replace the per-day index', () => {
  it('records a start and patches the end into the runs namespace', async () => {
    await withLedger(async ({ runLog, provider, legacyDir }) => {
      const { runId } = await runLog.startRun({
        kind: 'chat',
        user: USER,
        refs: { chatId: 'chat-9' },
        model: 'gpt-4o'
      });
      await runLog.flush();

      const started = await provider.documents.get(RUNS_NAMESPACE, runId);
      assert.equal(started.ownerId, 'u1');
      assert.equal(started.data.status, 'running');
      assert.equal(started.data.kind, 'chat');
      assert.equal(started.data.model, 'gpt-4o');
      assert.deepEqual(started.data.refs, { chatId: 'chat-9' });

      runLog.append(runId, RUN_LOG_EVENTS.RUN_END, {
        status: 'completed',
        finishReason: 'stop',
        usage: { promptTokens: 1, completionTokens: 2, totalTokens: 3 }
      });
      await runLog.flush();

      const ended = await provider.documents.get(RUNS_NAMESPACE, runId);
      assert.equal(ended.data.status, 'completed');
      assert.equal(ended.data.finishReason, 'stop');
      assert.equal(ended.data.usage.totalTokens, 3);
      assert.ok(ended.data.endedAt);
      assert.equal(
        await exists(path.join(legacyDir, 'index')),
        false,
        'a fresh installation never grows a per-day index'
      );

      const [listed] = await runLog.listRuns({});
      assert.equal(listed.runId, runId);
      assert.equal(listed.principalId, 'u1');
      assert.equal(listed.status, 'completed');
      assert.equal(listed.finishReason, 'stop');
      assert.deepEqual(listed.refs, { chatId: 'chat-9' });
    });
  });

  it('never lists an anonymous run', async () => {
    await withLedger(async ({ runLog }) => {
      const { runId, anonymous } = await runLog.startRun({ kind: 'chat', user: null });
      assert.equal(anonymous, true);
      runLog.append(runId, RUN_LOG_EVENTS.RUN_END, { status: 'completed', finishReason: 'stop' });
      await runLog.flush();

      assert.deepEqual(await runLog.listRuns({}), []);
      assert.equal((await runLog.readStart(runId)).data.principal.anonymous, true);
    });
  });

  it('lists a half-imported installation: the namespace and the legacy index', async () => {
    // The sharpest upgrade case. The import is bounded and idempotent, so an
    // installation can sit half way through it — and must not look empty.
    await withLedger(async ({ runLog, legacyDir }) => {
      const indexDir = path.join(legacyDir, 'index');
      await fs.mkdir(indexDir, { recursive: true });
      await fs.writeFile(
        path.join(indexDir, '2026-01-01.jsonl'),
        [
          JSON.stringify({
            ts: '2026-01-01T10:00:00.000Z',
            runId: 'chat-legacy',
            kind: 'chat',
            principalId: 'u1',
            anonymous: false,
            refs: { chatId: 'old' },
            status: 'running'
          }),
          JSON.stringify({
            ts: '2026-01-01T10:01:00.000Z',
            runId: 'chat-legacy-deleted',
            kind: 'chat',
            principalId: 'u1',
            status: 'running'
          }),
          JSON.stringify({
            ts: '2026-01-01T10:02:00.000Z',
            runId: 'chat-legacy-deleted',
            deleted: true
          })
        ].join('\n') + '\n',
        'utf8'
      );

      const { runId } = await runLog.startRun({ kind: 'chat', user: USER });
      await runLog.flush();

      const listed = await runLog.listRuns({});
      const ids = listed.map(entry => entry.runId).sort();
      assert.deepEqual(ids, [runId, 'chat-legacy'].sort(), 'both halves are listed');
      assert.equal(
        listed.some(entry => entry.runId === 'chat-legacy-deleted'),
        false,
        'and the legacy tombstone still hides its run'
      );

      const legacy = listed.find(entry => entry.runId === 'chat-legacy');
      assert.equal(legacy.principalId, 'u1');
      assert.deepEqual(legacy.refs, { chatId: 'old' });
      assert.deepEqual(
        (await runLog.listRuns({ principalId: 'u1' })).map(e => e.runId).sort(),
        ids
      );
      assert.deepEqual(
        (await runLog.listRuns({ from: '2026-01-01', to: '2026-01-01' })).map(e => e.runId),
        ['chat-legacy'],
        'the day range still filters the legacy half'
      );
    });
  });

  it('ends a run that started before the namespace existed', async () => {
    await withLedger(async ({ runLog, legacyDir }) => {
      const indexDir = path.join(legacyDir, 'index');
      await fs.mkdir(indexDir, { recursive: true });
      await fs.writeFile(
        path.join(indexDir, '2026-01-01.jsonl'),
        JSON.stringify({
          ts: '2026-01-01T10:00:00.000Z',
          runId: 'chat-in-flight',
          kind: 'chat',
          principalId: 'u1',
          anonymous: false,
          status: 'running'
        }) + '\n',
        'utf8'
      );

      await runLog.resumeRun('chat-in-flight', { kind: 'chat' });
      runLog.append('chat-in-flight', RUN_LOG_EVENTS.RUN_END, {
        status: 'completed',
        finishReason: 'stop'
      });
      await runLog.flush();

      const [listed] = await runLog.listRuns({});
      assert.equal(listed.runId, 'chat-in-flight');
      assert.equal(
        listed.status,
        'completed',
        'a run in flight across the upgrade does not stay running for ever'
      );
    });
  });
});

describe('run ledger: deletion and retention', () => {
  it('deletes a run s events, blobs and summary, and runs the cascade hooks', async () => {
    await withLedger(async ({ runLog, provider }) => {
      const { runId } = await runLog.startRun({ kind: 'chat', user: USER });
      runLog.append(runId, RUN_LOG_EVENTS.HUMAN_EVENT, humanEvent('hello'));
      const ref = await runLog.spill(runId, 'payload.json', '{"a":1}');
      await runLog.flush();

      const cascaded = [];
      runLog.onDelete(id => {
        cascaded.push(id);
        return 'interactions';
      });

      const result = await runLog.deleteRun(runId);
      assert.equal(result.deleted, true);
      assert.deepEqual(cascaded, [runId]);
      assert.equal(result.cascaded.includes('interactions'), true);

      assert.deepEqual(await runLog.readEvents(runId), []);
      assert.equal(await provider.documents.get(RUNS_NAMESPACE, runId), null);
      assert.equal(await provider.logs.getBlob(runStreamName(runId), 'payload.json'), null);
      await assert.rejects(runLog.readSpill(runId, ref));
      assert.deepEqual(await runLog.listRuns({}), []);
    });
  });

  it('sweeps runs past the retention window and leaves recent ones alone', async () => {
    await withLedger(async ({ runLog, provider }) => {
      const { runId: oldRun } = await runLog.startRun({ kind: 'chat', user: USER });
      runLog.append(oldRun, RUN_LOG_EVENTS.RUN_END, { status: 'completed', finishReason: 'stop' });
      const { runId: freshRun } = await runLog.startRun({ kind: 'chat', user: USER });
      runLog.append(freshRun, RUN_LOG_EVENTS.HUMAN_EVENT, humanEvent('still going'));
      await runLog.flush();

      // Age the old run by rewriting its summary timestamps: retention judges
      // a run by when it was last touched, not by a file's mtime.
      const aged = new Date(Date.now() - 100 * DAY_MS).toISOString();
      await provider.documents.put(
        RUNS_NAMESPACE,
        oldRun,
        {
          ...(await provider.documents.get(RUNS_NAMESPACE, oldRun)).data,
          startedAt: aged,
          updatedAt: aged,
          endedAt: aged
        },
        { ownerId: 'u1' }
      );

      const cascaded = [];
      runLog.onDelete(id => cascaded.push(id));

      const { removed } = await runLog.cleanup(30);
      assert.equal(removed >= 1, true);
      assert.deepEqual(cascaded, [oldRun], 'the cascade runs for exactly the swept run');
      assert.equal(await provider.documents.get(RUNS_NAMESPACE, oldRun), null);
      assert.deepEqual(await runLog.readEvents(oldRun), []);

      assert.ok(await provider.documents.get(RUNS_NAMESPACE, freshRun));
      assert.equal((await runLog.readEvents(freshRun)).length, 2);
      assert.deepEqual(
        (await runLog.listRuns({})).map(entry => entry.runId),
        [freshRun]
      );

      assert.deepEqual(await runLog.cleanup(0), { removed: 0 }, 'retention is disabled at <= 0');
      assert.deepEqual(await runLog.cleanup(-1), { removed: 0 });
      assert.ok(await provider.documents.get(RUNS_NAMESPACE, freshRun));
    });
  });
});

describe('RunLedgerStore: the persistence half on its own', () => {
  it('reads a run that only the legacy directory has', async () => {
    // What every installation looks like immediately after the upgrade: the
    // provider is up, but the events on disk were written by the old code.
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'ihub-run-ledger-store-'));
    const provider = new FilesystemStorageProvider({
      baseDir: path.join(root, 'storage'),
      flushIntervalMs: 25
    });
    await provider.initialize();
    const legacyDir = path.join(root, 'run-log');
    try {
      await fs.mkdir(path.join(legacyDir, 'runs'), { recursive: true });
      await fs.writeFile(
        path.join(legacyDir, 'runs', 'chat-old.jsonl'),
        [
          JSON.stringify({
            seq: 1,
            ts: '2026-01-01T10:00:00.000Z',
            runId: 'chat-old',
            type: RUN_LOG_EVENTS.RUN_START,
            data: { kind: 'chat', principal: { id: 'u1', mode: 'default', anonymous: false } }
          }),
          JSON.stringify({
            seq: 2,
            ts: '2026-01-01T10:00:01.000Z',
            runId: 'chat-old',
            type: RUN_LOG_EVENTS.HUMAN_EVENT,
            data: humanEvent('legacy')
          })
        ].join('\n') + '\n',
        'utf8'
      );
      await fs.mkdir(path.join(legacyDir, 'spill', 'chat-old'), { recursive: true });
      await fs.writeFile(
        path.join(legacyDir, 'spill', 'chat-old', 'old.json'),
        '{"legacy":true}',
        'utf8'
      );

      const store = new RunLedgerStore({
        baseDir: legacyDir,
        logs: provider.logs,
        documents: provider.documents,
        locks: provider.locks
      });
      try {
        assert.equal((await store.readEvents('chat-old')).length, 2);
        assert.equal(await store.lastSeq('chat-old'), 2);
        assert.equal((await store.readStart('chat-old')).data.principal.id, 'u1');
        assert.equal((await store.lastEvent('chat-old')).seq, 2);
        assert.equal(
          await store.readSpill('chat-old', { path: 'spill/chat-old/old.json' }),
          '{"legacy":true}',
          'a payload spilled before the move is still readable'
        );

        const { deleted } = await store.deleteRun('chat-old');
        assert.equal(deleted, true);
        assert.deepEqual(await store.readEvents('chat-old'), []);
      } finally {
        await store.flush();
        store.stop();
      }
    } finally {
      await provider.shutdown();
      await fs.rm(root, { recursive: true, force: true });
    }
  });
});
