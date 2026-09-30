/**
 * "A scheduled task changed" — announced to this process and every other
 * worker, so the scheduler owner's index follows edits, new tasks, run-now
 * requests and answered approvals made on any worker.
 *
 * The announcement is a hint, not the data: the owner re-reads the task from
 * storage. A lost announcement costs at most the owner's periodic rebuild.
 *
 * @module services/scheduler/tasks/taskEvents
 */
import { publish, subscribe } from '../../../clusterBus.js';

const CHANNEL = 'scheduled-tasks:changed';

/** @type {Set<(taskId: string) => void>} */
const listeners = new Set();
let unsubscribeBus = null;

function deliver(taskId) {
  for (const listener of listeners) {
    try {
      listener(taskId);
    } catch {
      // A listener's failure must not keep the others from hearing about it.
    }
  }
}

/**
 * Listen for task changes, local and from other workers.
 *
 * @param {(taskId: string) => void} listener
 * @returns {() => void} Unsubscribe.
 */
export function onTaskChanged(listener) {
  listeners.add(listener);
  if (!unsubscribeBus) {
    unsubscribeBus = subscribe(CHANNEL, payload => {
      if (typeof payload?.taskId === 'string') deliver(payload.taskId);
    });
  }
  return () => listeners.delete(listener);
}

/**
 * Announce that a task changed.
 *
 * @param {string} taskId
 */
export function announceTaskChanged(taskId) {
  if (typeof taskId !== 'string' || !taskId) return;
  deliver(taskId);
  publish(CHANNEL, { taskId });
}

/** Test hook. */
export function resetTaskEventsForTests() {
  listeners.clear();
  unsubscribeBus?.();
  unsubscribeBus = null;
}
