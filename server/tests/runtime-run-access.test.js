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
const ADMIN = { id: 'root', groups: ['admin'] };

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

    const owner = await authorizeLedgerRun('chat-from-worker-2', ALICE);
    assert.equal(owner.ok, true, 'the owner reaches their own run from any worker');
    assert.equal(owner.meta.kind, 'chat');
    assert.equal(owner.meta.principalId, 'alice');
    assert.deepEqual(owner.meta.refs, { chatId: 'chat-9' });

    assert.deepEqual(await authorizeLedgerRun('chat-from-worker-2', BOB), {
      ok: false,
      status: 403
    });
    assert.equal((await authorizeLedgerRun('chat-from-worker-2', ADMIN)).ok, true);
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
    const access = await authorizeLedgerRun('chat-pseudonymized', ALICE);
    assert.equal(access.ok, false, 'a mismatched principal is denied, not served');
    assert.equal(access.status, 403);
    assert.equal(
      (await authorizeLedgerRun('chat-pseudonymized', ALICE)).meta,
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
    assert.equal((await authorizeLedgerRun('anon-0123456789abcdef', BOB)).ok, true);
    assert.deepEqual(await authorizeLedgerRun('chat-never-recorded', ALICE), {
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

    const owned = await authorizeExecution('wf-exec-from-worker-2', ALICE);
    assert.equal(owned.ok, true);
    assert.equal(owned.meta.kind, 'workflow');
    assert.deepEqual(owned.meta.refs, { executionId: 'wf-exec-from-worker-2' });
    assert.equal(await authorizeExecution('wf-exec-from-worker-2', BOB), null);

    const triggered = await authorizeExecution('agent-run-from-worker-2', ALICE);
    assert.equal(triggered.ok, true, 'the human who triggered an agent run reaches it');
    assert.equal(triggered.meta.kind, 'agent');
    assert.equal(await authorizeExecution('agent-run-from-worker-2', BOB), null);
    assert.equal(
      await authorizeExecution('wf-exec-never-recorded', ALICE),
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
      (await authorizeLedgerRun('wf-exec-triggered', ALICE)).ok,
      false,
      'the run principal is the service account, not the human'
    );
    const access = await authorizeRun('wf-exec-triggered', ALICE);
    assert.equal(access.ok, true, 'but the execution record vouches for whoever triggered it');
    assert.equal((await authorizeRun('wf-exec-triggered', BOB)).ok, false);
  });
});
