// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

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

const MEMORY_PILL_TONES = {
  used: 'bg-sky-100 text-sky-800 dark:bg-sky-900/30 dark:text-sky-300',
  noChanges: 'bg-gray-100 text-gray-700 dark:bg-gray-700 dark:text-gray-300',
  updated: 'bg-indigo-100 text-indigo-800 dark:bg-indigo-900/30 dark:text-indigo-300',
  tooLong: 'bg-amber-100 text-amber-800 dark:bg-amber-900/30 dark:text-amber-300',
  failed: 'bg-amber-100 text-amber-800 dark:bg-amber-900/30 dark:text-amber-300'
};

/** The warning a failed notes update earns, by the `compose` result that names it. */
const WARNING_KINDS = { too_long: 'tooLong', failed: 'failed' };

/**
 * Whether the notes were written during the run: its update step wrote them, or the run
 * wrote them itself (write_memory), which moves the version on.
 */
function wroteNotes({ compose, versionRead, versionWritten }) {
  return (
    compose === 'written' ||
    (Number.isFinite(versionWritten) &&
      Number.isFinite(versionRead) &&
      versionWritten > versionRead)
  );
}

/**
 * Whether the run started from stored notes. Version 0 is "nothing was ever written": a
 * first run has no notes to have used.
 */
function usedStoredNotes({ versionRead }) {
  return Number.isInteger(versionRead) && versionRead > 0;
}

/**
 * The warning for notes that could not be updated, if any. A run that wrote its notes itself
 * did update them, even when the update after it failed: no warning then, it would contradict
 * "Memory updated".
 */
function warningKind(memory, updated) {
  return updated ? null : (WARNING_KINDS[memory.compose] ?? null);
}

/**
 * The badges a run's `memory` marker earns, in the order they are shown.
 *
 * @param {Object} memory - The run's `memory` marker.
 * @returns {Array<'used'|'noChanges'|'updated'|'tooLong'|'failed'>}
 */
function memoryBadgeKinds(memory) {
  const updated = wroteNotes(memory);
  return [
    usedStoredNotes(memory) && 'used',
    memory.changed === false && 'noChanges',
    updated && 'updated',
    warningKind(memory, updated)
  ].filter(Boolean);
}

/**
 * The label of a memory badge and, where it has one, the hint shown on hover. One entry per
 * badge, so only the text that is shown is looked up.
 */
const MEMORY_PILL_TEXTS = {
  used: (t, version) => [
    t('scheduledTasks.runs.notesUsed', 'Used notes v{{version}}', { version }),
    t(
      'scheduledTasks.runs.notesUsedHint',
      'This run started with version {{version}} of the notes of this task.',
      { version }
    )
  ],
  noChanges: t => [t('scheduledTasks.runs.noChanges', 'No changes')],
  updated: t => [t('scheduledTasks.runs.memoryUpdated', 'Memory updated')],
  tooLong: t => [
    t('scheduledTasks.runs.memoryTooLong', 'Memory full'),
    t(
      'scheduledTasks.runs.memoryTooLongHint',
      'The new notes were over the size limit, so the previous notes were kept.'
    )
  ],
  failed: t => [
    t('scheduledTasks.runs.memoryFailed', 'Memory not updated'),
    t(
      'scheduledTasks.runs.memoryFailedHint',
      'The notes could not be updated after this run, so the previous notes were kept.'
    )
  ]
};

function MemoryPill({ kind, version }) {
  const { t } = useTranslation();
  const [label, hint] = MEMORY_PILL_TEXTS[kind](t, version);
  return (
    <span className={`${pill} ${MEMORY_PILL_TONES[kind]}`} title={hint}>
      {label}
    </span>
  );
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
  if (!memory) return null;
  const kinds = memoryBadgeKinds(memory);
  if (kinds.length === 0) return null;
  return (
    <div className="flex flex-wrap gap-1.5">
      {kinds.map(kind => (
        <MemoryPill key={kind} kind={kind} version={memory.versionRead} />
      ))}
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
