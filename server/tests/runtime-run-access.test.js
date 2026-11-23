// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * `runAccess` reading the shared `runs` namespace, driven against a real
 * `FilesystemStorageProvider` brought up through the storage bootstrap.
 *
 * This is D3's consumer, and the reason D3 made the registry reads async: a
 * run started on worker 2 used to be invisible to worker 1, so its own owner
 * got a 404 or a 403 on `GET /api/runs/:runId` depending on which worker the
 * request landed on. The namespace read is what fixes that, and the only way
 * to exercise it honestly is with no in-memory record of the run at all —
 * every case below asks a `RunLog` that has never seen the run.
 *
 * The bootstrap singleton is used rather than an injected facet because
 * `runAccess` resolves the process-wide repository per call; `node --test`
 * gives this file a process of its own, so the singleton is safe to move.
 *
 * Contract: `RUNTIME_STORES_CONTRACT.md` §3 and D3.
 */
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { bootstrapStorage, shutdownStorageBootstrap } from '../storage/bootstrap.js';
import { getRunSummaryRepository } from '../services/runtime/RunSummaryRepository.js';
import {
  authorizeExecution,
  authorizeLedgerRun,
  authorizeRun
} from '../services/loop/runAccess.js';

const ALICE = { id: 'alice', groups: ['users'] };
const BOB = { id: 'bob', groups: ['users'] };
const ADMIN = { id: 'root', isAdmin: true, isContentAdmin: true, groups: ['admins'] };
/** Every check names its intent; these cases are about who may read. */
const READ = { intent: 'read' };

/** Scratch directory the bootstrapped provider owns for this file. */
let baseDir = null;

before(async () => {
  baseDir = await fs.mkdtemp(path.join(os.tmpdir(), 'ihub-run-access-'));
  const provider = await bootstrapStorage({
    storage: { provider: 'filesystem', filesystem: { baseDir, flushIntervalMs: 25 } }
  });
  assert.ok(provider, 'the filesystem provider came up');
});

after(async () => {
  await shutdownStorageBootstrap();
  await fs.rm(baseDir, { recursive: true, force: true });
});

/**
 * Record a run the way another worker would have: straight into the shared
 * namespace, with nothing in this process's ledger memory.
 *
 * @param {Object} fields - Summary fields.
 * @returns {Promise<Object|null>} The stored summary.
 */
function recordOnAnotherWorker(fields) {
  return getRunSummaryRepository().put({
    status: 'running',
    startedAt: new Date().toISOString(),
    ...fields
  });
}

describe('runAccess: the runs namespace decides', () => {
  it('authorizes the owner of a run this worker never saw', async () => {
    await recordOnAnotherWorker({
      runId: 'chat-from-worker-2',
      kind: 'chat',
      ownerId: 'alice',
      identityMode: 'default',
      refs: { chatId: 'chat-9' }
    });

    const owner = await authorizeLedgerRun('chat-from-worker-2', ALICE, READ);
    assert.equal(owner.ok, true, 'the owner reaches their own run from any worker');
    assert.equal(owner.meta.kind, 'chat');
    assert.equal(owner.meta.principalId, 'alice');
    assert.deepEqual(owner.meta.refs, { chatId: 'chat-9' });

    assert.deepEqual(await authorizeLedgerRun('chat-from-worker-2', BOB, READ), {
      ok: false,
      status: 403
    });
    const admin = await authorizeLedgerRun('chat-from-worker-2', ADMIN, READ);
    assert.equal(admin.ok, true);
    assert.equal(admin.viaAdmin, true, 'and the decision says that it rests on admin rights');
  });

  it('resolves a caller in the identity mode the run was recorded in', async () => {
    // A run written under `pseudonymized` keeps matching its owner after an
    // administrator switches the global mode, so the recorded mode has to
    // survive on the document.
    await recordOnAnotherWorker({
      runId: 'chat-pseudonymized',
      kind: 'chat',
      ownerId: 'not-the-raw-id',
      identityMode: 'pseudonymized'
    });
    const access = await authorizeLedgerRun('chat-pseudonymized', ALICE, READ);
    assert.equal(access.ok, false, 'a mismatched principal is denied, not served');
    assert.equal(access.status, 403);
    assert.equal(
      (await authorizeLedgerRun('chat-pseudonymized', ALICE, READ)).meta,
      undefined,
      'and a denial carries no metadata'
    );
  });

  it('serves an anonymous run to whoever presents its id, and 404s an unknown one', async () => {
    await recordOnAnotherWorker({
      runId: 'anon-0123456789abcdef',
      kind: 'chat',
      ownerId: 'anon-0123456789abcdef',
      anonymous: true
    });
    assert.equal((await authorizeLedgerRun('anon-0123456789abcdef', BOB, READ)).ok, true);
    assert.deepEqual(await authorizeLedgerRun('chat-never-recorded', ALICE, READ), {
      ok: false,
      status: 404
    });
  });

  it('authorizes an execution from its summary, for its owner and its trigger', async () => {
    await recordOnAnotherWorker({
      runId: 'wf-exec-from-worker-2',
      kind: 'workflow',
      ownerId: 'alice'
    });
    await recordOnAnotherWorker({
      runId: 'agent-run-from-worker-2',
      kind: 'agent',
      ownerId: 'agent:researcher',
      triggeredBy: { userId: 'alice' }
    });

    const owned = await authorizeExecution('wf-exec-from-worker-2', ALICE, READ);
    assert.equal(owned.ok, true);
    assert.equal(owned.meta.kind, 'workflow');
    assert.deepEqual(owned.meta.refs, { executionId: 'wf-exec-from-worker-2' });
    assert.equal(await authorizeExecution('wf-exec-from-worker-2', BOB, READ), null);

    const triggered = await authorizeExecution('agent-run-from-worker-2', ALICE, READ);
    assert.equal(triggered.ok, true, 'the human who triggered an agent run reaches it');
    assert.equal(triggered.meta.kind, 'agent');
    assert.equal(await authorizeExecution('agent-run-from-worker-2', BOB, READ), null);
    assert.equal(
      await authorizeExecution('wf-exec-never-recorded', ALICE, READ),
      null,
      'and an execution no record knows decides nothing'
    );
  });

  it('falls back from the ledger check to the execution record', async () => {
    await recordOnAnotherWorker({
      runId: 'wf-exec-triggered',
      kind: 'workflow',
      ownerId: 'agent:researcher',
      triggeredBy: { userId: 'alice' }
    });

    assert.equal(
      (await authorizeLedgerRun('wf-exec-triggered', ALICE, READ)).ok,
      false,
      'the run principal is the service account, not the human'
    );
    const access = await authorizeRun('wf-exec-triggered', ALICE, READ);
    assert.equal(access.ok, true, 'but the execution record vouches for whoever triggered it');
    assert.equal((await authorizeRun('wf-exec-triggered', BOB, READ)).ok, false);
    assert.equal(
      (await authorizeRun('wf-exec-triggered', ALICE, { intent: 'answer' })).ok,
      true,
      'whoever triggered an agent run answers its questions'
    );
    assert.equal(
      (await authorizeRun('wf-exec-triggered', ALICE, { intent: 'steer' })).ok,
      false,
      "and does not steer it: only the principal speaks in the principal's voice"
    );
  });

  it('tells an admin who triggered the run from an admin who stops somebody else’s', async () => {
    await recordOnAnotherWorker({
      runId: 'agent-run-triggered-by-admin',
      kind: 'agent',
      ownerId: 'agent:researcher',
      triggeredBy: { userId: 'root' }
    });
    await recordOnAnotherWorker({
      runId: 'agent-run-triggered-by-alice',
      kind: 'agent',
      ownerId: 'agent:researcher',
      triggeredBy: { userId: 'alice' }
    });

    const own = await authorizeRun('agent-run-triggered-by-admin', ADMIN, { intent: 'stop' });
    assert.equal(own.ok, true);
    assert.equal(own.viaAdmin, undefined, 'the run they triggered is theirs: nothing to audit');
    assert.equal(own.meta.kind, 'agent');

    const foreign = await authorizeRun('agent-run-triggered-by-alice', ADMIN, { intent: 'stop' });
    assert.equal(foreign.ok, true);
    assert.equal(foreign.viaAdmin, true, 'a stop that rests on admin rights says so');

    for (const intent of ['steer', 'rerun', 'feedback']) {
      assert.equal(
        (await authorizeRun('agent-run-triggered-by-alice', ADMIN, { intent })).ok,
        false,
        `an admin does not ${intent} a run they did not trigger`
      );
    }
  });

  it('lets an admin answer for a run of no person, and for no run of a person', async () => {
    // An agent under its own identity, triggered by Alice; a workflow a
    // trigger started under the system principal; a workflow Alice launched.
    await recordOnAnotherWorker({
      runId: 'agent-run-own-identity',
      kind: 'agent',
      ownerId: 'agent:researcher',
      triggeredBy: { userId: 'alice' }
    });
    await recordOnAnotherWorker({
      runId: 'wf-exec-by-trigger',
      kind: 'workflow',
      ownerId: 'system',
      refs: { executionId: 'wf-exec-by-trigger' }
    });
    await recordOnAnotherWorker({
      runId: 'wf-exec-of-alice',
      kind: 'workflow',
      ownerId: 'alice',
      // A profile id on a person's run changes nothing: the principal decides.
      refs: { executionId: 'wf-exec-of-alice', profileId: 'researcher' }
    });
    const ANSWER = { intent: 'answer' };

    for (const runId of ['agent-run-own-identity', 'wf-exec-by-trigger']) {
      const access = await authorizeRun(runId, ADMIN, ANSWER);
      assert.equal(access.ok, true, `${runId}: nobody else could answer it`);
      assert.equal(access.viaAdmin, true);
      assert.equal((await authorizeRun(runId, BOB, ANSWER)).ok, false, `${runId}: not Bob`);
      assert.equal((await authorizeRun(runId, ADMIN, { intent: 'steer' })).ok, false);
      assert.equal((await authorizeRun(runId, ADMIN, { intent: 'rerun' })).ok, false);
      assert.equal((await authorizeRun(runId, ADMIN, { intent: 'feedback' })).ok, false);
    }
    assert.equal(
      (await authorizeRun('agent-run-own-identity', ALICE, ANSWER)).ok,
      true,
      'whoever triggered the agent run answers it too'
    );

    assert.equal((await authorizeRun('wf-exec-of-alice', ALICE, ANSWER)).ok, true);
    assert.deepEqual(
      await authorizeRun('wf-exec-of-alice', ADMIN, ANSWER),
      { ok: false, status: 403 },
      'the answer would continue the run with Alice’s rights'
    );
  });

  it('knows a run of no person in a pseudonymized ledger too', async () => {
    const { resolvePrincipal } = await import('../services/loop/runIdentity.js');
    const hashed = async id => (await resolvePrincipal({ id }, { mode: 'pseudonymized' })).id;
    await recordOnAnotherWorker({
      runId: 'agent-run-pseudonymized',
      kind: 'agent',
      ownerId: await hashed('agent:researcher'),
      identityMode: 'pseudonymized',
      refs: { profileId: 'researcher' }
    });
    await recordOnAnotherWorker({
      runId: 'chat-of-alice-pseudonymized',
      kind: 'chat',
      ownerId: await hashed('alice'),
      identityMode: 'pseudonymized',
      refs: { profileId: 'researcher' }
    });
    const ANSWER = { intent: 'answer' };
    assert.equal((await authorizeLedgerRun('agent-run-pseudonymized', ADMIN, ANSWER)).ok, true);
    assert.equal((await authorizeLedgerRun('agent-run-pseudonymized', BOB, ANSWER)).ok, false);
    assert.equal(
      (await authorizeLedgerRun('chat-of-alice-pseudonymized', ADMIN, ANSWER)).ok,
      false
    );
  });

  it('refuses every intent but a read to the holder of an anonymous run id', async () => {
    await recordOnAnotherWorker({
      runId: 'anon-fedcba9876543210',
      kind: 'chat',
      ownerId: 'anon-fedcba9876543210',
      anonymous: true
    });
    assert.equal((await authorizeRun('anon-fedcba9876543210', BOB, READ)).ok, true);
    for (const intent of ['stop', 'delete', 'steer', 'rerun', 'feedback', 'answer']) {
      assert.deepEqual(
        await authorizeRun('anon-fedcba9876543210', BOB, { intent }),
        { ok: false, status: 403 },
        intent
      );
    }
  });
});
