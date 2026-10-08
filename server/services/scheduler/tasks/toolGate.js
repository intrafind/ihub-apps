/**
 * Which of the scheduling tools a turn is offered.
 *
 * An app opts in by listing them in its `tools`, like `ask_user`. They are
 * then withheld when scheduled tasks are off, from a user without the
 * permission, and — for the three that would let a task create, delete or
 * start tasks — inside a scheduled run. The tools that read a task's earlier
 * runs ({@link RUN_ONLY_TOOLS}) are never offered this way at all.
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
 * Tools only a scheduled run has: the ones that read the task's earlier runs.
 * `executeTaskRun` adds them to the run's own tool list when the task keeps
 * memory; an app can never offer them, whatever its `tools` say, and a task
 * can never pick them.
 */
export const RUN_ONLY_TOOLS = Object.freeze(new Set(['list_task_runs', 'get_task_run']));

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
  if (
    !Array.isArray(tools) ||
    !tools.some(tool => SCHEDULING_TOOLS.has(tool?.id) || RUN_ONLY_TOOLS.has(tool?.id))
  ) {
    return tools;
  }
  const available = configured
    ? configured()
    : isScheduledTasksConfigured(configCache.getFeatures(), configCache.getPlatform() || {});
  const allowed = available && canUseScheduledTasks(user);
  const inRun = Boolean(user?.scheduledRun);
  return tools.filter(tool => {
    if (RUN_ONLY_TOOLS.has(tool?.id)) return false;
    if (!SCHEDULING_TOOLS.has(tool?.id)) return true;
    if (!allowed) return false;
    return !(inRun && WITHHELD_IN_SCHEDULED_RUNS.has(tool.id));
  });
}
