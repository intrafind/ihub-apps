/**
 * Workflow schedule triggers as a scheduler source.
 *
 * A workflow's `triggers: [{ type: 'schedule', cron, timezone }]` used to
 * become one in-memory `Cron` per trigger, created once at boot — editing,
 * adding or deleting a workflow changed nothing until the next restart. This
 * source reads the triggers from the config cache on every tick instead (a
 * cheap etag comparison), so a saved workflow's schedule applies right away,
 * and computes the next run with the same arithmetic as scheduled tasks.
 *
 * Firing is unchanged: `TriggerManager.fireTrigger`, which runs the workflow
 * as the non-privileged `system` principal. Webhook triggers are not
 * scheduling and stay with the TriggerManager.
 *
 * Semantics kept from before: a slot missed while no process owned the
 * scheduler is skipped, not caught up. A slot found only slightly late (a
 * blocked event loop, a tick that ran long) still fires once.
 *
 * @module services/scheduler/workflowTriggerSource
 */
import configCache from '../../configCache.js';
import { isFeatureEnabled } from '../../featureRegistry.js';
import logger from '../../utils/logger.js';
import { nextSlot, normalizeSchedule, validateSchedule } from './schedule.js';

const COMPONENT = 'WorkflowTriggerSource';

export const WORKFLOW_TRIGGER_SOURCE_ID = 'workflow-triggers';

/** How late a slot may be found and still fire. */
export const WORKFLOW_LATE_GRACE_MS = 5 * 60_000;

function triggerKey(workflowId, triggerId) {
  return `${workflowId}:${triggerId}`;
}

async function defaultFire(workflowId, trigger) {
  const { getTriggerManager } = await import('../workflow/triggers/TriggerManager.js');
  return getTriggerManager().fireTrigger(workflowId, trigger);
}

export class WorkflowTriggerSource {
  /**
   * @param {Object} [options]
   * @param {() => {data: Object[], etag: string|null}} [options.getWorkflows] - Enabled workflows.
   * @param {(workflowId: string, trigger: Object) => Promise<void>} [options.fire]
   * @param {() => boolean} [options.isEnabled] - Whether workflows are switched on.
   */
  constructor({
    getWorkflows = () => configCache.getWorkflows(false),
    fire = defaultFire,
    isEnabled = () => isFeatureEnabled('workflows', configCache.getFeatures() || {})
  } = {}) {
    this.id = WORKFLOW_TRIGGER_SOURCE_ID;
    this.getWorkflows = getWorkflows;
    this.fire = fire;
    this.isEnabled = isEnabled;
    /** @type {Map<string, {workflowId: string, trigger: Object, schedule: Object, nextRunAt: number|null}>} */
    this.entries = new Map();
    this._etag = undefined;
    this._invalid = new Set();
  }

  /** Rebuild from the config cache. */
  async rebuild({ now }) {
    this._etag = undefined;
    this._sync(now);
  }

  clear() {
    this.entries.clear();
    this._etag = undefined;
  }

  /**
   * Bring the entries in line with the cached workflows. Entries whose
   * pattern did not change keep their next run; new or changed ones compute
   * it from now.
   */
  _sync(now) {
    const { data, etag } = this.getWorkflows() || {};
    if (etag && etag === this._etag) return;
    this._etag = etag || null;
    const next = this._computeEntries(data, now, this.entries);
    const added = [...next.keys()].filter(key => !this.entries.has(key));
    const removed = [...this.entries.keys()].filter(key => !next.has(key));
    if (added.length || removed.length) {
      logger.info('Workflow schedule triggers updated', {
        component: COMPONENT,
        active: next.size,
        added: added.length,
        removed: removed.length
      });
    }
    this.entries = next;
  }

  /**
   * The schedule entries of a set of workflows.
   *
   * @param {Object[]} workflows
   * @param {number} now
   * @param {Map} [previous] - Entries whose pattern is unchanged keep their next run.
   * @returns {Map}
   */
  _computeEntries(workflows, now, previous = new Map()) {
    const next = new Map();
    for (const workflow of Array.isArray(workflows) ? workflows : []) {
      if (!workflow?.id || !Array.isArray(workflow.triggers)) continue;
      for (const trigger of workflow.triggers) {
        if (trigger?.type !== 'schedule' || !trigger.id) continue;
        const key = triggerKey(workflow.id, trigger.id);
        const schedule = normalizeSchedule(
          { type: 'cron', cron: trigger.cron, timezone: trigger.timezone || 'UTC' },
          { timezone: 'UTC' }
        );
        const errors = validateSchedule(schedule, { now });
        if (errors.length > 0) {
          if (!this._invalid.has(key)) {
            this._invalid.add(key);
            logger.warn('Workflow schedule trigger ignored: invalid schedule', {
              component: COMPONENT,
              workflowId: workflow.id,
              triggerId: trigger.id,
              error: errors.map(e => e.message).join('; ')
            });
          }
          continue;
        }
        this._invalid.delete(key);
        const before = previous.get(key);
        const unchanged =
          before &&
          before.schedule.cron === schedule.cron &&
          before.schedule.timezone === schedule.timezone;
        next.set(key, {
          workflowId: workflow.id,
          trigger,
          schedule,
          nextRunAt: unchanged ? before.nextRunAt : this._nextAfter(schedule, now)
        });
      }
    }
    return next;
  }

  _nextAfter(schedule, now) {
    const slot = nextSlot(schedule, { after: now });
    return slot ? slot.getTime() : null;
  }

  async runDue({ now }) {
    if (!this.isEnabled()) return;
    this._sync(now);
    for (const entry of this.entries.values()) {
      if (entry.nextRunAt === null || entry.nextRunAt > now) continue;
      const late = now - entry.nextRunAt;
      entry.nextRunAt = this._nextAfter(entry.schedule, now);
      if (late > WORKFLOW_LATE_GRACE_MS) {
        logger.warn('Workflow schedule trigger slot missed; skipping to the next one', {
          component: COMPONENT,
          workflowId: entry.workflowId,
          triggerId: entry.trigger.id,
          lateMs: late
        });
        continue;
      }
      logger.info('Workflow schedule trigger due', {
        component: COMPONENT,
        workflowId: entry.workflowId,
        triggerId: entry.trigger.id
      });
      // Not awaited: a workflow run can take far longer than a tick.
      Promise.resolve()
        .then(() => this.fire(entry.workflowId, entry.trigger))
        .catch(error =>
          logger.error('Workflow schedule trigger failed to fire', {
            component: COMPONENT,
            workflowId: entry.workflowId,
            triggerId: entry.trigger.id,
            error: error.message
          })
        );
    }
  }

  describe() {
    return [...this.entries.values()].map(entry => ({
      workflowId: entry.workflowId,
      triggerId: entry.trigger.id,
      cron: entry.schedule.cron,
      timezone: entry.schedule.timezone,
      nextRun: entry.nextRunAt ? new Date(entry.nextRunAt).toISOString() : null
    }));
  }

  /**
   * Schedule triggers as `TriggerManager.getActiveTriggers()` reports them.
   *
   * @returns {Array<Object>}
   */
  activeTriggers(now = Date.now()) {
    // Only the scheduler owner keeps entries; any other worker answers from
    // the config, with the next run computed from now.
    const entries =
      this.entries.size > 0 ? this.entries : this._computeEntries(this.getWorkflows()?.data, now);
    return [...entries.values()].map(entry => ({
      workflowId: entry.workflowId,
      type: 'schedule',
      config: entry.trigger,
      nextRun: entry.nextRunAt ? new Date(entry.nextRunAt) : null
    }));
  }
}

export default WorkflowTriggerSource;
