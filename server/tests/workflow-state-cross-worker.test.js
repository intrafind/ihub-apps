/**
 * Workflow state read on a worker that is not running the execution.
 *
 * Only the worker running an execution holds its live state; every other
 * cluster worker has the copy it read from the last checkpoint. That copy used
 * to be served forever, so an execution that paused on worker A still read as
 * `running` on worker B — and an answer to its checkpoint landing on B was
 * refused with INVALID_STATE_FOR_RESUME.
 *
 * Locked in here: for an execution not running locally, `get` takes the
 * checkpoint when it is newer, keeps local changes that are newer than the
 * checkpoint, and does not read the checkpoint at all for an execution that
 * runs here.
 */
import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { StateManager } from '../services/workflow/StateManager.js';

const EXECUTION = 'wf-exec-1';

/** A checkpoint store that is just a value and a read counter. */
function fakeRepository() {
  return {
    stored: null,
    reads: 0,
    async read() {
      this.reads += 1;
      return this.stored ? structuredClone(this.stored) : null;
    }
  };
}

function stateAt(status, updatedAt, extra = {}) {
  return { executionId: EXECUTION, status, updatedAt, data: {}, ...extra };
}

describe('StateManager on a worker that is not running the execution', () => {
  let repository;
  let manager;
  let runningHere;

  beforeEach(() => {
    repository = fakeRepository();
    manager = new StateManager({ repository });
    runningHere = new Set();
    manager.setLocalRunCheck(id => runningHere.has(id));
  });

  it('takes a newer checkpoint written by the worker running it', async () => {
    manager.activeStates.set(EXECUTION, stateAt('running', '2026-10-05T10:00:00.000Z'));
    repository.stored = stateAt('paused', '2026-10-05T10:00:05.000Z');

    const state = await manager.get(EXECUTION);

    assert.equal(state.status, 'paused');
    assert.equal(manager.activeStates.get(EXECUTION).status, 'paused');
  });

  it('keeps a local change that is newer than the checkpoint', async () => {
    repository.stored = stateAt('paused', '2026-10-05T10:00:05.000Z');
    manager.activeStates.set(EXECUTION, stateAt('running', '2026-10-05T10:00:09.000Z'));

    const state = await manager.get(EXECUTION);

    assert.equal(state.status, 'running');
  });

  it('keeps the cached state when there is no checkpoint', async () => {
    manager.activeStates.set(EXECUTION, stateAt('running', '2026-10-05T10:00:00.000Z'));

    assert.equal((await manager.get(EXECUTION)).status, 'running');
  });

  it('does not read the checkpoint for an execution running here', async () => {
    runningHere.add(EXECUTION);
    manager.activeStates.set(EXECUTION, stateAt('running', '2026-10-05T10:00:00.000Z'));
    repository.stored = stateAt('completed', '2026-10-05T10:00:05.000Z');

    const state = await manager.get(EXECUTION);

    assert.equal(state.status, 'running');
    assert.equal(repository.reads, 0);
  });

  it('still reads through on a cache miss and caches the result', async () => {
    repository.stored = stateAt('paused', '2026-10-05T10:00:05.000Z');

    assert.equal((await manager.get(EXECUTION)).status, 'paused');
    assert.ok(manager.activeStates.has(EXECUTION));
  });

  it('keeps the old behaviour when no engine has told it what runs here', async () => {
    const plain = new StateManager({ repository });
    plain.activeStates.set(EXECUTION, stateAt('running', '2026-10-05T10:00:00.000Z'));
    repository.stored = stateAt('paused', '2026-10-05T10:00:05.000Z');

    assert.equal((await plain.get(EXECUTION)).status, 'running');
    assert.equal(repository.reads, 0);
  });
});
