// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * Finding unfinished workflow runs without reading the workflow history
 * (#3624).
 *
 * The boot jobs that care about unfinished runs — the resume manager and the
 * orphan sweeper — used to read every stored state (one of them in full, all
 * at once) to find the handful that are not terminal. A terminal state can
 * never become resumable or orphaned, so the repository keeps a small index of
 * the executions whose last stored status is not terminal and those jobs read
 * only those. A run paused for a human (`pendingCheckpoint`) is not terminal
 * and stays in the index however old it is.
 *
 * The index is built once from a full walk the first time it is asked for, so
 * states stored before it existed (or imported by a migration) are found too.
 */
import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { startTestStorage, stateRepositoryFor } from './helpers/testStorage.js';
import {
  WORKFLOW_STATE_NAMESPACE,
  WORKFLOW_ACTIVE_NAMESPACE
} from '../services/workflow/WorkflowStateRepository.js';
import { findResumableExecutions } from '../services/workflow/resumeManager.js';
import { sweepOrphanedExecutions } from '../services/workflow/orphanSweeper.js';
import { ExecutionRegistry } from '../services/workflow/ExecutionRegistry.js';
import { RunSummaryRepository } from '../services/runtime/RunSummaryRepository.js';

let storage;
before(async () => {
  storage = await startTestStorage({ prefix: 'ihub-test-active-index-' });
});
after(async () => {
  await storage.stop();
});
beforeEach(async () => {
  const base = path.join(storage.dir, 'data');
  for (const entry of await fs.readdir(base).catch(() => [])) {
    // Background writes of the previous case (the registry's queued status
    // updates) may still be landing.
    await fs.rm(path.join(base, entry), {
      recursive: true,
      force: true,
      maxRetries: 10,
      retryDelay: 50
    });
  }
});

const DAY = 24 * 60 * 60 * 1000;

const byCodeUnits = (a, b) => (a < b ? -1 : Number(a > b));

function state(executionId, status, extra = {}) {
  return {
    executionId,
    workflowId: 'wf',
    status,
    createdAt: new Date().toISOString(),
    data: { _workflow: { startedBy: 'user-1' } },
    ...extra
  };
}

/**
 * Count the workflow-state bodies a block of code reads through the store.
 *
 * @param {Object} documents - Provider document facet.
 * @param {() => Promise<unknown>} fn - Code under observation.
 * @returns {Promise<{result: unknown, gets: string[], listedWithBodies: number,
 *   listedMetadata: number}>}
 */
async function observeStateReads(documents, fn) {
  const gets = [];
  let listedWithBodies = 0;
  let listedMetadata = 0;
  const { get, list, scan } = documents;
  documents.get = async function (ns, key, ...rest) {
    if (ns === WORKFLOW_STATE_NAMESPACE) gets.push(key);
    return get.call(this, ns, key, ...rest);
  };
  documents.list = async function (ns, opts = {}, ...rest) {
    const page = await list.call(this, ns, opts, ...rest);
    if (ns === WORKFLOW_STATE_NAMESPACE) {
      if (opts.includeData === false) listedMetadata += page.items.length;
      else listedWithBodies += page.items.length;
    }
    return page;
  };
  documents.scan = async function* (ns, opts = {}, ...rest) {
    for await (const doc of scan.call(this, ns, opts, ...rest)) {
      if (ns === WORKFLOW_STATE_NAMESPACE) {
        if (opts.includeData === false) listedMetadata += 1;
        else listedWithBodies += 1;
      }
      yield doc;
    }
  };
  try {
    return { result: await fn(), gets, listedWithBodies, listedMetadata };
  } finally {
    documents.get = get;
    documents.list = list;
    documents.scan = scan;
  }
}

test('a stored non-terminal status is listed as active, a terminal one is not', async () => {
  const repository = stateRepositoryFor(storage);
  await repository.write('wf-exec-run', state('wf-exec-run', 'running'));
  await repository.write('wf-exec-wait', state('wf-exec-wait', 'paused'));
  await repository.write('wf-exec-done', state('wf-exec-done', 'completed'));
  await repository.write('wf-exec-flip', state('wf-exec-flip', 'running'));
  await repository.write('wf-exec-flip', state('wf-exec-flip', 'cancelled'));
  await repository.write('wf-exec-gone', state('wf-exec-gone', 'running'));
  await repository.remove('wf-exec-gone');

  const { items, truncated } = await repository.listActive();
  assert.equal(truncated, false);
  assert.deepEqual(items.map(item => item.executionId).sort(byCodeUnits), [
    'wf-exec-run',
    'wf-exec-wait'
  ]);
  assert.equal(items.find(item => item.executionId === 'wf-exec-wait').status, 'paused');
});

test('listActive honours a prefix', async () => {
  const repository = stateRepositoryFor(storage);
  await repository.write('wf-exec-a', state('wf-exec-a', 'running'));
  await repository.write('wf-child-a', state('wf-child-a', 'running'));
  await repository.write('workflow-chat-a', state('workflow-chat-a', 'pending'));

  const { items } = await repository.listActive({ prefix: 'wf-exec-' });
  assert.deepEqual(
    items.map(item => item.executionId),
    ['wf-exec-a']
  );
});

test('states stored without the index are found by a one-time rebuild', async () => {
  // A state written before this release (or imported by migration V219)
  // never went through the index.
  const { documents } = storage.provider;
  await documents.put(
    WORKFLOW_STATE_NAMESPACE,
    'wf-exec-legacy',
    state('wf-exec-legacy', 'running')
  );
  await documents.put(WORKFLOW_STATE_NAMESPACE, 'wf-exec-old', state('wf-exec-old', 'completed'));
  await documents.put(WORKFLOW_STATE_NAMESPACE, 'execution-registry', { executions: [] });

  const repository = stateRepositoryFor(storage);
  const first = await repository.listActive();
  assert.deepEqual(
    first.items.map(item => item.executionId),
    ['wf-exec-legacy']
  );

  // Built once: the next listing reads the index, not the states.
  await documents.put(WORKFLOW_STATE_NAMESPACE, 'wf-exec-later', state('wf-exec-later', 'running'));
  const second = await observeStateReads(documents, () => stateRepositoryFor(storage).listActive());
  assert.equal(second.listedWithBodies + second.listedMetadata + second.gets.length, 0);
  assert.deepEqual(
    second.result.items.map(item => item.executionId),
    ['wf-exec-legacy'],
    'a state that bypassed the repository after the build is not discovered by a scan'
  );
});

test('findResumableExecutions reads only the unfinished states', async () => {
  const repository = stateRepositoryFor(storage);
  for (let i = 0; i < 20; i += 1) {
    await repository.write(`wf-exec-done${i}`, state(`wf-exec-done${i}`, 'completed'));
  }
  await repository.write('wf-exec-r', state('wf-exec-r', 'running'));
  await repository.write('wf-exec-p', state('wf-exec-p', 'pending'));
  await repository.write('wf-exec-w', state('wf-exec-w', 'paused'));
  await repository.listActive(); // build the index

  const observed = await observeStateReads(storage.provider.documents, () =>
    findResumableExecutions(stateRepositoryFor(storage))
  );
  assert.deepEqual(observed.result.map(run => run.executionId).sort(byCodeUnits), [
    'wf-exec-p',
    'wf-exec-r'
  ]);
  assert.equal(observed.listedWithBodies, 0, 'no listing of state bodies');
  assert.equal(observed.listedMetadata, 0, 'no walk of the namespace either');
  assert.deepEqual(observed.gets.sort(byCodeUnits), ['wf-exec-p', 'wf-exec-r', 'wf-exec-w']);
});

test('a run paused for approval long ago stays resumable and is never swept', async () => {
  const repository = stateRepositoryFor(storage);
  const longAgo = new Date(Date.now() - 400 * DAY).toISOString();
  await repository.write(
    'wf-exec-approval',
    state('wf-exec-approval', 'paused', {
      createdAt: longAgo,
      updatedAt: longAgo,
      pendingCheckpoint: { nodeId: 'approve', type: 'human' }
    })
  );
  await repository.write('wf-exec-crashed', state('wf-exec-crashed', 'running'));
  for (let i = 0; i < 10; i += 1) {
    await repository.write(`wf-exec-old${i}`, state(`wf-exec-old${i}`, 'completed'));
  }

  const { items } = await repository.listActive();
  assert.ok(items.some(item => item.executionId === 'wf-exec-approval'));

  const observed = await observeStateReads(storage.provider.documents, () =>
    sweepOrphanedExecutions({ requireSchedulerOwner: false, repository })
  );
  assert.deepEqual(observed.result, { scanned: 2, marked: 1 });
  assert.equal(observed.listedWithBodies + observed.listedMetadata, 0);
  assert.ok(
    observed.gets.every(id => id === 'wf-exec-approval' || id === 'wf-exec-crashed'),
    `only unfinished states are read, got ${observed.gets.join(', ')}`
  );

  assert.equal((await repository.read('wf-exec-approval')).status, 'paused');
  assert.equal((await repository.read('wf-exec-crashed')).status, 'failed');
  const after = await repository.listActive();
  assert.deepEqual(
    after.items.map(item => item.executionId),
    ['wf-exec-approval'],
    'the swept run left the index with its terminal write'
  );
});

test('an index entry whose state is terminal or gone is pruned when read', async () => {
  const repository = stateRepositoryFor(storage);
  const { documents } = storage.provider;
  await repository.write('wf-exec-stale', state('wf-exec-stale', 'running'));
  await repository.write('wf-exec-vanished', state('wf-exec-vanished', 'running'));
  // Out-of-band changes the index cannot have seen (a crash between the two
  // writes, a hand edit).
  await documents.put(
    WORKFLOW_STATE_NAMESPACE,
    'wf-exec-stale',
    state('wf-exec-stale', 'completed')
  );
  await documents.delete(WORKFLOW_STATE_NAMESPACE, 'wf-exec-vanished');

  const found = await findResumableExecutions(repository);
  assert.deepEqual(found, []);
  const page = await documents.list(WORKFLOW_ACTIVE_NAMESPACE, {});
  assert.deepEqual(page.items, [], 'stale entries were dropped');
});

test('the registry recovers states without a summary once, not on every boot', async () => {
  const { documents, locks } = storage.provider;
  const states = stateRepositoryFor(storage);
  const summaries = new RunSummaryRepository({ documents, locks });
  const quiet = { debug() {}, info() {}, warn() {}, error() {} };
  await states.write('wf-exec-orphaned-record', state('wf-exec-orphaned-record', 'completed'));
  await states.write('workflow-chat1', state('workflow-chat1', 'completed'));
  // A chat-launched run whose ledger summary is a chat run: there is a
  // summary, so there is nothing to recover — and it must not be "recovered"
  // (and re-read) again on every boot.
  await summaries.put({ runId: 'workflow-chat1', kind: 'chat', ownerId: 'user-1' });

  const first = new ExecutionRegistry({ summaries, states, logger: quiet });
  const firstRun = await observeStateReads(documents, () => first._scanCheckpointDirectories());
  assert.equal(firstRun.result, 1);
  assert.deepEqual(firstRun.gets, ['wf-exec-orphaned-record']);
  assert.equal((await first.get('wf-exec-orphaned-record')).status, 'completed');
  await first.loadFromDisk();

  // Second boot: the backfill is done; no state is listed or read.
  const second = new ExecutionRegistry({ summaries, states, logger: quiet });
  const secondRun = await observeStateReads(documents, () => second.loadFromDisk());
  assert.equal(secondRun.listedWithBodies + secondRun.listedMetadata, 0);
  assert.deepEqual(secondRun.gets, []);
});
