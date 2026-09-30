import { useTranslation } from 'react-i18next';
import { RUN_STATUS_CLASSES, TASK_STATUS_CLASSES } from '../utils/taskFormat';

const pill =
  'inline-flex items-center px-2 py-0.5 rounded-full text-xs font-medium whitespace-nowrap';

/** The status of a task (active, paused, completed, disabled). */
export function TaskStatusBadge({ status }) {
  const { t } = useTranslation();
  const labels = {
    active: t('scheduledTasks.status.active', 'Active'),
    paused: t('scheduledTasks.status.paused', 'Paused'),
    completed: t('scheduledTasks.status.completed', 'Completed'),
    disabled: t('scheduledTasks.status.disabled', 'Disabled')
  };
  return (
    <span className={`${pill} ${TASK_STATUS_CLASSES[status] || TASK_STATUS_CLASSES.completed}`}>
      {labels[status] || status}
    </span>
  );
}

/** The status of a run. */
export function RunStatusBadge({ status }) {
  const { t } = useTranslation();
  const labels = {
    queued: t('scheduledTasks.runStatus.queued', 'Queued'),
    running: t('scheduledTasks.runStatus.running', 'Running'),
    awaiting_approval: t('scheduledTasks.runStatus.awaiting_approval', 'Needs approval'),
    succeeded: t('scheduledTasks.runStatus.succeeded', 'Succeeded'),
    failed: t('scheduledTasks.runStatus.failed', 'Failed'),
    skipped: t('scheduledTasks.runStatus.skipped', 'Skipped'),
    cancelled: t('scheduledTasks.runStatus.cancelled', 'Cancelled')
  };
  return (
    <span className={`${pill} ${RUN_STATUS_CLASSES[status] || RUN_STATUS_CLASSES.queued}`}>
      {status === 'running' && (
        <span className="mr-1 h-1.5 w-1.5 rounded-full bg-current animate-pulse" aria-hidden />
      )}
      {labels[status] || status}
    </span>
  );
}

/** How a run was started. */
export function RunTriggerLabel({ trigger }) {
  const { t } = useTranslation();
  const labels = {
    schedule: t('scheduledTasks.trigger.schedule', 'Scheduled'),
    manual: t('scheduledTasks.trigger.manual', 'Run now'),
    'catch-up': t('scheduledTasks.trigger.catchUp', 'Catch-up')
  };
  return <span>{labels[trigger] || trigger}</span>;
}
