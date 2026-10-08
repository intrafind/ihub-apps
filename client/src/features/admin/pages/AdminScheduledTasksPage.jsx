import { useCallback, useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { makeAdminApiCall, getAdminApiErrorMessage } from '../../../api/adminApi';
import AdminBreadcrumb from '../components/AdminBreadcrumb';
import Modal from '../../../shared/components/Modal';
import {
  RunStatusBadge,
  RunTriggerLabel,
  TaskStatusBadge
} from '../../tasks/components/TaskBadges';
import { formatDateTime, formatDuration, reasonText } from '../../tasks/utils/taskFormat';

const input =
  'block w-full rounded-lg border border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-800 px-3 py-2 text-sm text-gray-900 dark:text-gray-100';
const card = 'bg-white dark:bg-gray-800 border border-gray-200 dark:border-gray-700 rounded-xl p-5';
const button =
  'px-2.5 py-1 rounded-md text-xs font-medium border border-gray-300 dark:border-gray-600 text-gray-700 dark:text-gray-200 hover:bg-gray-50 dark:hover:bg-gray-700 disabled:opacity-50';

/** The numeric limits, in the order the form shows them, with their bounds. */
const NUMBER_SETTINGS = [
  ['maxTasksPerUser', 0, 10000],
  ['minIntervalMinutes', 1, 44640],
  ['maxConcurrentRuns', 1, 100],
  ['maxConcurrentRunsPerUser', 1, 100],
  ['staggerMinutes', 0, 60],
  ['catchUpWindowHours', 0, 744],
  ['maxConsecutiveFailures', 0, 1000],
  ['approvalTimeoutHours', 1, 744],
  ['runRetentionDays', 0, 3650],
  ['maxRunChatsPerTask', 0, 10000],
  ['maxInstructionLength', 100, 100000],
  ['maxRunMinutes', 1, 30],
  ['memoryMaxChars', 1000, 64000],
  ['maxHistoryReadChars', 1000, 50000]
];

const STATUS_FILTERS = ['', 'active', 'paused', 'completed', 'disabled'];

/**
 * Admin → Scheduled Tasks: whether the feature is running, the platform
 * limits, and every user's tasks with the ability to pause, resume, disable
 * or delete any of them and look at their runs. An admin never runs a task
 * or edits what it does — a run always acts as its owner.
 */
export default function AdminScheduledTasksPage() {
  const { t, i18n } = useTranslation();
  const language = i18n.language;
  const [data, setData] = useState(null);
  const [filter, setFilter] = useState('');
  const [error, setError] = useState(null);
  const [notice, setNotice] = useState(null);
  const [settings, setSettings] = useState(null);
  const [saving, setSaving] = useState(false);
  const [runsFor, setRunsFor] = useState(null);
  const [runs, setRuns] = useState([]);
  const [busy, setBusy] = useState(null);

  const load = useCallback(async () => {
    try {
      const response = await makeAdminApiCall('/admin/scheduled-tasks', {
        params: filter ? { status: filter } : {}
      });
      setData(response.data);
      setSettings(prev => prev || response.data.settings);
      setError(null);
    } catch (err) {
      setError(getAdminApiErrorMessage(err));
    }
  }, [filter]);

  useEffect(() => {
    load();
  }, [load]);

  async function saveSettings(event) {
    event.preventDefault();
    setSaving(true);
    setNotice(null);
    try {
      const body = { enabled: settings.enabled, memoryEnabled: settings.memoryEnabled !== false };
      for (const [key] of NUMBER_SETTINGS) body[key] = Number(settings[key]);
      const response = await makeAdminApiCall('/admin/scheduled-tasks/settings', {
        method: 'PUT',
        body
      });
      setSettings(response.data.settings);
      setNotice(
        response.data.changed.length > 0
          ? t('admin.scheduledTasks.saved', 'Settings saved')
          : t('admin.scheduledTasks.unchanged', 'Nothing changed')
      );
      await load();
    } catch (err) {
      setError(getAdminApiErrorMessage(err));
    } finally {
      setSaving(false);
    }
  }

  async function setStatus(task, status) {
    setBusy(task.id);
    try {
      await makeAdminApiCall(`/admin/scheduled-tasks/${encodeURIComponent(task.id)}`, {
        method: 'PATCH',
        body: { status }
      });
      await load();
    } catch (err) {
      setError(getAdminApiErrorMessage(err));
    } finally {
      setBusy(null);
    }
  }

  async function remove(task) {
    if (
      !window.confirm(
        t('admin.scheduledTasks.confirmDelete', 'Delete "{{name}}" of {{owner}}?', {
          name: task.name,
          owner: task.owner?.name || task.ownerId
        })
      )
    ) {
      return;
    }
    setBusy(task.id);
    try {
      await makeAdminApiCall(`/admin/scheduled-tasks/${encodeURIComponent(task.id)}`, {
        method: 'DELETE'
      });
      await load();
    } catch (err) {
      setError(getAdminApiErrorMessage(err));
    } finally {
      setBusy(null);
    }
  }

  async function clearMemory(task) {
    if (
      !window.confirm(
        t(
          'admin.scheduledTasks.memory.confirmClear',
          'Clear the memory of "{{name}}" of {{owner}}? The owner loses these notes.',
          { name: task.name, owner: task.owner?.name || task.ownerId }
        )
      )
    ) {
      return;
    }
    setBusy(task.id);
    try {
      await makeAdminApiCall(`/admin/scheduled-tasks/${encodeURIComponent(task.id)}/memory`, {
        method: 'DELETE'
      });
      await load();
    } catch (err) {
      setError(getAdminApiErrorMessage(err));
    } finally {
      setBusy(null);
    }
  }

  async function openRuns(task) {
    setRunsFor(task);
    setRuns([]);
    try {
      const response = await makeAdminApiCall(
        `/admin/scheduled-tasks/${encodeURIComponent(task.id)}/runs`,
        { params: { limit: 50 } }
      );
      setRuns(response.data.items || []);
    } catch (err) {
      setError(getAdminApiErrorMessage(err));
    }
  }

  const status = data?.status;
  const gates = useMemo(
    () =>
      status
        ? [
            [
              'featureEnabled',
              t('admin.scheduledTasks.gates.feature', 'Feature "Scheduled Tasks" is on')
            ],
            [
              'chatPersistence',
              t('admin.scheduledTasks.gates.chats', 'Durable chats are available')
            ],
            [
              'platformEnabled',
              t('admin.scheduledTasks.gates.platform', 'Scheduled tasks are enabled below')
            ]
          ]
        : [],
    [status, t]
  );

  return (
    <div className="bg-gray-50 dark:bg-gray-950 min-h-screen">
      <div className="max-w-6xl mx-auto py-8 px-4 space-y-6">
        <AdminBreadcrumb
          crumbs={[
            { label: t('admin.nav.overview', 'Overview'), href: '/admin' },
            { label: t('admin.nav.scheduledTasks', 'Scheduled Tasks') }
          ]}
        />
        <div>
          <h1 className="text-2xl font-semibold text-gray-900 dark:text-gray-100">
            {t('admin.nav.scheduledTasks', 'Scheduled Tasks')}
          </h1>
          <p className="mt-1 text-sm text-gray-600 dark:text-gray-400">
            {t(
              'admin.scheduledTasks.intro',
              'Tasks users saved to run by themselves. Who may create them is the "Scheduled tasks" permission of a group.'
            )}
          </p>
        </div>

        {error && (
          <div
            role="alert"
            className="rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700 dark:bg-red-900/20 dark:border-red-800 dark:text-red-300"
          >
            {error}
          </div>
        )}
        {notice && (
          <div
            role="status"
            className="rounded-lg border border-green-200 bg-green-50 px-4 py-3 text-sm text-green-700 dark:bg-green-900/20 dark:border-green-800 dark:text-green-300"
          >
            {notice}
          </div>
        )}

        {status && (
          <section className={card}>
            <h2 className="text-base font-semibold text-gray-900 dark:text-gray-100">
              {status.active
                ? t('admin.scheduledTasks.running', 'Scheduled tasks are running')
                : t('admin.scheduledTasks.notRunning', 'Scheduled tasks are not running')}
            </h2>
            <ul className="mt-2 space-y-1 text-sm">
              {gates.map(([key, text]) => (
                <li
                  key={key}
                  className={
                    status[key]
                      ? 'text-green-700 dark:text-green-400'
                      : 'text-red-600 dark:text-red-400'
                  }
                >
                  {status[key] ? '✓' : '✗'} {text}
                </li>
              ))}
            </ul>
            {!status.featureEnabled && (
              <p className="mt-2 text-sm text-gray-600 dark:text-gray-400">
                <Link to="/admin/features" className="text-indigo-600 hover:underline">
                  {t('admin.scheduledTasks.openFeatures', 'Turn it on under Features')}
                </Link>
              </p>
            )}
          </section>
        )}

        {settings && (
          <form className={`${card} space-y-4`} onSubmit={saveSettings}>
            <div className="flex items-center justify-between">
              <h2 className="text-base font-semibold text-gray-900 dark:text-gray-100">
                {t('admin.scheduledTasks.limits', 'Limits')}
              </h2>
              <label className="inline-flex items-center gap-2 text-sm text-gray-700 dark:text-gray-300">
                <input
                  type="checkbox"
                  checked={settings.enabled}
                  onChange={e => setSettings(prev => ({ ...prev, enabled: e.target.checked }))}
                  className="rounded border-gray-300 text-indigo-600"
                />
                {t('admin.scheduledTasks.enabled', 'Enabled')}
              </label>
            </div>
            <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
              {NUMBER_SETTINGS.map(([key, min, max]) => (
                <div key={key}>
                  <label
                    htmlFor={`st-${key}`}
                    className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1"
                  >
                    {t(`admin.scheduledTasks.settings.${key}`, key)}
                  </label>
                  <input
                    id={`st-${key}`}
                    type="number"
                    min={min}
                    max={max}
                    className={input}
                    value={settings[key]}
                    onChange={e => setSettings(prev => ({ ...prev, [key]: e.target.value }))}
                  />
                </div>
              ))}
            </div>
            <div>
              <label className="inline-flex items-center gap-2 text-sm font-medium text-gray-700 dark:text-gray-300">
                <input
                  id="st-memoryEnabled"
                  type="checkbox"
                  checked={settings.memoryEnabled !== false}
                  aria-describedby="st-memoryEnabled-hint"
                  onChange={e =>
                    setSettings(prev => ({ ...prev, memoryEnabled: e.target.checked }))
                  }
                  className="rounded border-gray-300 text-indigo-600"
                />
                {t('admin.scheduledTasks.settings.memoryEnabled', 'Allow memory between runs')}
              </label>
              <p id="st-memoryEnabled-hint" className="mt-1 text-xs text-gray-500">
                {t(
                  'admin.scheduledTasks.memoryEnabledHint',
                  'Off: runs neither read nor update the notes of a task (the notes are kept), and "Only when something changed" notifies after every run.'
                )}
              </p>
            </div>
            <p className="text-xs text-gray-500">
              {t(
                'admin.scheduledTasks.zeroHint',
                '0 turns off the per-user task limit, the auto-pause after failures, run record retention and the run chat cap.'
              )}
            </p>
            <div className="flex justify-end">
              <button
                type="submit"
                disabled={saving}
                className="px-4 py-2 rounded-lg text-sm font-medium bg-indigo-600 text-white hover:bg-indigo-700 disabled:opacity-60"
              >
                {saving ? t('common.saving', 'Saving…') : t('common.save', 'Save')}
              </button>
            </div>
          </form>
        )}

        <section className={card}>
          <div className="flex flex-wrap items-center justify-between gap-3">
            <h2 className="text-base font-semibold text-gray-900 dark:text-gray-100">
              {t('admin.scheduledTasks.allTasks', 'All tasks')}
              {data?.items ? ` (${data.items.length})` : ''}
            </h2>
            <select
              aria-label={t('admin.scheduledTasks.filter', 'Filter by status')}
              className="rounded-lg border border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-800 px-3 py-1.5 text-sm"
              value={filter}
              onChange={e => setFilter(e.target.value)}
            >
              {STATUS_FILTERS.map(value => (
                <option key={value || 'all'} value={value}>
                  {value
                    ? t(`scheduledTasks.status.${value}`, value)
                    : t('admin.scheduledTasks.all', 'All')}
                </option>
              ))}
            </select>
          </div>
          {!data ? (
            <p className="mt-4 text-sm text-gray-500">{t('common.loading', 'Loading…')}</p>
          ) : data.items.length === 0 ? (
            <p className="mt-4 text-sm text-gray-500">
              {t('admin.scheduledTasks.none', 'No scheduled tasks.')}
            </p>
          ) : (
            <div className="mt-4 overflow-x-auto">
              <table className="min-w-full text-sm">
                <thead>
                  <tr className="text-left text-xs uppercase tracking-wide text-gray-500">
                    <th className="py-2 pr-4">{t('admin.scheduledTasks.columns.task', 'Task')}</th>
                    <th className="py-2 pr-4">
                      {t('admin.scheduledTasks.columns.owner', 'Owner')}
                    </th>
                    <th className="py-2 pr-4">
                      {t('admin.scheduledTasks.columns.schedule', 'Schedule')}
                    </th>
                    <th className="py-2 pr-4">
                      {t('admin.scheduledTasks.columns.status', 'Status')}
                    </th>
                    <th className="py-2 pr-4">
                      {t('admin.scheduledTasks.columns.lastRun', 'Last run')}
                    </th>
                    <th className="py-2 pr-4">
                      {t('admin.scheduledTasks.columns.failures', 'Failures')}
                    </th>
                    <th className="py-2 pr-4">
                      {t('admin.scheduledTasks.columns.memory', 'Memory')}
                    </th>
                    <th className="py-2" />
                  </tr>
                </thead>
                <tbody className="divide-y divide-gray-100 dark:divide-gray-700">
                  {data.items.map(task => (
                    <tr key={task.id} className="align-top">
                      <td className="py-2 pr-4">
                        <div className="font-medium text-gray-900 dark:text-gray-100">
                          {task.name}
                        </div>
                        <div className="text-xs text-gray-500">{task.appId}</div>
                      </td>
                      <td className="py-2 pr-4 text-gray-700 dark:text-gray-300">
                        {task.owner?.name || task.owner?.username || task.ownerId}
                      </td>
                      <td className="py-2 pr-4 text-gray-700 dark:text-gray-300 max-w-xs">
                        {task.scheduleDescription}
                      </td>
                      <td className="py-2 pr-4">
                        <TaskStatusBadge status={task.status} />
                        {task.statusReason?.message && task.status !== 'active' && (
                          <div className="mt-1 text-xs text-gray-500 max-w-xs">
                            {reasonText(t, task.statusReason)}
                          </div>
                        )}
                      </td>
                      <td className="py-2 pr-4">
                        {task.lastRun ? (
                          <div className="space-y-1">
                            <RunStatusBadge status={task.lastRun.status} />
                            <div className="text-xs text-gray-500">
                              {formatDateTime(
                                task.lastRun.finishedAt || task.lastRun.startedAt,
                                language
                              )}
                            </div>
                          </div>
                        ) : (
                          '—'
                        )}
                      </td>
                      <td className="py-2 pr-4 text-gray-700 dark:text-gray-300">
                        {task.consecutiveFailures || 0}
                      </td>
                      <td className="py-2 pr-4 text-gray-700 dark:text-gray-300">
                        {task.memorySummary ? (
                          <div className="space-y-1">
                            <div>
                              {t(
                                'admin.scheduledTasks.memory.summary',
                                '{{chars}} chars · v{{version}} · {{updatedAt}}',
                                {
                                  chars: task.memorySummary.chars,
                                  version: task.memorySummary.version,
                                  updatedAt: formatDateTime(task.memorySummary.updatedAt, language)
                                }
                              )}
                            </div>
                            {task.memorySummary.chars > 0 && (
                              <button
                                type="button"
                                className={`${button} text-red-600`}
                                disabled={busy === task.id}
                                onClick={() => clearMemory(task)}
                              >
                                {t('admin.scheduledTasks.memory.clear', 'Clear memory')}
                              </button>
                            )}
                          </div>
                        ) : (
                          '—'
                        )}
                      </td>
                      <td className="py-2 whitespace-nowrap space-x-1">
                        <button type="button" className={button} onClick={() => openRuns(task)}>
                          {t('admin.scheduledTasks.runs', 'Runs')}
                        </button>
                        {task.status === 'active' ? (
                          <button
                            type="button"
                            className={button}
                            disabled={busy === task.id}
                            onClick={() => setStatus(task, 'paused')}
                          >
                            {t('scheduledTasks.pause', 'Pause')}
                          </button>
                        ) : (
                          <button
                            type="button"
                            className={button}
                            disabled={busy === task.id}
                            onClick={() => setStatus(task, 'active')}
                          >
                            {t('scheduledTasks.resume', 'Resume')}
                          </button>
                        )}
                        {task.status !== 'disabled' && (
                          <button
                            type="button"
                            className={button}
                            disabled={busy === task.id}
                            onClick={() => setStatus(task, 'disabled')}
                          >
                            {t('admin.scheduledTasks.disable', 'Disable')}
                          </button>
                        )}
                        <button
                          type="button"
                          className={`${button} text-red-600`}
                          disabled={busy === task.id}
                          onClick={() => remove(task)}
                        >
                          {t('common.delete', 'Delete')}
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </section>
      </div>

      <Modal isOpen={!!runsFor} onClose={() => setRunsFor(null)} maxWidthClassName="max-w-3xl">
        <div className="p-6">
          <h2 className="text-lg font-semibold text-gray-900 dark:text-gray-100">
            {t('admin.scheduledTasks.runsOf', 'Runs of "{{name}}"', { name: runsFor?.name })}
          </h2>
          {runs.length === 0 ? (
            <p className="mt-4 text-sm text-gray-500">
              {t('scheduledTasks.noRuns', 'No runs yet.')}
            </p>
          ) : (
            <table className="mt-4 min-w-full text-sm">
              <tbody className="divide-y divide-gray-100 dark:divide-gray-700">
                {runs.map(run => (
                  <tr key={run.id}>
                    <td className="py-2 pr-3">
                      <RunStatusBadge status={run.status} />
                    </td>
                    <td className="py-2 pr-3 text-gray-700 dark:text-gray-300">
                      <RunTriggerLabel trigger={run.trigger} />
                    </td>
                    <td className="py-2 pr-3 text-gray-700 dark:text-gray-300 whitespace-nowrap">
                      {formatDateTime(run.scheduledFor, language)}
                    </td>
                    <td className="py-2 pr-3 text-gray-700 dark:text-gray-300">
                      {formatDuration(run.durationMs) || '—'}
                    </td>
                    <td className="py-2 text-gray-600 dark:text-gray-400">
                      {reasonText(t, { ...run.reason, missedSlots: run.missedSlots })}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
          <div className="mt-4 flex justify-end">
            <button type="button" className={button} onClick={() => setRunsFor(null)}>
              {t('common.close', 'Close')}
            </button>
          </div>
        </div>
      </Modal>
    </div>
  );
}
