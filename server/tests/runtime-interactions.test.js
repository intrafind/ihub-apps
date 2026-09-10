/**
 * `InteractionService` on the storage provider, driven against a real
 * `FilesystemStorageProvider`.
 *
 * The claim that decides who resumes a paused workflow used to be an
 * `O_EXCL` marker file. It is now a provider lease plus a compare-and-set on
 * the shared document, and the two halves are not interchangeable: the lease
 * is released the moment the critical section settles, so only the document
 * can carry "already answered, do not resume twice". Every concurrency case
 * below therefore runs two services with the cluster bus **silenced**, which
 * is the honest test — with the bus mirroring mutations, a broken
 * compare-and-set would still look correct.
 *
 * Two further properties are load-bearing and easy to lose: persistence here
 * is independent of the `runLog` feature flag (D6), and the answer lease is
 * per interaction and never per run, because an answer handler resumes a
 * workflow that can raise the next interaction while the lease is held and
 * `withLock` is not reentrant.
 *
 * Contract: `RUNTIME_STORES_CONTRACT.md` §6, D6 and D7.
 */
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { FilesystemStorageProvider } from '../storage/providers/filesystem/index.js';
import { RunLog } from '../services/loop/RunLog.js';
import {
  InteractionService,
  InteractionError,
  INTERACTIONS_NAMESPACE,
  interactionDocumentKey
} from '../services/loop/InteractionService.js';

const USER = { id: 'u1' };

/**
 * A cluster bus that carries nothing.
 *
 * Every cross-worker case here has to be decided by shared storage alone; a
 * bus that mirrored the mutation would hide a compare-and-set that never
 * happened.
 *
 * @returns {{publish: Function, subscribe: Function}}
 */
function silentBus() {
  return { publish: () => {}, subscribe: () => () => {} };
}

/**
 * A promise with its resolver exposed, for holding a critical section open.
 *
 * @returns {{promise: Promise<void>, resolve: Function}}
 */
function deferred() {
  let resolve;
  const promise = new Promise(r => {
    resolve = r;
  });
  return { promise, resolve };
}

/**
 * Reject if `promise` has not settled within `ms`.
 *
 * A deadlock is the failure this suite is looking for, and a runner that
 * simply hangs reports it as nothing at all.
 *
 * @param {Promise<T>} promise - The promise to bound.
 * @param {number} ms - Budget in milliseconds.
 * @param {string} what - Named in the failure.
 * @returns {Promise<T>}
 * @template T
 */
function withDeadline(promise, ms, what) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`Deadlocked waiting for ${what}`)), ms);
    if (typeof timer.unref === 'function') timer.unref();
    promise.then(
      value => {
        clearTimeout(timer);
        resolve(value);
      },
      error => {
        clearTimeout(timer);
        reject(error);
      }
    );
  });
}

/**
 * Bring up a provider, a ledger and one or more interaction services over one
 * scratch directory.
 *
 * The ledger is deliberately left **disabled**: interaction persistence is
 * independent of the `runLog` flag and must stay so.
 *
 * @param {Object} [options]
 * @param {number} [options.services=1] - How many workers to simulate.
 * @param {boolean} [options.withProvider=true] - Wire the provider in.
 * @returns {Promise<Object>} Directories, the ledger and the services.
 */
async function openInteractions({ services = 1, withProvider = true } = {}) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'ihub-interactions-'));
  const legacyDir = path.join(root, 'run-log');
  await fs.mkdir(legacyDir, { recursive: true });
  let provider = null;
  if (withProvider) {
    provider = new FilesystemStorageProvider({
      baseDir: path.join(root, 'storage'),
      flushIntervalMs: 25
    });
    await provider.initialize();
  }
  const runLog = new RunLog({
    baseDir: legacyDir,
    forceEnabled: false,
    getPlatformConfig: () => ({})
  });
  const make = () =>
    new InteractionService({
      runLog,
      saveIntervalMs: 10,
      bus: silentBus(),
      documents: provider ? provider.documents : null,
      locks: provider ? provider.locks : null
    });
  const all = Array.from({ length: services }, make);
  return { root, legacyDir, provider, runLog, services: all, service: all[0] };
}

/**
 * Run `fn` with an isolated set of services, torn down after.
 *
 * @param {(ctx: Object) => Promise<void>} fn - The test body.
 * @param {Object} [options] - Passed to {@link openInteractions}.
 * @returns {Promise<void>}
 */
async function withInteractions(fn, options = {}) {
  const ctx = await openInteractions(options);
  try {
    await fn(ctx);
  } finally {
    for (const service of ctx.services) await service.stop();
    await ctx.runLog.stop();
    await ctx.provider?.shutdown();
    await fs.rm(ctx.root, { recursive: true, force: true });
  }
}

/**
 * Raise a question on a run.
 *
 * @param {InteractionService} service - Service to raise through.
 * @param {string} runId - Owning run.
 * @param {Object} [overrides] - Fields to change.
 * @returns {Promise<Object>} The raised interaction.
 */
function raiseQuestion(service, runId, overrides = {}) {
  return service.raise({
    runId,
    kind: 'question',
    origin: 'tool',
    prompt: { message: 'Which region?', inputType: 'text' },
    source: { chatId: 'chat-1', principalId: 'u1', identityMode: 'default' },
    ...overrides
  });
}

describe('interactions: the shared namespace', () => {
  it('persists with the ledger flag off, owned by the raising principal', async () => {
    await withInteractions(async ({ service, runLog, provider, legacyDir }) => {
      assert.equal(runLog.isEnabled(), false, 'the ledger is off for this whole suite');
      const { runId } = await runLog.startRun({ kind: 'workflow', user: USER });
      const raised = await raiseQuestion(service, runId);

      const doc = await provider.documents.get(
        INTERACTIONS_NAMESPACE,
        interactionDocumentKey(raised.id)
      );
      assert.ok(doc, 'the record is in the namespace, not only in memory');
      assert.equal(doc.ownerId, 'u1');
      assert.equal(doc.data.status, 'pending');
      assert.equal(doc.data.runId, runId);
      assert.equal(
        await fs
          .access(path.join(legacyDir, 'interactions.json'))
          .then(() => true)
          .catch(() => false),
        false,
        'and the legacy whole-file store is not written any more'
      );
    });
  });

  it('survives a restart', async () => {
    await withInteractions(
      async ({ runLog, services: [first, second] }) => {
        const { runId } = await runLog.startRun({ kind: 'workflow', user: USER });
        const raised = await raiseQuestion(first, runId);
        await first.flush();

        // A second service over the same storage is what the process after a
        // restart — or a sibling worker — sees.
        assert.deepEqual(
          (await second.listPending({ runId })).map(item => item.id),
          [raised.id]
        );
        const loaded = await second.get(raised.id);
        assert.equal(loaded.status, 'pending');
        assert.equal(loaded.prompt.message, 'Which region?');

        const answered = await second.answer(raised.id, { value: 'eu' }, { user: USER });
        assert.equal(answered.status, 'answered');
        assert.equal(answered.answer.value, 'eu');
      },
      { services: 2 }
    );
  });

  it('answers the whole-installation queue from the namespace, filters intact', async () => {
    await withInteractions(
      async ({ runLog, services: [first, second] }) => {
        const { runId } = await runLog.startRun({ kind: 'workflow', user: USER });
        await raiseQuestion(first, runId, {
          kind: 'approval',
          prompt: { message: 'Ship it?', inputType: 'confirm' },
          policy: { approverGroups: ['release'] },
          source: { principalId: 'u1' }
        });
        await raiseQuestion(first, runId, { source: { principalId: 'u2' } });

        // `second` heard nothing over the bus: everything it lists it read.
        const pending = await second.listPending({});
        assert.equal(pending.length, 2);
        assert.deepEqual(
          pending.map(item => item.createdAt),
          [...pending.map(item => item.createdAt)].sort(),
          'oldest first'
        );
        assert.deepEqual(
          (await second.listPending({ kind: 'approval' })).map(i => i.kind),
          ['approval']
        );
        assert.deepEqual(
          (await second.listPending({ approverGroups: ['release'] })).map(i => i.kind).sort(),
          ['approval', 'question'],
          'an interaction with no approver groups stays visible to every queue'
        );
        assert.deepEqual(
          (await second.listPending({ approverGroups: ['other'] })).map(i => i.kind),
          ['question']
        );
        assert.deepEqual(
          (await second.listPending({ principalId: 'u2' })).map(i => i.source.principalId),
          ['u2']
        );
      },
      { services: 2 }
    );
  });

  it('keeps the legacy file layout when there is no provider', async () => {
    await withInteractions(
      async ({ runLog, service, legacyDir }) => {
        const { runId } = await runLog.startRun({ kind: 'workflow', user: USER });
        const raised = await raiseQuestion(service, runId);
        await service.flush();

        const stored = JSON.parse(
          await fs.readFile(path.join(legacyDir, 'interactions.json'), 'utf8')
        );
        assert.ok(stored.interactions[raised.id], 'the pending store is written as before');

        await service.answer(raised.id, { value: 'eu' }, { user: USER });
        await service.flush();
        const settled = JSON.parse(
          await fs.readFile(path.join(legacyDir, 'interactions.json'), 'utf8')
        );
        assert.equal(
          settled.interactions[raised.id],
          undefined,
          'and an answered interaction is still dropped from it'
        );
      },
      { withProvider: false }
    );
  });
});

describe('interactions: the answer claim', () => {
  it('runs the handler exactly once when two workers answer at the same time', async () => {
    await withInteractions(
      async ({ runLog, services: [first, second] }) => {
        const { runId } = await runLog.startRun({ kind: 'workflow', user: USER });
        const raised = await raiseQuestion(first, runId);
        await second.get(raised.id); // both workers hold the pending record

        let handlerRuns = 0;
        let concurrent = 0;
        let maxConcurrent = 0;
        const gate = deferred();
        const handler = async () => {
          handlerRuns += 1;
          concurrent += 1;
          maxConcurrent = Math.max(maxConcurrent, concurrent);
          await gate.promise;
          concurrent -= 1;
        };
        first.onAnswer(handler);
        second.onAnswer(handler);
        // Hold the critical section open long enough for the loser to contend
        // for the lease rather than tidily arriving after it.
        const release = setTimeout(() => gate.resolve(), 20);

        const results = await withDeadline(
          Promise.allSettled([
            first.answer(raised.id, { value: 'eu' }, { user: USER }),
            second.answer(raised.id, { value: 'us' }, { user: USER })
          ]),
          5000,
          'two concurrent answers'
        );
        clearTimeout(release);

        const fulfilled = results.filter(result => result.status === 'fulfilled');
        const rejected = results.filter(result => result.status === 'rejected');
        assert.equal(fulfilled.length, 1, 'exactly one answer is accepted');
        assert.equal(rejected.length, 1);
        assert.equal(handlerRuns, 1, 'the paused workflow is resumed once');
        assert.equal(maxConcurrent, 1, 'and never by two workers at once');

        const error = rejected[0].reason;
        assert.ok(error instanceof InteractionError, 'the loser gets the documented error type');
        assert.equal(error.status, 409);
        assert.ok(
          ['ANSWER_IN_PROGRESS', 'NOT_PENDING'].includes(error.code),
          `unexpected code ${error.code}`
        );

        const stored = await first.get(raised.id);
        assert.equal(stored.status, 'answered');
        assert.equal(stored.answer.value, fulfilled[0].value.answer.value);
      },
      { services: 2 }
    );
  });

  it('refuses an answer whose worker still thinks the interaction is pending', async () => {
    // The stale-mirror case the marker tombstone used to cover: with the bus
    // silent, only the shared document can say the run was already resumed.
    await withInteractions(
      async ({ runLog, services: [first, second] }) => {
        const { runId } = await runLog.startRun({ kind: 'workflow', user: USER });
        const raised = await raiseQuestion(first, runId);
        assert.equal((await second.get(raised.id)).status, 'pending');

        await first.answer(raised.id, { value: 'eu' }, { user: USER });
        assert.equal(
          (await second.get(raised.id)).status,
          'pending',
          'the second worker s mirror is deliberately stale'
        );

        let resumed = 0;
        second.onAnswer(() => {
          resumed += 1;
        });
        await assert.rejects(second.answer(raised.id, { value: 'us' }, { user: USER }), error => {
          assert.equal(error.status, 409);
          assert.equal(error.code, 'NOT_PENDING');
          return true;
        });
        assert.equal(resumed, 0, 'a stale worker never resumes the run a second time');
      },
      { services: 2 }
    );
  });

  it('does not deadlock when the handler raises the next interaction', async () => {
    // `_answerHandlers` resumes the workflow inside the critical section, and
    // a resumed workflow raises its next checkpoint. The lease is per
    // interaction id precisely so that this is not a self-deadlock.
    await withInteractions(async ({ runLog, service }) => {
      const { runId } = await runLog.startRun({ kind: 'workflow', user: USER });
      const first = await raiseQuestion(service, runId);

      let next = null;
      service.onAnswer(async answered => {
        next = await raiseQuestion(service, answered.runId, {
          prompt: { message: 'And then?', inputType: 'text' }
        });
      });

      const answered = await withDeadline(
        service.answer(first.id, { value: 'eu' }, { user: USER }),
        5000,
        'an answer whose handler raises the next interaction'
      );

      assert.equal(answered.status, 'answered');
      assert.ok(next, 'the handler raised the follow-up');
      assert.equal((await service.get(next.id)).status, 'pending');
      assert.deepEqual(
        (await service.listPending({ runId })).map(item => item.id),
        [next.id]
      );

      // And the follow-up is answerable straight away — the first lease was
      // released when its critical section settled.
      const second = await withDeadline(
        service.answer(next.id, { value: 'done' }, { user: USER }),
        5000,
        'answering the interaction raised inside the handler'
      );
      assert.equal(second.status, 'answered');
    });
  });

  it('leaves the interaction pending when the handler throws', async () => {
    await withInteractions(
      async ({ runLog, services: [first, second] }) => {
        const { runId } = await runLog.startRun({ kind: 'workflow', user: USER });
        const raised = await raiseQuestion(first, runId);
        const unregister = first.onAnswer(() => {
          throw new Error('the workflow could not be resumed');
        });

        await assert.rejects(
          first.answer(raised.id, { value: 'eu' }, { user: USER }),
          /could not be resumed/
        );
        assert.equal((await first.get(raised.id)).status, 'pending');
        assert.equal(
          (await second.listPending({ runId })).length,
          1,
          'another worker can still pick the answer up'
        );

        unregister();
        const answered = await first.answer(raised.id, { value: 'eu' }, { user: USER });
        assert.equal(answered.status, 'answered');
      },
      { services: 2 }
    );
  });

  it('settles a cancelled interaction for every worker', async () => {
    await withInteractions(
      async ({ runLog, services: [first, second] }) => {
        const { runId } = await runLog.startRun({ kind: 'workflow', user: USER });
        const raised = await raiseQuestion(first, runId);
        await second.get(raised.id);

        await first.cancel(raised.id, 'superseded');
        await assert.rejects(second.answer(raised.id, { value: 'eu' }, { user: USER }), error => {
          assert.equal(error.status, 409);
          assert.equal(error.code, 'NOT_PENDING');
          return true;
        });
      },
      { services: 2 }
    );
  });

  it('cascades a run delete into its interactions', async () => {
    await withInteractions(async ({ runLog, service, provider }) => {
      const { runId } = await runLog.startRun({ kind: 'workflow', user: USER });
      const raised = await raiseQuestion(service, runId);
      await service.get(raised.id);

      await runLog.deleteRun(runId);

      assert.equal(await service.get(raised.id), null);
      assert.equal(
        await provider.documents.get(INTERACTIONS_NAMESPACE, interactionDocumentKey(raised.id)),
        null
      );
    });
  });
});

describe('interactions: the legacy import', () => {
  it('carries pending interactions over once, leaving the file alone', async () => {
    await withInteractions(
      async ({ legacyDir, provider, services: [first, second] }) => {
        const legacyFile = path.join(legacyDir, 'interactions.json');
        const record = {
          id: 'int-legacy',
          runId: 'wf-exec-1',
          step: 0,
          kind: 'question',
          origin: 'node',
          prompt: { message: 'Approve?', inputType: 'text', allowSkip: false, allowOther: false },
          policy: { onTimeout: 'fail', fallback: 'park' },
          status: 'pending',
          source: { principalId: 'u1', executionId: 'wf-exec-1' },
          createdAt: new Date().toISOString()
        };
        const body = JSON.stringify({ version: 1, interactions: { 'int-legacy': record } });
        await fs.writeFile(legacyFile, body, 'utf8');

        const pending = await first.listPending({});
        assert.deepEqual(
          pending.map(item => item.id),
          ['int-legacy'],
          'a checkpoint raised by the previous release is visible from the first request'
        );
        assert.ok(await provider.documents.get(INTERACTIONS_NAMESPACE, 'int-legacy'));
        assert.equal(await fs.readFile(legacyFile, 'utf8'), body, 'the legacy file is untouched');

        // Answering it must be final: a re-import on the next boot would resume
        // the run a second time.
        await first.answer('int-legacy', { value: 'yes' }, { user: USER });
        assert.deepEqual(await second.listPending({}), []);
        assert.equal(await fs.readFile(legacyFile, 'utf8'), body);
      },
      { services: 2 }
    );
  });
});
