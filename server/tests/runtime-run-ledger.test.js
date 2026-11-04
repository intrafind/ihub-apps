// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * The run ledger on the storage provider: `RunLog` over `RunLedgerStore`,
 * driven against a real `FilesystemStorageProvider`.
 *
 * The move must be invisible. A run's events, its sequence numbers, its
 * spilled payloads, its listing entry and its retention behaviour all have to
 * look exactly as they did when `RunLog` owned the files itself — including
 * across a restart, and So these cases assert the *observable* ledger
 * behaviour, and only reach for provider internals where the contract pins
 * them down: the stream naming, and the spill reference that is hashed into
 * `request/header.messagesHash` and copied into the tool message the model
 * reads.
 *
 * Contract: `RUNTIME_STORES_CONTRACT.md` §4, D1 (append stays synchronous),
 * D2 (the spill ref keeps its `path` string).
 */
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { RUN_LOG_EVENTS } from '../../shared/runEvents.js';
import { FilesystemStorageProvider } from '../storage/providers/filesystem/index.js';
import { RunLog } from '../services/loop/RunLog.js';
import { RunLedgerStore, runStreamName, runLockName } from '../services/loop/runLedgerStore.js';
import { LockTimeoutError } from '../storage/errors.js';
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
 * @param {Object} [options]
 * @param {string} [options.storageDir] - Existing provider directory to re-open.
 * @param {Object} [options.bus] - Cluster bus override.
 * @returns {Promise<Object>} Provider, run log and the directory.
 */
async function openLedger({ storageDir, bus } = {}) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'ihub-run-ledger-'));
  const storage = storageDir || path.join(root, 'storage');
  const provider = new FilesystemStorageProvider({ baseDir: storage, flushIntervalMs: 25 });
  await provider.initialize();
  const runLog = new RunLog({
    forceEnabled: true,
    getPlatformConfig: () => ({}),
    ...(bus ? { bus } : {}),
    logs: provider.logs,
    documents: provider.documents,
    locks: provider.locks
  });
  return { root, storageDir: storage, provider, runLog };
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
    await ctx.provider.shutdown();
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
    await withLedger(async ({ runLog, provider, storageDir }) => {
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
      storageDir: first.storageDir
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
});

describe('run ledger: spill references', () => {
  it('keeps the legacy path string while storing the payload as a blob', async () => {
    await withLedger(async ({ runLog, provider, storageDir }) => {
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
});

describe('run ledger: run summaries replace the per-day index', () => {
  it('records a start and patches the end into the runs namespace', async () => {
    await withLedger(async ({ runLog, provider }) => {
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

      const [listed] = await runLog.listRuns({});
      assert.equal(listed.runId, runId);
      assert.equal(listed.principalId, 'u1');
      assert.equal(listed.status, 'completed');
      assert.equal(listed.finishReason, 'stop');
      assert.deepEqual(listed.refs, { chatId: 'chat-9' });
    });
  });

  it('records the end of a run that started and finished in the same tick', async () => {
    // The `put` at run/start and the `patch` at run/end are both queued from
    // synchronous callers, and the patch deliberately refuses to invent a
    // document. A patch that overtook its put would therefore be dropped and
    // the run would stay `running` in every listing for ever — so the start
    // and the end are written here with no flush in between, which is the
    // shape of any short chat or utility run.
    await withLedger(async ({ runLog, provider }) => {
      for (let attempt = 0; attempt < 5; attempt += 1) {
        const { runId } = await runLog.startRun({ kind: 'chat', user: USER });
        runLog.append(runId, RUN_LOG_EVENTS.RUN_END, {
          status: 'completed',
          finishReason: 'stop'
        });
        await runLog.flush();

        const doc = await provider.documents.get(RUNS_NAMESPACE, runId);
        assert.ok(doc, `attempt ${attempt}: the summary exists`);
        assert.equal(doc.data.status, 'completed', `attempt ${attempt}: the end was not lost`);
        assert.ok(doc.data.endedAt, `attempt ${attempt}: endedAt is recorded`);
        assert.equal(doc.data.ownerId, 'u1', `attempt ${attempt}: the owner survived`);
        assert.deepEqual(
          (await runLog.listRuns({})).map(entry => entry.status),
          ['completed'],
          `attempt ${attempt}: and the listing agrees`
        );
        await runLog.deleteRun(runId);
      }
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

  it('a late append does not put a deleted run back on disk', async () => {
    // Deleting a run unlinks its stream and its spill blobs, but the turn that
    // was writing them does not stop at the same instant: the abort the delete
    // route sends is answered asynchronously and its own `run/end` lands
    // afterwards. `append` re-registers an unknown run rather than dropping
    // the event, which re-created the stream file and the blob directory the
    // delete had just removed — unreferenced and unreachable, and so beyond
    // any later delete, until the 90-day mtime sweep. For a delete the UI
    // describes as removing the conversation for good, that is the wrong
    // postcondition.
    await withLedger(async ({ runLog, provider }) => {
      const { runId } = await runLog.startRun({ kind: 'chat', user: USER });
      runLog.append(runId, 'message/assistant', { step: 0, content: 'half an answer' });
      await runLog.flush();

      await runLog.deleteRun(runId);
      assert.deepEqual(await runLog.readEvents(runId), []);

      // What the turn does on its way out, after the delete has landed.
      runLog.append(runId, 'message/assistant', { step: 0, content: 'the rest of it' });
      runLog.endRun(runId, { status: 'aborted', finishReason: 'aborted' });
      await runLog.flush();

      assert.deepEqual(await runLog.readEvents(runId), [], 'the stream stayed deleted');
      assert.equal(
        await provider.logs.getBlob(runStreamName(runId), 'payload.json'),
        null,
        'and so did its blobs'
      );
    });
  });

  it('sweeps an anonymous run: its summary goes and its cascade runs', async () => {
    // Anonymous runs are hidden from every listing, and the retention sweep
    // is driven by that same listing. Inheriting the filter would leave one
    // document per anonymous chat behind for ever — and, because the id never
    // reaches the cascade, the interactions those runs raised would never be
    // reclaimed while their events were swept out underneath them.
    await withLedger(async ({ runLog, provider }) => {
      const anon = await runLog.startRun({ kind: 'chat', user: null });
      assert.equal(anon.anonymous, true);
      runLog.append(anon.runId, RUN_LOG_EVENTS.RUN_END, {
        status: 'completed',
        finishReason: 'stop'
      });
      const { runId: named } = await runLog.startRun({ kind: 'chat', user: USER });
      runLog.append(named, RUN_LOG_EVENTS.RUN_END, { status: 'completed', finishReason: 'stop' });
      await runLog.flush();

      const aged = new Date(Date.now() - 400 * DAY_MS).toISOString();
      for (const runId of [anon.runId, named]) {
        const doc = await provider.documents.get(RUNS_NAMESPACE, runId);
        await provider.documents.put(
          RUNS_NAMESPACE,
          runId,
          { ...doc.data, startedAt: aged, updatedAt: aged, endedAt: aged },
          { ownerId: doc.ownerId }
        );
      }

      const cascaded = [];
      runLog.onDelete(id => cascaded.push(id));

      await runLog.cleanup(90);

      assert.equal(
        await provider.documents.get(RUNS_NAMESPACE, anon.runId),
        null,
        'the anonymous summary is gone, not only its events'
      );
      assert.equal(await provider.documents.get(RUNS_NAMESPACE, named), null);
      assert.deepEqual(
        cascaded.sort(),
        [anon.runId, named].sort(),
        'and the delete cascade ran for the anonymous run too'
      );
    });
  });

  it('sweeps a stream whose run was never summarized', async () => {
    // `append()` registers an unknown run lazily, so a stream can exist with
    // no summary — and the summary-driven pass cannot reach it. `logs.sweep`
    // is the only thing that ages those out; without it they accumulate in
    // `logs/run/` for the life of the installation.
    await withLedger(async ({ runLog, provider, storageDir }) => {
      const runId = 'run-never-started';
      runLog.append(runId, RUN_LOG_EVENTS.HUMAN_EVENT, humanEvent('orphan'));
      await runLog.flush();

      const streamFile = path.join(storageDir, 'logs', 'run', `${runId}.jsonl`);
      assert.equal(await exists(streamFile), true);
      assert.equal(
        await provider.documents.get(RUNS_NAMESPACE, runId),
        null,
        'the run has no summary to drive retention from'
      );

      const aged = new Date(Date.now() - 100 * DAY_MS);
      await fs.utimes(streamFile, aged, aged);

      const { removed } = await runLog.cleanup(90);
      assert.equal(removed >= 1, true);
      assert.equal(await exists(streamFile), false);
      assert.equal(await provider.logs.lastSeq(runStreamName(runId)), 0);
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

  it('leaves an old execution that has not finished, and takes one that has', async () => {
    // A workflow or agent summary *is* the execution registry record now, so
    // sweeping it on age alone reclaims the execution. A run paused on a human
    // node with no timeout never becomes terminal, so `workflowRetention`
    // deliberately spares it at 30 days — and then this sweep deleted it at
    // 90, cascading away its pending interaction, while its `workflow-state`
    // document survived forever because nothing looks at a state that is not
    // running. The run simply vanished, with nothing left to act on it.
    await withLedger(async ({ runLog, provider }) => {
      const aged = new Date(Date.now() - 100 * DAY_MS).toISOString();
      for (const [runId, status] of [
        ['wf-exec-paused', 'paused'],
        ['wf-exec-running', 'running'],
        ['wf-exec-done', 'completed'],
        ['chat-aged', 'running']
      ]) {
        await provider.documents.put(
          RUNS_NAMESPACE,
          runId,
          {
            runId,
            kind: runId.startsWith('wf-') ? 'workflow' : 'chat',
            ownerId: 'u1',
            anonymous: false,
            status,
            startedAt: aged,
            updatedAt: aged,
            endedAt: aged
          },
          { ownerId: 'u1' }
        );
      }

      await runLog.cleanup(30);

      assert.ok(
        await provider.documents.get(RUNS_NAMESPACE, 'wf-exec-paused'),
        "a paused execution is still somebody's to finish"
      );
      assert.ok(
        await provider.documents.get(RUNS_NAMESPACE, 'wf-exec-running'),
        'and so is a running one'
      );
      assert.equal(
        await provider.documents.get(RUNS_NAMESPACE, 'wf-exec-done'),
        null,
        'a finished execution ages out as before'
      );
      assert.equal(
        await provider.documents.get(RUNS_NAMESPACE, 'chat-aged'),
        null,
        'and a chat run is history, which ages out whatever its status says'
      );
    });
  });
});

describe('RunLedgerStore: the persistence half on its own', () => {
  it('runs the critical section anyway when the run lock times out', async () => {
    // The recovery path warns and continues when it cannot take the lock: refusing to append
    // an answer because a peer is slow would lose the event outright — the
    // answer happened, but the run's history would say it did not.
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'ihub-run-lock-'));
    const asked = [];
    const failWith = error => ({
      withLock: name => {
        asked.push(name);
        return Promise.reject(error);
      }
    });
    const timingOut = new RunLedgerStore({
      locks: failWith(new LockTimeoutError('lease not acquired', 'runlog:chat-contended'))
    });
    const broken = new RunLedgerStore({
      locks: failWith(new Error('the lock manager is broken'))
    });
    try {
      assert.equal(
        await timingOut.withRunLock('chat-contended', () => 'appended'),
        'appended',
        'a lease this worker could not take does not cost the event'
      );
      assert.deepEqual(asked, [runLockName('chat-contended')]);

      let ran = false;
      await assert.rejects(
        broken.withRunLock('chat-broken', () => {
          ran = true;
        }),
        /the lock manager is broken/,
        'while any other lock failure still propagates'
      );
      assert.equal(ran, false, 'and the section does not run behind it');
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it('contributes its half of a summary the execution registry co-owns', async () => {
    // For a workflow or agent run the execution id *is* the run id, so the
    // registry writes the same document from a queue of its own. The ledger
    // owns `identityMode`, `parentRunId`, `refs` and `model`; replacing the
    // document would leave the admin list showing "Unknown Workflow" with no
    // input preview, and would drop the human who triggered an agent run.
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'ihub-run-ledger-summary-'));
    const provider = new FilesystemStorageProvider({
      baseDir: path.join(root, 'storage'),
      flushIntervalMs: 25
    });
    await provider.initialize();
    const store = new RunLedgerStore({
      logs: provider.logs,
      documents: provider.documents,
      locks: provider.locks
    });
    try {
      const startedAt = new Date().toISOString();
      // What `ExecutionRegistry.register` puts there when it wins the race.
      await provider.documents.put(
        RUNS_NAMESPACE,
        'wf-exec-1',
        {
          runId: 'wf-exec-1',
          kind: 'workflow',
          ownerId: 'u1',
          anonymous: false,
          status: 'running',
          startedAt,
          updatedAt: startedAt,
          refs: { executionId: 'wf-exec-1' },
          workflowId: 'quarterly-report',
          workflowName: { en: 'Quarterly Report' },
          inputPreview: { topic: 'Q4 revenue' },
          models: ['gpt-4o'],
          triggeredBy: { userId: 'u1' }
        },
        { ownerId: 'u1' }
      );

      store.recordRunStart({
        runId: 'wf-exec-1',
        kind: 'workflow',
        principalId: 'u1',
        identityMode: 'pseudonymized',
        anonymous: false,
        parentRunId: 'wf-exec-parent',
        refs: { executionId: 'wf-exec-1', chatId: 'chat-5' },
        model: 'gpt-4o',
        startedAt
      });
      await store.flush();

      const stored = (await provider.documents.get(RUNS_NAMESPACE, 'wf-exec-1')).data;
      assert.equal(stored.identityMode, 'pseudonymized', 'the ledger contributed its half');
      assert.equal(stored.parentRunId, 'wf-exec-parent');
      assert.deepEqual(stored.refs, { executionId: 'wf-exec-1', chatId: 'chat-5' });
      assert.deepEqual(
        stored.workflowName,
        { en: 'Quarterly Report' },
        'without erasing the registry s'
      );
      assert.deepEqual(stored.inputPreview, { topic: 'Q4 revenue' });
      assert.deepEqual(stored.triggeredBy, { userId: 'u1' });
      assert.deepEqual(stored.models, ['gpt-4o']);
    } finally {
      await provider.shutdown();
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it('records an end behind the start it depends on, with no lock to fall back on', async () => {
    // The `put` at run/start and the `patch` at run/end are queued from
    // synchronous callers, and the patch deliberately refuses to invent a
    // document. On a provider that reports no locking there is nothing but
    // this queue to keep the two in order, and a patch that overtook its
    // start would be dropped — leaving the run `running` for ever.
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'ihub-run-ledger-order-'));
    const provider = new FilesystemStorageProvider({
      baseDir: path.join(root, 'storage'),
      flushIntervalMs: 25
    });
    await provider.initialize();
    const store = new RunLedgerStore({
      logs: provider.logs,
      documents: provider.documents
      // No `locks`: the degradation path, where ordering is the queue's job.
    });
    try {
      for (let attempt = 0; attempt < 5; attempt += 1) {
        const runId = `chat-unlocked-${attempt}`;
        const startedAt = new Date().toISOString();
        store.recordRunStart({
          runId,
          kind: 'chat',
          principalId: 'u1',
          anonymous: false,
          refs: {},
          startedAt
        });
        store.recordRunEnd({
          runId,
          kind: 'chat',
          principalId: 'u1',
          anonymous: false,
          status: 'completed',
          finishReason: 'stop',
          usage: { totalTokens: 3 },
          endedAt: new Date().toISOString()
        });
        await store.flush();

        const doc = await provider.documents.get(RUNS_NAMESPACE, runId);
        assert.ok(doc, `attempt ${attempt}: the summary exists`);
        assert.equal(doc.data.status, 'completed', `attempt ${attempt}: the end was not dropped`);
        assert.equal(doc.data.ownerId, 'u1', `attempt ${attempt}: and the owner survived`);
      }
    } finally {
      await provider.shutdown();
      await fs.rm(root, { recursive: true, force: true });
    }
  });
});
