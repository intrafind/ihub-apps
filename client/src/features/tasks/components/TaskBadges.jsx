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

/**
 * Which memory badges a run's `memory` marker earns.
 *
 * @param {{changed?: boolean|null, compose?: string, versionRead?: number,
 *   versionWritten?: number}} memory
 * @returns {{usedVersion: number|null, unchanged: boolean, updated: boolean,
 *   tooLong: boolean, failed: boolean}}
 */
function memoryBadgeState(memory) {
  // Version 0 is "nothing was ever written": a first run has no notes to have used.
  const usedVersion =
    Number.isInteger(memory.versionRead) && memory.versionRead > 0 ? memory.versionRead : null;
  const updated =
    memory.compose === 'written' ||
    (Number.isFinite(memory.versionWritten) &&
      Number.isFinite(memory.versionRead) &&
      memory.versionWritten > memory.versionRead);
  return {
    usedVersion,
    unchanged: memory.changed === false,
    updated,
    // A run that wrote its notes itself (write_memory) did update them, even when the
    // update after it failed: no warning then, it would contradict "Memory updated".
    tooLong: !updated && memory.compose === 'too_long',
    failed: !updated && memory.compose === 'failed'
  };
}

/**
 * What a run did with the task's memory: "Used notes v2" when it started from
 * stored notes (the notes go into the run's system prompt, which the chat never
 * shows, so this is the one visible sign that they were loaded), "No changes"
 * when it reported nothing new, "Memory updated" when it wrote the notes, and a
 * warning when the notes could not be updated (too long even after a retry, or
 * the reply was unusable). Runs of tasks without memory (and runs from before
 * the feature) carry no `memory` and show nothing.
 *
 * @param {Object} props
 * @param {{changed?: boolean|null, compose?: string, versionRead?: number,
 *   versionWritten?: number}} [props.memory] - The run's `memory` marker.
 */
export function RunMemoryBadges({ memory }) {
  const { t } = useTranslation();
  if (!memory) return null;
  const { usedVersion, unchanged, updated, tooLong, failed } = memoryBadgeState(memory);
  if (usedVersion === null && !(unchanged || updated || tooLong || failed)) return null;
  return (
    <div className="flex flex-wrap gap-1.5">
      {usedVersion !== null && (
        <span
          className={`${pill} bg-sky-100 text-sky-800 dark:bg-sky-900/30 dark:text-sky-300`}
          title={t(
            'scheduledTasks.runs.notesUsedHint',
            'This run started with version {{version}} of the notes of this task.',
            { version: usedVersion }
          )}
        >
          {t('scheduledTasks.runs.notesUsed', 'Used notes v{{version}}', {
            version: usedVersion
          })}
        </span>
      )}
      {unchanged && (
        <span className={`${pill} bg-gray-100 text-gray-700 dark:bg-gray-700 dark:text-gray-300`}>
          {t('scheduledTasks.runs.noChanges', 'No changes')}
        </span>
      )}
      {updated && (
        <span
          className={`${pill} bg-indigo-100 text-indigo-800 dark:bg-indigo-900/30 dark:text-indigo-300`}
        >
          {t('scheduledTasks.runs.memoryUpdated', 'Memory updated')}
        </span>
      )}
      {(tooLong || failed) && (
        <span
          className={`${pill} bg-amber-100 text-amber-800 dark:bg-amber-900/30 dark:text-amber-300`}
          title={
            tooLong
              ? t(
                  'scheduledTasks.runs.memoryTooLongHint',
                  'The new notes were over the size limit, so the previous notes were kept.'
                )
              : t(
                  'scheduledTasks.runs.memoryFailedHint',
                  'The notes could not be updated after this run, so the previous notes were kept.'
                )
          }
        >
          {tooLong
            ? t('scheduledTasks.runs.memoryTooLong', 'Memory full')
            : t('scheduledTasks.runs.memoryFailed', 'Memory not updated')}
        </span>
      )}
    </div>
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
