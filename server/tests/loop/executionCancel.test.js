import test from 'node:test';
import assert from 'node:assert/strict';
import {
  WorkflowEngine,
  EXECUTION_PRESENCE_KIND,
  EXECUTION_CANCEL_CHANNEL
} from '../../services/workflow/WorkflowEngine.js';

/** Fake cluster: per-worker buses sharing ownership and subscriptions. */
function fakeCluster() {
  const owners = new Map();
  const subscribers = new Map(); // type -> Map<workerId, handler>
  return {
    worker(id) {
      return {
        createPresenceMap(kind) {
          class PresenceMap extends Map {
            set(key, value) {
              owners.set(`${kind}:${key}`, id);
              return super.set(key, value);
            }
            delete(key) {
              if (owners.get(`${kind}:${key}`) === id) owners.delete(`${kind}:${key}`);
              return super.delete(key);
            }
          }
          return new PresenceMap();
        },
        hasRemote(kind, key) {
          const owner = owners.get(`${kind}:${key}`);
          return owner !== undefined && owner !== id;
        },
        subscribe(type, handler) {
          if (!subscribers.has(type)) subscribers.set(type, new Map());
          subscribers.get(type).set(id, handler);
          return () => subscribers.get(type)?.delete(id);
        },
        publish(type, payload, route) {
          const target = route ? owners.get(`${route.kind}:${route.key}`) : undefined;
          for (const [workerId, handler] of subscribers.get(type) || []) {
            if (workerId === id) continue;
            if (target !== undefined && workerId !== target) continue;
            handler(payload);
          }
          return true;
        }
      };
    }
  };
}

function fakeStateManager(states) {
  return {
    async get(id) {
      return states.get(id) || null;
    },
    async update(id, patch) {
      states.set(id, { ...(states.get(id) || {}), ...patch });
    },
    async checkpoint() {},
    async addStep() {}
  };
}

test('cancelAnywhere: relays to the worker holding the abort controller, cancels locally otherwise', async () => {
  const cluster = fakeCluster();
  const states = new Map([
    ['wf-exec-cancel-1', { executionId: 'wf-exec-cancel-1', status: 'running' }],
    ['wf-exec-cancel-2', { executionId: 'wf-exec-cancel-2', status: 'paused' }]
  ]);
  const workerA = new WorkflowEngine({
    bus: cluster.worker(1),
    stateManager: fakeStateManager(states)
  });
  const workerB = new WorkflowEngine({
    bus: cluster.worker(2),
    stateManager: fakeStateManager(states)
  });
  const cancelled = [];
  for (const [name, engine] of [
    ['A', workerA],
    ['B', workerB]
  ]) {
    engine.cancel = async (executionId, reason) => {
      cancelled.push({ worker: name, executionId, reason });
      engine.abortControllers.delete(executionId);
      return { executionId, status: 'cancelled' };
    };
  }

  // A runs the execution (holds its controller); the stop request lands on B.
  workerA.abortControllers.set('wf-exec-cancel-1', new AbortController());
  assert.equal(workerB._bus.hasRemote(EXECUTION_PRESENCE_KIND, 'wf-exec-cancel-1'), true);
  const relayed = await workerB.cancelAnywhere('wf-exec-cancel-1', 'user_stop');
  assert.equal(relayed.cancelRelayed, true);
  assert.deepEqual(cancelled, [
    { worker: 'A', executionId: 'wf-exec-cancel-1', reason: 'user_stop' }
  ]);
  assert.equal(workerA.abortControllers.has('wf-exec-cancel-1'), false, 'ownership withdrawn');

  // Nobody runs it (paused): the requesting worker cancels the state itself.
  const local = await workerB.cancelAnywhere('wf-exec-cancel-2', 'user_stop');
  assert.equal(local.status, 'cancelled');
  assert.equal(cancelled[1].worker, 'B');

  // Unknown execution while a remote owner is announced → not found
  workerA.abortControllers.set('wf-exec-ghost', new AbortController());
  await assert.rejects(
    workerB.cancelAnywhere('wf-exec-ghost'),
    e => e.code === 'EXECUTION_NOT_FOUND'
  );
  assert.equal(EXECUTION_CANCEL_CHANNEL, 'execution:cancel');
});
