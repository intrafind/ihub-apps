/**
 * Which of the scheduling tools a turn is offered.
 *
 * An app opts in by listing them in its `tools`, like `ask_user`. They are
 * then withheld when scheduled tasks are off, from a user without the
 * permission, and — for the three that would let a task create, delete or
 * start tasks — inside a scheduled run.
 *
 * @module services/scheduler/tasks/toolGate
 */
import configCache from '../../../configCache.js';
import { canUseScheduledTasks, isScheduledTasksConfigured } from './taskPolicy.js';

/** Every scheduling tool. */
export const SCHEDULING_TOOLS = Object.freeze(
  new Set([
    'schedule_task',
    'list_scheduled_tasks',
    'update_scheduled_task',
    'delete_scheduled_task',
    'run_scheduled_task_now'
  ])
);

/** Scheduling tools a scheduled run never gets. */
export const WITHHELD_IN_SCHEDULED_RUNS = Object.freeze(
  new Set(['schedule_task', 'delete_scheduled_task', 'run_scheduled_task_now'])
);

/**
 * Drop the scheduling tools this user may not have in this turn.
 *
 * @param {Array<Object>} tools
 * @param {Object|null} user - Expanded principal (`user.scheduledRun` inside a scheduled run).
 * @param {Object} [options]
 * @param {() => boolean} [options.configured] - Injectable for tests.
 * @returns {Array<Object>}
 */
export function filterSchedulingTools(tools, user, { configured } = {}) {
  if (!Array.isArray(tools) || !tools.some(tool => SCHEDULING_TOOLS.has(tool?.id))) return tools;
  const available = configured
    ? configured()
    : isScheduledTasksConfigured(configCache.getFeatures(), configCache.getPlatform() || {});
  const allowed = available && canUseScheduledTasks(user);
  const inRun = Boolean(user?.scheduledRun);
  return tools.filter(tool => {
    if (!SCHEDULING_TOOLS.has(tool?.id)) return true;
    if (!allowed) return false;
    return !(inRun && WITHHELD_IN_SCHEDULED_RUNS.has(tool.id));
  });
}
