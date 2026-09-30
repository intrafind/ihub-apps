/**
 * Scheduler bootstrap — one call from `server.js` in every worker.
 *
 * Registers the two job sources on the process-wide scheduler (workflow
 * schedule triggers, user scheduled tasks), connects scheduled-run approvals
 * to the interaction service, and starts ticking. Every worker ticks; only
 * the scheduler-lock owner acts on a tick.
 *
 * @module services/scheduler
 */
import logger from '../../utils/logger.js';
import interactionService from '../loop/InteractionService.js';
import { startSchedulerLockHeartbeat } from '../workflow/triggers/schedulerLock.js';
import { getTriggerManager } from '../workflow/triggers/TriggerManager.js';
import { getScheduler, resetScheduler } from './SchedulerService.js';
import { WorkflowTriggerSource } from './workflowTriggerSource.js';
import { ScheduledTaskSource } from './tasks/taskSource.js';
import { applyApprovalAnswer, applyApprovalExpiry } from './tasks/taskService.js';

const COMPONENT = 'Scheduler';

let initialized = false;
let unregisterAnswer = null;
let expiredListener = null;

/**
 * Start the scheduler in this process. Idempotent.
 *
 * @returns {import('./SchedulerService.js').SchedulerService}
 */
export function initScheduler() {
  const scheduler = getScheduler();
  if (initialized) return scheduler;
  initialized = true;

  // The lock decides which process ticks. The TriggerManager starts the same
  // heartbeat once the workflow engine is attached; starting it here too
  // keeps scheduled tasks working when workflow initialization fails.
  startSchedulerLockHeartbeat();

  const workflowSource = new WorkflowTriggerSource();
  scheduler.registerSource(workflowSource);
  getTriggerManager().setScheduleSource(workflowSource);

  scheduler.registerSource(new ScheduledTaskSource({ poke: () => scheduler.poke() }));

  // An approval of a scheduled run is answered on whichever worker got the
  // request (the run page, the chat, the generic answer endpoint): apply it
  // there, before the answer is stored, so a refused state change refuses
  // the answer too.
  unregisterAnswer = interactionService.onAnswer(interaction => applyApprovalAnswer(interaction));
  expiredListener = interaction => {
    applyApprovalExpiry(interaction).catch(error =>
      logger.warn('Could not fail a scheduled run whose approval expired', {
        component: COMPONENT,
        error: error.message
      })
    );
  };
  interactionService.on('expired', expiredListener);

  scheduler.start();
  logger.info('Scheduler started', {
    component: COMPONENT,
    sources: [...scheduler.sources.keys()]
  });
  return scheduler;
}

/** Stop the scheduler (shutdown). */
export function stopScheduler() {
  if (!initialized) return;
  initialized = false;
  unregisterAnswer?.();
  if (expiredListener) interactionService.off?.('expired', expiredListener);
  unregisterAnswer = null;
  expiredListener = null;
  resetScheduler();
}

export { getScheduler };
