import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import {
  deleteScheduledTaskMemory,
  fetchScheduledTaskMemory,
  writeScheduledTaskMemory
} from '../../../api';
import MemoryEditor from '../../../shared/components/MemoryEditor';
import { useScheduledTaskLimits } from '../hooks/useScheduledTasksConfig';
import { errorCode, errorMessage, responseData } from '../utils/taskFormat';

/**
 * The notes a task keeps between runs, for their owner: read, edit and clear
 * them. The content only ever travels through the owner API; the task document
 * carries a summary (`memorySummary`) and nothing else.
 *
 * The task page polls the task while a run is active and passes a new `task`
 * object every few seconds. The editor is keyed by the task id, so that never
 * touches unsaved text; a run that updates the notes changes
 * `task.memorySummary.version`, which makes the editor reload them, or ask first
 * when there are unsaved edits.
 *
 * @param {Object} props
 * @param {Object} props.task - The task as the page holds it.
 * @param {boolean} [props.readOnly=false] - The viewer may not edit tasks.
 * @param {() => void} [props.onChanged] - Called after the owner saved or cleared the
 *   notes, so the page refreshes its copy of the task (and its `memorySummary`).
 */
export default function TaskMemoryPanel({ task, readOnly = false, onChanged }) {
  const { t } = useTranslation();
  const limits = useScheduledTaskLimits();
  const [info, setInfo] = useState(null);

  async function load() {
    const data = await fetchScheduledTaskMemory(task.id);
    setInfo({ platformEnabled: data?.platformEnabled, maxChars: data?.maxChars });
    return data;
  }

  const save = payload => writeScheduledTaskMemory(task.id, payload);

  async function clear() {
    await deleteScheduledTaskMemory(task.id);
    if (onChanged) onChanged();
  }

  function formatError(err) {
    if (errorCode(err) === 'MEMORY_TOO_LONG') {
      const details = responseData(err)?.details || {};
      return t(
        'scheduledTasks.memory.tooLong',
        'The notes are too long ({{chars}} of {{max}} characters). Shorten them and save again.',
        { chars: details.chars, max: details.maxChars }
      );
    }
    return errorMessage(err, t('scheduledTasks.memory.error', 'The notes could not be saved'));
  }

  const platformOn = (info?.platformEnabled ?? limits.memoryEnabled) !== false;
  const memoryOn = task.memory?.enabled === true;

  const notice = (
    <div className="space-y-1">
      {!platformOn && (
        <p>
          {t(
            'scheduledTasks.memory.platformOffNotice',
            'Memory is switched off for the whole platform; these notes are kept but not used.'
          )}
        </p>
      )}
      {platformOn && !memoryOn && (
        <p>
          {t(
            'scheduledTasks.memory.offNotice',
            'Memory is off; these notes are kept but not used.'
          )}
        </p>
      )}
      {readOnly && (
        <p>
          {t(
            'scheduledTasks.memory.readOnlyNotice',
            'You are not allowed to edit scheduled tasks, so these notes are read-only.'
          )}
        </p>
      )}
      <p>
        {t(
          'scheduledTasks.memory.clearHint',
          'If you changed what the task does, consider clearing its memory.'
        )}
      </p>
    </div>
  );

  return (
    <>
      <h2 className="text-base font-semibold text-gray-900 dark:text-gray-100">
        {t('scheduledTasks.memory.title', 'Memory')}
      </h2>
      <p className="mt-1 mb-3 text-sm text-gray-600 dark:text-gray-400">
        {t(
          'scheduledTasks.memory.cardIntro',
          'Notes this task keeps between runs. A run reads them at the start and updates them when it is done.'
        )}
      </p>
      <MemoryEditor
        id={task.id}
        load={load}
        save={save}
        clear={clear}
        onSaved={onChanged}
        formatError={formatError}
        reloadKey={task.memorySummary?.version}
        readOnly={readOnly}
        maxChars={info?.maxChars ?? limits.memoryMaxChars}
        notice={notice}
        heightClassName="h-64"
      />
    </>
  );
}
