/**
 * User scheduled tasks as a scheduler source.
 *
 * The scheduler owner keeps an in-memory index — task id → next run, queued
 * run — rebuilt from storage when it becomes the owner (and periodically),
 * and updated on every change any worker announces (`taskEvents.js`). The
 * filesystem provider has no query index, so this is what keeps a tick from
 * reading every task; a database provider could answer "what is due" from an
 * indexed column instead without changing anything above this file.
 *
 * On a tick it
 *   - hands runs that are `queued` (run-now, an approved continuation, a
 *     claim a previous owner did not get to execute) to the runner, and
 *   - claims every task whose next run is due: under the task's lock it
 *     re-reads the task, plans the slot (`taskModel.planDueSlot`: run it,
 *     skip it because the previous run is still going, or record what a
 *     stopped scheduler missed and catch up the latest missed slot), moves
 *     the task to its next run, and stores the run records.
 *
 * Because only the lock owner ticks and every claim is a locked
 * compare-and-set on the task, a slot fires once across all workers.
 *
 * @module services/scheduler/tasks/taskSource
 */
import logger from '../../../utils/logger.js';
import { getScheduledTaskRepository } from './ScheduledTaskRepository.js';
import {
  applyRunOutcome,
  isFinalRunStatus,
  isOlderThanDays,
  planDueSlot,
  reasonOf,
  runLeaseHeld
} from './taskModel.js';
import { onTaskChanged, announceTaskChanged } from './taskEvents.js';
import { currentPolicy, failAwaitingRun } from './taskService.js';
import { ScheduledTaskRunner } from './taskRunner.js';

const COMPONENT = 'ScheduledTaskSource';

export const SCHEDULED_TASK_SOURCE_ID = 'scheduled-tasks';

/** How often the run history retention sweep runs. */
const RETENTION_SWEEP_MS = 24 * 60 * 60_000;

export class ScheduledTaskSource {
  /**
   * @param {Object} [options]
   * @param {() => Object} [options.repository]
   * @param {ScheduledTaskRunner} [options.runner]
   * @param {() => ReturnType<typeof currentPolicy>} [options.policy]
   * @param {() => void} [options.poke] - Ask the scheduler for a tick soon.
   */
  constructor({
    repository = () => getScheduledTaskRepository(),
    runner = new ScheduledTaskRunner(),
    policy = currentPolicy,
    poke = () => {}
  } = {}) {
    this.id = SCHEDULED_TASK_SOURCE_ID;
    this.repository = repository;
    this.runner = runner;
    this.policy = policy;
    this.poke = poke;
    /** @type {Map<string, {nextRunAt: number|null, queuedRunId: string|null, ownerId: string}>} */
    this.index = new Map();
    this.active = false;
    this._lastSweep = 0;
    this._unsubscribe = onTaskChanged(taskId => {
      if (!this.active) return;
      this.refresh(taskId)
        .then(() => this.poke())
        .catch(error =>
          logger.warn('Scheduled task index refresh failed', {
            component: COMPONENT,
            taskId,
            error: error.message
          })
        );
    });
  }

  /** Put a task into (or take it out of) the index. */
  _indexTask(task) {
    const queuedRunId = task.activeRun?.status === 'queued' ? task.activeRun.id : null;
    const nextRunAt =
      task.status === 'active' && task.nextRunAt ? Date.parse(task.nextRunAt) : null;
    if (!queuedRunId && (nextRunAt === null || !Number.isFinite(nextRunAt))) {
      this.index.delete(task.id);
      return;
    }
    this.index.set(task.id, {
      nextRunAt: Number.isFinite(nextRunAt) ? nextRunAt : null,
      queuedRunId,
      ownerId: task.ownerId
    });
  }

  /**
   * Re-read one task into the index.
   *
   * @param {string} taskId
   */
  async refresh(taskId) {
    const task = await this.repository().getTask(taskId);
    if (!task) this.index.delete(taskId);
    else this._indexTask(task);
  }

  async rebuild({ now, reason }) {
    const { configured } = this.policy();
    const repository = this.repository();
    if (!configured || !repository.isAvailable()) {
      this.active = false;
      this.index.clear();
      return;
    }
    this.active = true;
    const next = new Map();
    this.index = next;
    for await (const task of repository.scanTasks()) {
      // On every rebuild, not only on taking over: a run whose lease was still
      // held when this process became the owner is recovered once it lapses.
      const current = task.activeRun ? (await this._recover(task, now)) || task : task;
      this._indexTask(current);
    }
    logger.info('Scheduled task index built', {
      component: COMPONENT,
      reason,
      indexed: this.index.size
    });
  }

  /**
   * Settle what a previous owner left in flight: a run that was executing
   * when that process died is failed; an approval that expired while nobody
   * swept is failed; a queued run stays queued and is enqueued on the tick.
   */
  async _recover(task, now) {
    const active = task.activeRun;
    if (!active) return task;
    const repository = this.repository();
    if (active.status === 'running' && !this.runner.isRunning(active.id)) {
      const settings = this.policy().settings;
      let interrupted = false;
      const run = await repository.mutateRun(task.id, active.id, stored => {
        if (stored.status !== 'running') return null;
        // Not running here is not the same as dead: a worker that lost the
        // scheduler lock (a stalled heartbeat) may still be executing it. Only
        // a lease nobody renewed says the process is gone.
        if (runLeaseHeld(stored, now)) return null;
        interrupted = true;
        return {
          ...stored,
          status: 'failed',
          finishedAt: new Date(now).toISOString(),
          durationMs: stored.startedAt ? now - Date.parse(stored.startedAt) : null,
          reason: reasonOf('INTERRUPTED', 'The server stopped while the run was in progress', now)
        };
      });
      // No run document at all (a partial write, a deletion): nothing can hold
      // a lease on it, so the task is released below.
      if (!run) interrupted = true;
      // Still held: leave it to its worker; a later rebuild looks again.
      // Settled meanwhile by that worker: only release the task from it.
      if (!interrupted && !isFinalRunStatus(run.status)) return task;
      const { task: updated } = await repository.mutateTask(task.id, stored => {
        if (stored.activeRun?.id !== active.id) return null;
        return applyRunOutcome(
          stored,
          run || { ...active, status: 'failed', finishedAt: new Date(now).toISOString() },
          { now, settings }
        );
      });
      if (interrupted) {
        logger.warn('Scheduled run interrupted by a restart marked as failed', {
          component: COMPONENT,
          taskId: task.id,
          runId: active.id
        });
      }
      return updated || task;
    }
    if (active.status === 'awaiting_approval') {
      const run = await repository.getRun(task.id, active.id);
      const expiresAt = run?.approval?.expiresAt ? Date.parse(run.approval.expiresAt) : null;
      if (!run || (expiresAt && expiresAt < now)) {
        await failAwaitingRun(
          task.id,
          active.id,
          null,
          'APPROVAL_TIMED_OUT',
          'The approval timed out'
        );
        return repository.getTask(task.id);
      }
    }
    return task;
  }

  async runDue({ now }) {
    const { configured, settings } = this.policy();
    if (!configured) {
      if (this.active) this.clear();
      return;
    }
    // Switched on since the last rebuild: build the index now rather than
    // at the next periodic rebuild.
    if (!this.active) await this.rebuild({ now, reason: 'enabled' });
    if (!this.active) return;
    for (const [taskId, entry] of [...this.index]) {
      if (entry.queuedRunId && !this.runner.has(entry.queuedRunId)) {
        this.runner.enqueue({ taskId, runId: entry.queuedRunId, ownerId: entry.ownerId });
      }
      if (entry.nextRunAt !== null && entry.nextRunAt <= now) {
        try {
          await this._claim(taskId, now, settings);
        } catch (error) {
          logger.error('Could not claim a scheduled task slot', {
            component: COMPONENT,
            taskId,
            error: error.message
          });
        }
      }
    }
    if (now - this._lastSweep >= RETENTION_SWEEP_MS) {
      this._lastSweep = now;
      this.sweepRuns(now, settings).catch(error =>
        logger.warn('Scheduled run retention sweep failed', {
          component: COMPONENT,
          error: error.message
        })
      );
    }
  }

  async _claim(taskId, now, settings) {
    const repository = this.repository();
    let plan = null;
    const { task } = await repository.mutateTask(taskId, stored => {
      plan = planDueSlot(stored, { now, settings });
      return plan ? plan.task : null;
    });
    if (!task) {
      this.index.delete(taskId);
      return;
    }
    if (plan) {
      for (const run of plan.runs) await repository.putRun(run);
      if (plan.queued) {
        logger.info('Scheduled task run queued', {
          component: COMPONENT,
          taskId,
          runId: plan.queued.id,
          trigger: plan.queued.trigger
        });
      }
      if (plan.runs.some(run => run.status === 'skipped')) announceTaskChanged(taskId);
    }
    this._indexTask(task);
    if (plan?.queued) {
      this.runner.enqueue({ taskId, runId: plan.queued.id, ownerId: task.ownerId });
    }
  }

  /**
   * Delete run records older than the retention period (their chats age out
   * with the chat retention rules).
   *
   * @param {number} now
   * @param {Object} settings
   * @returns {Promise<number>}
   */
  async sweepRuns(now, settings) {
    if (!settings.runRetentionDays || settings.runRetentionDays <= 0) return 0;
    const repository = this.repository();
    const stale = [];
    for await (const run of repository.scanRuns()) {
      const at = run.finishedAt || run.queuedAt;
      if (run.status && ['queued', 'running', 'awaiting_approval'].includes(run.status)) continue;
      if (isOlderThanDays(at, settings.runRetentionDays, now)) stale.push(run);
    }
    for (const run of stale) await repository.deleteRun(run.taskId, run.id);
    if (stale.length > 0) {
      logger.info('Scheduled run records past retention deleted', {
        component: COMPONENT,
        deleted: stale.length
      });
    }
    return stale.length;
  }

  clear() {
    this.active = false;
    this.index.clear();
    this.runner.clearQueue();
  }

  describe() {
    return {
      indexed: this.index.size,
      ...this.runner.describe()
    };
  }
}

export default ScheduledTaskSource;
