import { useCallback, useEffect, useMemo, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import Icon from '../../../shared/components/Icon';
import Modal from '../../../shared/components/Modal';
import useApps from '../../../shared/hooks/useApps';
import { getLocalizedContent } from '../../../utils/localizeContent';
import {
  cancelScheduledTaskRun,
  deleteScheduledTask,
  duplicateScheduledTask,
  fetchScheduledTask,
  fetchScheduledTaskRuns,
  pauseScheduledTask,
  resumeScheduledTask,
  revokeScheduledTaskTool,
  runScheduledTaskNow
} from '../../../api';
import {
  RunMemoryBadges,
  RunStatusBadge,
  RunTriggerLabel,
  TaskStatusBadge
} from '../components/TaskBadges';
import ApprovalControls from '../components/ApprovalControls';
import TaskMemoryPanel from '../components/TaskMemoryPanel';
import { useCanCreateScheduledTasks, useNow } from '../hooks/useScheduledTasks';
import {
  errorMessage,
  formatDateTime,
  formatDuration,
  formatRelative,
  isRunActive,
  reasonText,
  runChatLink
} from '../utils/taskFormat';

const button =
  'inline-flex items-center gap-2 px-3 py-2 rounded-lg text-sm font-medium border border-gray-300 dark:border-gray-600 text-gray-700 dark:text-gray-200 hover:bg-gray-50 dark:hover:bg-gray-800 disabled:opacity-50';
const card =
  'bg-white dark:bg-gray-800/60 border border-gray-200 dark:border-gray-700 rounded-xl p-5';

/**
 * `/tasks/:taskId` — one task: what it does, when it runs next, what it may do
 * without asking, and its run history with a link into each run's chat.
 */
export default function TaskDetailPage() {
  const { t, i18n } = useTranslation();
  const language = i18n.language;
  const { taskId } = useParams();
  const navigate = useNavigate();
  const { apps } = useApps();
  const canCreate = useCanCreateScheduledTasks();
  const now = useNow();
  const [task, setTask] = useState(null);
  const [runs, setRuns] = useState([]);
  const [cursor, setCursor] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [notice, setNotice] = useState(null);
  const [busy, setBusy] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [deleteChats, setDeleteChats] = useState(false);

  const load = useCallback(async () => {
    try {
      const [current, page] = await Promise.all([
        fetchScheduledTask(taskId),
        fetchScheduledTaskRuns(taskId, { limit: 20 })
      ]);
      setTask(current);
      setRuns(page.items || []);
      setCursor(page.nextCursor || null);
      setError(null);
    } catch (err) {
      setError(errorMessage(err, t('scheduledTasks.errors.load', 'Tasks could not be loaded')));
    } finally {
      setLoading(false);
    }
  }, [taskId, t]);

  useEffect(() => {
    load();
  }, [load]);

  // Follow a run while it is in flight.
  const active = Boolean(task?.activeRun);
  useEffect(() => {
    if (!active) return undefined;
    const id = setInterval(load, 4000);
    return () => clearInterval(id);
  }, [active, load]);

  async function loadMore() {
    const page = await fetchScheduledTaskRuns(taskId, { limit: 20, cursor });
    setRuns(prev => [...prev, ...(page.items || [])]);
    setCursor(page.nextCursor || null);
  }

  async function act(fn, success) {
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      const result = await fn();
      if (success) setNotice(success);
      await load();
      return result;
    } catch (err) {
      setError(errorMessage(err));
      return null;
    } finally {
      setBusy(false);
    }
  }

  const app = useMemo(() => apps.find(a => a.id === task?.appId), [apps, task?.appId]);
  const appName = getLocalizedContent(app?.name, language) || task?.appId;

  if (loading) {
    return (
      <div className="min-h-full bg-gray-50 dark:bg-gray-900 px-6 py-10">
        <p className="max-w-5xl mx-auto text-gray-500">{t('common.loading', 'Loading…')}</p>
      </div>
    );
  }
  if (!task) {
    return (
      <div className="min-h-full bg-gray-50 dark:bg-gray-900 px-6 py-10">
        <div className="max-w-5xl mx-auto">
          <Link to="/tasks" className="text-sm text-indigo-600 hover:underline">
            ← {t('scheduledTasks.backToTasks', 'Scheduled tasks')}
          </Link>
          <p className="mt-4 text-red-600">
            {error || t('scheduledTasks.notFound', 'Task not found')}
          </p>
        </div>
      </div>
    );
  }

  const runningNow = task.activeRun && isRunActive(task.activeRun.status);

  return (
    <div className="min-h-full bg-gray-50 dark:bg-gray-900 px-4 sm:px-6 py-8">
      <div className="max-w-5xl mx-auto space-y-6">
        <div>
          <Link
            to="/tasks"
            className="text-sm text-indigo-600 dark:text-indigo-400 hover:underline"
          >
            ← {t('scheduledTasks.backToTasks', 'Scheduled tasks')}
          </Link>
          <div className="mt-2 flex flex-wrap items-start justify-between gap-4">
            <div>
              <div className="flex items-center gap-3 flex-wrap">
                <h1 className="text-2xl font-semibold text-gray-900 dark:text-gray-100">
                  {task.name}
                </h1>
                <TaskStatusBadge status={task.status} />
              </div>
              {task.description && (
                <p className="mt-1 text-sm text-gray-600 dark:text-gray-400">{task.description}</p>
              )}
            </div>
            <div className="flex flex-wrap gap-2">
              <button
                type="button"
                className={button}
                disabled={busy || runningNow || task.status === 'disabled' || !canCreate}
                onClick={() =>
                  act(
                    () => runScheduledTaskNow(task.id),
                    t('scheduledTasks.runQueued', 'Run started')
                  )
                }
              >
                <Icon name="play" size="sm" />
                {t('scheduledTasks.runNow', 'Run now')}
              </button>
              {task.status === 'active' ? (
                <button
                  type="button"
                  className={button}
                  disabled={busy}
                  onClick={() => act(() => pauseScheduledTask(task.id))}
                >
                  {t('scheduledTasks.pause', 'Pause')}
                </button>
              ) : (
                task.status !== 'disabled' && (
                  <button
                    type="button"
                    className={button}
                    disabled={busy || !canCreate}
                    onClick={() => act(() => resumeScheduledTask(task.id))}
                  >
                    {t('scheduledTasks.resume', 'Resume')}
                  </button>
                )
              )}
              {canCreate && (
                <Link to={`/tasks/${task.id}/edit`} className={button}>
                  <Icon name="pencil" size="sm" />
                  {t('common.edit', 'Edit')}
                </Link>
              )}
              {canCreate && (
                <button
                  type="button"
                  className={button}
                  disabled={busy}
                  onClick={async () => {
                    const copy = await act(() => duplicateScheduledTask(task.id));
                    if (copy?.id) navigate(`/tasks/${copy.id}`);
                  }}
                >
                  <Icon name="document-duplicate" size="sm" />
                  {t('scheduledTasks.duplicate', 'Duplicate')}
                </button>
              )}
              <button
                type="button"
                className={`${button} text-red-600 dark:text-red-400`}
                disabled={busy}
                onClick={() => setConfirmDelete(true)}
              >
                <Icon name="trash" size="sm" />
                {t('common.delete', 'Delete')}
              </button>
            </div>
          </div>
        </div>

        {(error || notice) && (
          <div
            role={error ? 'alert' : 'status'}
            className={`rounded-lg px-4 py-3 text-sm border ${
              error
                ? 'border-red-200 bg-red-50 text-red-700 dark:bg-red-900/20 dark:border-red-800 dark:text-red-300'
                : 'border-green-200 bg-green-50 text-green-700 dark:bg-green-900/20 dark:border-green-800 dark:text-green-300'
            }`}
          >
            {error || notice}
          </div>
        )}

        {task.status !== 'active' && task.statusReason?.message && (
          <div
            className={`rounded-lg border px-4 py-3 text-sm ${
              task.status === 'completed'
                ? 'border-gray-200 bg-gray-50 text-gray-700 dark:bg-gray-800/40 dark:border-gray-700 dark:text-gray-300'
                : 'border-amber-200 bg-amber-50 text-amber-800 dark:bg-amber-900/20 dark:border-amber-800 dark:text-amber-300'
            }`}
          >
            {reasonText(t, task.statusReason)}
            {task.statusReason.lastError ? ` — ${task.statusReason.lastError}` : ''}
          </div>
        )}

        <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
          <section className={`${card} lg:col-span-2 space-y-4`}>
            <h2 className="text-base font-semibold text-gray-900 dark:text-gray-100">
              {t('scheduledTasks.fields.instructions', 'Instructions')}
            </h2>
            <pre className="whitespace-pre-wrap text-sm text-gray-800 dark:text-gray-200 font-sans bg-gray-50 dark:bg-gray-900/50 rounded-lg p-3">
              {task.instructions}
            </pre>
            <dl className="grid grid-cols-1 sm:grid-cols-2 gap-x-6 gap-y-3 text-sm">
              <div>
                <dt className="text-gray-500">{t('scheduledTasks.fields.app', 'App')}</dt>
                <dd className="text-gray-900 dark:text-gray-100">
                  {appName}
                  {task.modelId ? ` · ${task.modelId}` : ''}
                </dd>
              </div>
              <div>
                <dt className="text-gray-500">
                  {t('scheduledTasks.fields.tools', 'Tools and integrations')}
                </dt>
                <dd className="text-gray-900 dark:text-gray-100">
                  {Array.isArray(task.enabledTools)
                    ? task.enabledTools.join(', ') || t('scheduledTasks.noTools', 'None')
                    : t('scheduledTasks.fields.appDefaultTools', "Use the app's defaults")}
                </dd>
              </div>
              <div>
                <dt className="text-gray-500">{t('scheduledTasks.fields.notify', 'Notify me')}</dt>
                <dd className="text-gray-900 dark:text-gray-100">
                  {t(`scheduledTasks.notify.${task.notify}`, task.notify)}
                </dd>
              </div>
              <div>
                <dt className="text-gray-500">{t('scheduledTasks.memory.title', 'Memory')}</dt>
                <dd className="text-gray-900 dark:text-gray-100">
                  {task.memory?.enabled === true
                    ? t('scheduledTasks.memory.on', 'On')
                    : t('scheduledTasks.memory.off', 'Off')}
                </dd>
              </div>
              {task.variables && Object.keys(task.variables).length > 0 && (
                <div>
                  <dt className="text-gray-500">
                    {t('scheduledTasks.fields.variables', 'App variables')}
                  </dt>
                  <dd className="text-gray-900 dark:text-gray-100">
                    {Object.entries(task.variables)
                      .map(([name, value]) => `${name}: ${value}`)
                      .join(', ')}
                  </dd>
                </div>
              )}
            </dl>
          </section>

          <section className={`${card} space-y-3`}>
            <h2 className="text-base font-semibold text-gray-900 dark:text-gray-100">
              {t('scheduledTasks.fields.schedule', 'Schedule')}
            </h2>
            <p className="text-sm text-gray-800 dark:text-gray-200">{task.scheduleDescription}</p>
            {task.upcomingRuns?.length > 0 && (
              <div>
                <p className="text-xs uppercase tracking-wide text-gray-500">
                  {t('scheduledTasks.schedule.nextRuns', 'Next runs')}
                </p>
                <ul className="mt-1 text-sm text-gray-700 dark:text-gray-300 space-y-0.5">
                  {task.upcomingRuns.map(run => (
                    <li key={run}>
                      {formatDateTime(run, language, { weekday: true })}{' '}
                      <span className="text-xs text-gray-500">
                        ({formatRelative(run, language, now)})
                      </span>
                    </li>
                  ))}
                </ul>
              </div>
            )}
            {task.staggerMinutes > 0 && task.schedule?.type !== 'manual' && (
              <p className="text-xs text-gray-500">
                {t(
                  'scheduledTasks.schedule.staggerNote',
                  'To spread the load, a run may start up to {{minutes}} minutes late.',
                  { minutes: task.staggerMinutes }
                )}
              </p>
            )}
          </section>
        </div>

        <section className={card}>
          <h2 className="text-base font-semibold text-gray-900 dark:text-gray-100">
            {t('scheduledTasks.allowedActions', 'Allowed without asking')}
          </h2>
          <p className="mt-1 text-sm text-gray-600 dark:text-gray-400">
            {t(
              'scheduledTasks.allowedActionsHint',
              'Tools that need approval pause a run until you answer. Those you chose "Always allow for this task" for run without asking.'
            )}
          </p>
          {task.allowedTools?.length > 0 ? (
            <ul className="mt-3 divide-y divide-gray-100 dark:divide-gray-700">
              {task.allowedTools.map(entry => (
                <li key={entry.toolId} className="flex items-center justify-between py-2 text-sm">
                  <span className="font-mono text-gray-800 dark:text-gray-200">{entry.toolId}</span>
                  <button
                    type="button"
                    className="text-red-600 dark:text-red-400 hover:underline"
                    onClick={() => act(() => revokeScheduledTaskTool(task.id, entry.toolId))}
                  >
                    {t('scheduledTasks.revoke', 'Revoke')}
                  </button>
                </li>
              ))}
            </ul>
          ) : (
            <p className="mt-3 text-sm text-gray-500">
              {t('scheduledTasks.noAllowedActions', 'Nothing yet.')}
            </p>
          )}
        </section>

        <section className={card}>
          <TaskMemoryPanel task={task} readOnly={!canCreate} onChanged={load} />
        </section>

        <section className={card}>
          <h2 className="text-base font-semibold text-gray-900 dark:text-gray-100">
            {t('scheduledTasks.runHistory', 'Run history')}
          </h2>
          <p className="mt-1 text-xs text-gray-500">
            {t(
              'scheduledTasks.succeededHint',
              '"Succeeded" means the run finished without an error — open its chat to see whether it did what you wanted.'
            )}
          </p>
          {runs.length === 0 ? (
            <p className="mt-4 text-sm text-gray-500">
              {t('scheduledTasks.noRuns', 'No runs yet.')}
            </p>
          ) : (
            <div className="mt-4 overflow-x-auto">
              <table className="min-w-full text-sm">
                <thead>
                  <tr className="text-left text-xs uppercase tracking-wide text-gray-500">
                    <th className="py-2 pr-4">{t('scheduledTasks.runs.status', 'Status')}</th>
                    <th className="py-2 pr-4">{t('scheduledTasks.runs.trigger', 'Trigger')}</th>
                    <th className="py-2 pr-4">{t('scheduledTasks.runs.scheduled', 'Scheduled')}</th>
                    <th className="py-2 pr-4">{t('scheduledTasks.runs.started', 'Started')}</th>
                    <th className="py-2 pr-4">{t('scheduledTasks.runs.duration', 'Duration')}</th>
                    <th className="py-2 pr-4">{t('scheduledTasks.runs.result', 'Result')}</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-gray-100 dark:divide-gray-700">
                  {runs.map(run => {
                    const chatLink =
                      !run.chatDeleted && run.startedAt
                        ? runChatLink(task.appId, run.chatId)
                        : null;
                    return (
                      <tr key={run.id} className="align-top">
                        <td className="py-2 pr-4">
                          <RunStatusBadge status={run.status} />
                        </td>
                        <td className="py-2 pr-4 text-gray-700 dark:text-gray-300">
                          <RunTriggerLabel trigger={run.trigger} />
                        </td>
                        <td className="py-2 pr-4 text-gray-700 dark:text-gray-300 whitespace-nowrap">
                          {formatDateTime(run.scheduledFor, language)}
                        </td>
                        <td className="py-2 pr-4 text-gray-700 dark:text-gray-300 whitespace-nowrap">
                          {run.startedAt ? formatDateTime(run.startedAt, language) : '—'}
                        </td>
                        <td className="py-2 pr-4 text-gray-700 dark:text-gray-300">
                          {formatDuration(run.durationMs) || '—'}
                        </td>
                        <td className="py-2 pr-4 text-gray-700 dark:text-gray-300 space-y-1">
                          <RunMemoryBadges memory={run.memory} />
                          {run.reason?.message && (
                            <p
                              className={
                                run.status === 'failed' ? 'text-red-600 dark:text-red-400' : ''
                              }
                            >
                              {reasonText(t, { ...run.reason, missedSlots: run.missedSlots })}
                            </p>
                          )}
                          {run.reason?.connectUrl && (
                            <Link
                              to={run.reason.connectUrl}
                              className="text-indigo-600 hover:underline"
                            >
                              {t('scheduledTasks.reconnect', 'Reconnect')}
                            </Link>
                          )}
                          {run.status === 'awaiting_approval' && (
                            <ApprovalControls taskId={task.id} run={run} onAnswered={load} />
                          )}
                          <div className="flex gap-3">
                            {chatLink && (
                              <Link
                                to={chatLink}
                                className="text-indigo-600 dark:text-indigo-400 hover:underline"
                              >
                                {t('scheduledTasks.openChat', 'Open chat')}
                              </Link>
                            )}
                            {run.chatDeleted && (
                              <span className="text-xs text-gray-500">
                                {t(
                                  'scheduledTasks.chatRemoved',
                                  'Chat removed (older runs keep only their record)'
                                )}
                              </span>
                            )}
                            {isRunActive(run.status) && task.activeRun?.id === run.id && (
                              <button
                                type="button"
                                className="text-red-600 hover:underline"
                                onClick={() => act(() => cancelScheduledTaskRun(task.id, run.id))}
                              >
                                {t('scheduledTasks.cancelRun', 'Cancel')}
                              </button>
                            )}
                          </div>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
              {cursor && (
                <button type="button" className={`${button} mt-4`} onClick={loadMore}>
                  {t('scheduledTasks.loadMore', 'Show older runs')}
                </button>
              )}
            </div>
          )}
        </section>
      </div>

      <Modal isOpen={confirmDelete} onClose={() => setConfirmDelete(false)}>
        <div className="p-6 space-y-4">
          <h2 className="text-lg font-semibold text-gray-900 dark:text-gray-100">
            {t('scheduledTasks.deleteTitle', 'Delete this task?')}
          </h2>
          <p className="text-sm text-gray-600 dark:text-gray-400">
            {t(
              'scheduledTasks.deleteText',
              'The task and its run history are deleted. Its run chats stay in your chat history unless you delete them too.'
            )}
          </p>
          <label className="inline-flex items-center gap-2 text-sm text-gray-700 dark:text-gray-300">
            <input
              type="checkbox"
              checked={deleteChats}
              onChange={e => setDeleteChats(e.target.checked)}
              className="rounded border-gray-300 text-red-600"
            />
            {t('scheduledTasks.deleteChats', 'Also delete the chats of its runs')}
          </label>
          <div className="flex justify-end gap-3">
            <button type="button" className={button} onClick={() => setConfirmDelete(false)}>
              {t('common.cancel', 'Cancel')}
            </button>
            <button
              type="button"
              className="px-3 py-2 rounded-lg text-sm font-medium bg-red-600 text-white hover:bg-red-700"
              onClick={async () => {
                setConfirmDelete(false);
                const result = await act(() => deleteScheduledTask(task.id, { deleteChats }));
                if (result?.deleted) navigate('/tasks', { replace: true });
              }}
            >
              {t('common.delete', 'Delete')}
            </button>
          </div>
        </div>
      </Modal>
    </div>
  );
}
