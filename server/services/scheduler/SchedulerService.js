/**
 * The scheduler — one ticker, on one process, for every scheduled job.
 *
 * iHub had two ways to run something later: in-memory `Cron` instances per
 * workflow trigger, registered at boot only, and nothing at all for user
 * work. This replaces both with a single loop driven by stored data:
 *
 *   1. every worker runs a cheap interval timer;
 *   2. only the scheduler-lock owner (`schedulerLock.js`) does anything on a
 *      tick — it asks each registered **source** to run what is due;
 *   3. a source keeps its own index of "what runs next" (rebuilt when this
 *      process becomes the owner, and periodically as a safety net) and
 *      computes next run times with `schedule.js`, so nothing holds a timer
 *      per job and edits apply on the next tick without re-registration.
 *
 * Two sources exist: user scheduled tasks (`tasks/taskSource.js`) and
 * workflow schedule triggers (`workflowTriggerSource.js`). They share the
 * clock, the lock, the schedule arithmetic and this lifecycle; what a fire
 * *does* — a chat turn as the task owner, a workflow execution — stays with
 * the source.
 *
 * @module services/scheduler/SchedulerService
 */
import { isSchedulerOwner } from '../workflow/triggers/schedulerLock.js';
import logger from '../../utils/logger.js';

const COMPONENT = 'Scheduler';

/** How often every worker looks at the clock. */
export const DEFAULT_TICK_MS = 15_000;
/** How often the owner rebuilds its indexes from storage, as a safety net. */
export const DEFAULT_REBUILD_MS = 10 * 60_000;

/**
 * A job source.
 *
 * @typedef {Object} SchedulerSource
 * @property {string} id - Unique source id (for logs).
 * @property {(ctx: {now: number, reason: string}) => Promise<void>} rebuild - Build the index
 *   from storage/config. Called when this process becomes the owner and every
 *   `rebuildMs`.
 * @property {(ctx: {now: number}) => Promise<void>} runDue - Fire what is due.
 * @property {() => void} [clear] - Forget the index (this process lost ownership).
 * @property {() => Array<Object>} [describe] - What the source has scheduled (admin view).
 */

export class SchedulerService {
  /**
   * @param {Object} [options]
   * @param {number} [options.tickMs]
   * @param {number} [options.rebuildMs]
   * @param {() => boolean} [options.isOwner] - Lock ownership probe (tests inject).
   * @param {() => number} [options.now]
   */
  constructor({
    tickMs = DEFAULT_TICK_MS,
    rebuildMs = DEFAULT_REBUILD_MS,
    isOwner = isSchedulerOwner,
    now = () => Date.now()
  } = {}) {
    this.tickMs = tickMs;
    this.rebuildMs = rebuildMs;
    this.isOwner = isOwner;
    this.now = now;
    /** @type {Map<string, SchedulerSource>} */
    this.sources = new Map();
    this._timer = null;
    this._pokeTimer = null;
    this._ticking = null;
    this._owner = false;
    this._builtAt = new Map();
    this._rebuildRequested = new Set();
  }

  /**
   * Add a source. Registering the same id again replaces it.
   *
   * @param {SchedulerSource} source
   */
  registerSource(source) {
    this.sources.set(source.id, source);
    this._builtAt.delete(source.id);
  }

  /** @param {string} id */
  getSource(id) {
    return this.sources.get(id) || null;
  }

  /** Start ticking. Idempotent. */
  start() {
    if (this._timer) return;
    this._timer = setInterval(() => {
      this.tick().catch(error =>
        logger.error('Scheduler tick failed', { component: COMPONENT, error: error.message })
      );
    }, this.tickMs);
    this._timer.unref?.();
    // First look soon after boot rather than a full interval later.
    this.poke(1000);
  }

  /** Stop ticking and forget every index. */
  stop() {
    if (this._timer) clearInterval(this._timer);
    if (this._pokeTimer) clearTimeout(this._pokeTimer);
    this._timer = null;
    this._pokeTimer = null;
    for (const source of this.sources.values()) source.clear?.();
    this._builtAt.clear();
    this._owner = false;
  }

  /**
   * Ask for a tick soon — after a task was created, edited or asked to run
   * now — instead of waiting for the next interval.
   *
   * @param {number} [delayMs=250]
   */
  poke(delayMs = 250) {
    if (this._pokeTimer) return;
    this._pokeTimer = setTimeout(() => {
      this._pokeTimer = null;
      this.tick().catch(error =>
        logger.error('Scheduler tick failed', { component: COMPONENT, error: error.message })
      );
    }, delayMs);
    this._pokeTimer.unref?.();
  }

  /**
   * Have a source rebuild its index on the next tick.
   *
   * @param {string} sourceId
   */
  requestRebuild(sourceId) {
    this._rebuildRequested.add(sourceId);
    this.poke();
  }

  /**
   * One tick. Never runs twice at once: a tick that finds the previous one
   * still going waits for it instead.
   *
   * @returns {Promise<void>}
   */
  async tick() {
    if (this._ticking) return this._ticking;
    this._ticking = this._tick().finally(() => {
      this._ticking = null;
    });
    return this._ticking;
  }

  async _tick() {
    const owner = this.isOwner();
    if (!owner) {
      if (this._owner) {
        logger.info('Scheduler: no longer the scheduler-lock owner; standing down', {
          component: COMPONENT
        });
        for (const source of this.sources.values()) source.clear?.();
        this._builtAt.clear();
      }
      this._owner = false;
      return;
    }
    const becameOwner = !this._owner;
    this._owner = true;
    const now = this.now();
    for (const source of this.sources.values()) {
      const builtAt = this._builtAt.get(source.id);
      const reason = becameOwner
        ? 'owner'
        : this._rebuildRequested.has(source.id)
          ? 'requested'
          : builtAt === undefined || now - builtAt >= this.rebuildMs
            ? 'periodic'
            : null;
      if (reason) {
        this._rebuildRequested.delete(source.id);
        try {
          await source.rebuild({ now, reason });
          this._builtAt.set(source.id, now);
        } catch (error) {
          logger.error('Scheduler source rebuild failed', {
            component: COMPONENT,
            source: source.id,
            error: error.message
          });
          continue;
        }
      }
      try {
        await source.runDue({ now: this.now() });
      } catch (error) {
        logger.error('Scheduler source failed to run due jobs', {
          component: COMPONENT,
          source: source.id,
          error: error.message
        });
      }
    }
  }

  /** Whether this process ran the last tick as the owner. */
  isActiveOwner() {
    return this._owner;
  }

  /**
   * What every source has scheduled, for the admin view.
   *
   * @returns {Object<string, Array<Object>>}
   */
  describe() {
    const out = {};
    for (const [id, source] of this.sources) out[id] = source.describe?.() || [];
    return out;
  }
}

let instance = null;

/**
 * The process-wide scheduler.
 *
 * @returns {SchedulerService}
 */
export function getScheduler() {
  if (!instance) instance = new SchedulerService();
  return instance;
}

/** Stop and forget the process-wide scheduler (shutdown, tests). */
export function resetScheduler() {
  instance?.stop();
  instance = null;
}

export default getScheduler;
