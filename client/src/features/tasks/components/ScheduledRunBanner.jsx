import { useCallback, useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import Icon from '../../../shared/components/Icon';
import { fetchScheduledTaskRun } from '../../../api';
import { useScheduledTasksEnabled } from '../hooks/useScheduledTasksConfig';
import { formatDateTime, reasonText } from '../utils/taskFormat';
import { RunStatusBadge } from './TaskBadges';
import ApprovalControls from './ApprovalControls';

const ACTIVE_STATUSES = new Set(['queued', 'running']);
/** How often a run that is going, and one that waits for an answer, is re-read. */
const ACTIVE_POLL_MS = 4000;
const WAITING_POLL_MS = 15000;

/**
 * The header of a chat a scheduled run created: "Scheduled run of <task> ·
 * <time>", a link back to the task, the run's status, and — while the run
 * waits for one — the approval it needs.
 *
 * @param {Object} props
 * @param {{createdVia: string, taskId: string, runId: string, taskName?: string}} props.origin
 * @param {() => void} [props.onRunChanged] - A run this banner followed finished (after
 *   an approval, say): the chat has new messages to read.
 */
export default function ScheduledRunBanner({ origin, onRunChanged }) {
  const { t, i18n } = useTranslation();
  const available = useScheduledTasksEnabled();
  const [run, setRun] = useState(null);

  const load = useCallback(() => {
    if (!origin?.taskId || !origin?.runId) return;
    fetchScheduledTaskRun(origin.taskId, origin.runId)
      .then(setRun)
      .catch(() => setRun(null));
  }, [origin?.taskId, origin?.runId]);

  useEffect(() => {
    if (available) load();
  }, [available, load]);

  // Follow a run that is still going (queued after an approval, or running),
  // and — more slowly — one waiting for an approval: it may be answered on the
  // task page or in another tab, or time out.
  const active = run && ACTIVE_STATUSES.has(run.status);
  const waiting = run?.status === 'awaiting_approval';
  useEffect(() => {
    if (!active && !waiting) return undefined;
    const id = setInterval(load, active ? ACTIVE_POLL_MS : WAITING_POLL_MS);
    return () => clearInterval(id);
  }, [active, waiting, load]);

  // The answer lands in the chat when the run ends, not when it is approved:
  // tell the chat once a run it watched going stops.
  const onRunChangedRef = useRef(onRunChanged);
  onRunChangedRef.current = onRunChanged;
  const followedRef = useRef(false);
  useEffect(() => {
    if (active || waiting) {
      followedRef.current = true;
    } else if (run && followedRef.current) {
      followedRef.current = false;
      onRunChangedRef.current?.();
    }
  }, [active, waiting, run]);

  if (origin?.createdVia !== 'scheduled-task') return null;
  const when = run?.startedAt || run?.scheduledFor;

  return (
    <div className="mx-auto w-full max-w-4xl px-4 pt-3">
      <div className="rounded-xl border border-indigo-200 dark:border-indigo-800 bg-indigo-50 dark:bg-indigo-900/20 px-4 py-2.5 text-sm space-y-2">
        <div className="flex flex-wrap items-center gap-2">
          <Icon name="calendar" size="sm" className="text-indigo-600 dark:text-indigo-400" />
          <span className="text-gray-800 dark:text-gray-200">
            {t('scheduledTasks.banner.title', 'Scheduled run of')}{' '}
            {available ? (
              <Link
                to={`/tasks/${origin.taskId}`}
                className="font-medium text-indigo-700 dark:text-indigo-300 hover:underline"
              >
                {origin.taskName || t('scheduledTasks.banner.task', 'a task')}
              </Link>
            ) : (
              <span className="font-medium">{origin.taskName}</span>
            )}
            {when ? ` · ${formatDateTime(when, i18n.language)}` : ''}
          </span>
          {run && <RunStatusBadge status={run.status} />}
        </div>
        {run?.status === 'awaiting_approval' && (
          <ApprovalControls taskId={origin.taskId} run={run} compact onAnswered={load} />
        )}
        {run?.status === 'failed' && run.reason?.message && (
          <p className="text-red-700 dark:text-red-300">{reasonText(t, run.reason)}</p>
        )}
      </div>
    </div>
  );
}
