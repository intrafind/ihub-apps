/**
 * The runner — executes queued scheduled runs on the scheduler owner, within
 * a global and a per-owner concurrency limit.
 *
 * Runs wait here in memory; what makes them durable is the run document
 * (`queued`) and the task's `activeRun`. If this process dies, the next owner
 * finds them queued in storage and enqueues them again.
 *
 * @module services/scheduler/tasks/taskRunner
 */
import logger from '../../../utils/logger.js';
import { executeTaskRun } from './taskExecution.js';
import { currentPolicy } from './taskService.js';

const COMPONENT = 'ScheduledTaskRunner';

export class ScheduledTaskRunner {
  /**
   * @param {Object} [options]
   * @param {(job: {taskId: string, runId: string}) => Promise<void>} [options.execute]
   * @param {() => {maxConcurrentRuns: number, maxConcurrentRunsPerUser: number}} [options.limits]
   */
  constructor({
    execute = job => executeTaskRun(job),
    limits = () => currentPolicy().settings
  } = {}) {
    this.execute = execute;
    this.limits = limits;
    /** @type {Array<{taskId: string, runId: string, ownerId: string}>} */
    this.queue = [];
    /** @type {Map<string, {taskId: string, runId: string, ownerId: string, promise: Promise}>} */
    this.active = new Map();
  }

  /** Whether a run is waiting or executing here. */
  has(runId) {
    return this.active.has(runId) || this.queue.some(job => job.runId === runId);
  }

  /** Whether a run is executing here. */
  isRunning(runId) {
    return this.active.has(runId);
  }

  /**
   * Add a run. A run already here is not added twice.
   *
   * @param {{taskId: string, runId: string, ownerId: string}} job
   */
  enqueue(job) {
    if (!job?.taskId || !job?.runId || this.has(job.runId)) return;
    this.queue.push({ taskId: job.taskId, runId: job.runId, ownerId: job.ownerId || '' });
    this.pump();
  }

  _activeFor(ownerId) {
    let n = 0;
    for (const job of this.active.values()) if (job.ownerId === ownerId) n += 1;
    return n;
  }

  /** Start whatever the limits allow. */
  pump() {
    const { maxConcurrentRuns, maxConcurrentRunsPerUser } = this.limits();
    while (this.active.size < maxConcurrentRuns) {
      const index = this.queue.findIndex(
        job => this._activeFor(job.ownerId) < maxConcurrentRunsPerUser
      );
      if (index < 0) return;
      const [job] = this.queue.splice(index, 1);
      const promise = Promise.resolve()
        .then(() => this.execute(job))
        .catch(error =>
          logger.error('Scheduled run failed to execute', {
            component: COMPONENT,
            taskId: job.taskId,
            runId: job.runId,
            error: error.message
          })
        )
        .finally(() => {
          this.active.delete(job.runId);
          this.pump();
        });
      this.active.set(job.runId, { ...job, promise });
    }
  }

  /** Forget waiting runs (this process is no longer the owner). */
  clearQueue() {
    this.queue = [];
  }

  /** Wait for every executing run — tests and shutdown. */
  async drain() {
    while (this.active.size > 0 || this.queue.length > 0) {
      await Promise.all([...this.active.values()].map(job => job.promise));
      if (this.active.size === 0 && this.queue.length > 0) this.pump();
      if (this.active.size === 0) break;
    }
  }

  describe() {
    return {
      active: [...this.active.values()].map(({ taskId, runId }) => ({ taskId, runId })),
      queued: this.queue.map(({ taskId, runId }) => ({ taskId, runId }))
    };
  }
}

export default ScheduledTaskRunner;
