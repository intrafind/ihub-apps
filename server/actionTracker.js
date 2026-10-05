/**
 * Internal event bus for workflow and agent runtime events.
 *
 * Producers (WorkflowEngine, node executors, agent tools) emit
 * `actionTracker.emit('fire-sse', { event, chatId, ...payload })` where
 * `event` is an internal name (`workflow.node.start`, `agent.task.created`, …)
 * and `chatId` is the execution id the event belongs to. Consumers are the
 * run-scoped stream endpoints (`routes/workflow/workflowRoutes.js`,
 * `routes/agents/runs.js`) and the chat bridge (`tools/workflowRunner.js`),
 * which translate these events onto SSE v2 envelopes
 * (`services/loop/RunStream.js`). Nothing on this bus reaches a client
 * verbatim — the wire dialect is SSE v2 only.
 */
import { EventEmitter } from 'events';
import { createPresenceMap, hasRemote, publish, subscribe } from './clusterBus.js';

/**
 * ## Across cluster workers
 *
 * A run executes on the worker that started (or resumed) it, but the browser
 * watching it — the stream GET, the chat that launched it — is often attached
 * to another worker. A consumer therefore declares which run it watches with
 * {@link ActionTracker#watchRun}; that is announced over the cluster bus, and a
 * `fire-sse` event for a run watched elsewhere is relayed there and emitted on
 * that worker's tracker as if it had been produced locally. Outside cluster
 * mode none of this does anything.
 *
 * A sub-workflow's events carry its own execution id, while the browser
 * watches the run that spawned it. The worker running both remembers which
 * run spawned which child (from `workflow.subworkflow.start`), so a child's
 * events reach the parent's watchers from the first one on — a watch the
 * stream registers for the child once it hears of it would arrive too late
 * for the events in between.
 */
const RUN_WATCH_PRESENCE = 'run-watch';
const RELAY_CHANNEL = 'action-tracker:fire-sse';

/**
 * runId → number of local watchers. Shared, because two browser tabs on two
 * workers can watch the same run; each must get its events.
 */
const watchedRuns = createPresenceMap(RUN_WATCH_PRESENCE, { shared: true });

/** child execution id → the run that spawned it, for runs on this worker. */
const parentOfRun = new Map();

/** Children remembered at most; the oldest are forgotten first. */
const MAX_REMEMBERED_CHILDREN = 10_000;

/** Levels of sub-workflow nesting followed up to a watched run. */
const MAX_ANCESTRY_DEPTH = 8;

function rememberChild(childId, parentId) {
  if (typeof childId !== 'string' || typeof parentId !== 'string' || childId === parentId) return;
  parentOfRun.delete(childId);
  parentOfRun.set(childId, parentId);
  if (parentOfRun.size > MAX_REMEMBERED_CHILDREN) {
    parentOfRun.delete(parentOfRun.keys().next().value);
  }
}

/** The run ids an event belongs to: its own, then the runs that spawned it. */
function runIdsOf(payload) {
  const ids = new Set();
  for (const id of [payload.chatId, payload.executionId]) {
    let current = id;
    for (let depth = 0; typeof current === 'string' && depth <= MAX_ANCESTRY_DEPTH; depth++) {
      if (ids.has(current)) break;
      ids.add(current);
      current = parentOfRun.get(current);
    }
  }
  return ids;
}

/** Errors do not survive JSON serialisation; keep what consumers read. */
function toWire(payload) {
  return JSON.parse(
    JSON.stringify(payload, (_key, value) =>
      value instanceof Error
        ? { name: value.name, message: value.message, code: value.code }
        : value
    )
  );
}

export class ActionTracker extends EventEmitter {
  constructor() {
    super();
    // Every listener is request/connection-scoped and pairs its on() with an
    // off() in a cleanup path, so concurrent runs legitimately exceed the
    // default 10-listener warning threshold without leaking.
    this.setMaxListeners(0);
  }

  emit(eventName, ...args) {
    const handled = super.emit(eventName, ...args);
    if (eventName === 'fire-sse') this._relayToWatchers(args[0]);
    return handled;
  }

  /**
   * Receive `fire-sse` events for `runId` on this worker even when the run
   * executes on another one. Call alongside `on('fire-sse', …)`.
   *
   * @param {string} runId - Execution / run id the events carry as `chatId`
   *   or `executionId`.
   * @returns {() => void} Stop watching; safe to call more than once.
   */
  watchRun(runId) {
    if (typeof runId !== 'string' || !runId) return () => {};
    watchedRuns.set(runId, (watchedRuns.get(runId) || 0) + 1);
    let released = false;
    return () => {
      if (released) return;
      released = true;
      const remaining = (watchedRuns.get(runId) || 1) - 1;
      if (remaining > 0) watchedRuns.set(runId, remaining);
      else watchedRuns.delete(runId);
    };
  }

  _relayToWatchers(payload) {
    if (!payload || typeof payload !== 'object') return;
    if (payload.event === 'workflow.subworkflow.start') {
      rememberChild(payload.executionId, payload.parentExecutionId ?? payload.chatId);
    }
    for (const runId of runIdsOf(payload)) {
      if (!hasRemote(RUN_WATCH_PRESENCE, runId)) continue;
      let wire;
      try {
        wire = toWire(payload);
      } catch {
        return; // not serialisable (a cycle); nothing a remote watcher could use
      }
      publish(RELAY_CHANNEL, { payload: wire }, { kind: RUN_WATCH_PRESENCE, key: runId });
      return; // one relay reaches every watching worker
    }
  }
}

export const actionTracker = new ActionTracker();

// Events relayed from the worker running the run: emit locally only, so they
// are never relayed back out.
subscribe(RELAY_CHANNEL, ({ payload } = {}) => {
  if (payload) EventEmitter.prototype.emit.call(actionTracker, 'fire-sse', payload);
});
