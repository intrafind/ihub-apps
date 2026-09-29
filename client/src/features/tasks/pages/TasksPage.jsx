import { useCallback, useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import Icon from '../../../shared/components/Icon';
import useApps from '../../../shared/hooks/useApps';
import { getLocalizedContent } from '../../../utils/localizeContent';
import { fetchScheduledTasks, pauseScheduledTask, resumeScheduledTask } from '../../../api';
import { RunStatusBadge, TaskStatusBadge } from '../components/TaskBadges';
import { useCanCreateScheduledTasks, useNow } from '../hooks/useScheduledTasks';
import {
  errorMessage,
  formatDateTime,
  formatRelative,
  isRunActive,
  reasonText
} from '../utils/taskFormat';

function Toggle({ checked, disabled, onChange, label }) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      disabled={disabled}
      onClick={() => onChange(!checked)}
      className={`relative inline-flex h-6 w-11 shrink-0 items-center rounded-full transition-colors disabled:opacity-50 ${
        checked ? 'bg-indigo-600' : 'bg-gray-300 dark:bg-gray-600'
      }`}
    >
      <span
        className={`inline-block h-5 w-5 transform rounded-full bg-white shadow transition-transform ${
          checked ? 'translate-x-5' : 'translate-x-0.5'
        }`}
      />
    </button>
  );
}

/**
 * `/tasks` — the viewer's scheduled tasks: what runs, when, how the last run
 * went, and a switch to pause or resume each.
 */
export default function TasksPage() {
  const { t, i18n } = useTranslation();
  const language = i18n.language;
  const { apps } = useApps();
  const canCreate = useCanCreateScheduledTasks();
  const now = useNow();
  const [data, setData] = useState({ items: [], limits: null, canCreate: false });
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(null);

  const load = useCallback(async () => {
    try {
      const result = await fetchScheduledTasks();
      setData(result);
      setError(null);
    } catch (err) {
      setError(errorMessage(err, t('scheduledTasks.errors.load', 'Tasks could not be loaded')));
    } finally {
      setLoading(false);
    }
  }, [t]);

  useEffect(() => {
    load();
  }, [load]);

  // A run in flight changes its task's row; follow it while it lasts.
  const anyActive = data.items.some(task => task.activeRun);
  useEffect(() => {
    if (!anyActive) return undefined;
    const id = setInterval(load, 5000);
    return () => clearInterval(id);
  }, [anyActive, load]);

  const appName = useMemo(() => {
    const byId = new Map(apps.map(app => [app.id, app]));
    return id => getLocalizedContent(byId.get(id)?.name, language) || id;
  }, [apps, language]);

  async function toggle(task, active) {
    setBusy(task.id);
    try {
      const updated = active
        ? await resumeScheduledTask(task.id)
        : await pauseScheduledTask(task.id);
      setData(prev => ({
        ...prev,
        items: prev.items.map(item => (item.id === task.id ? updated : item))
      }));
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(null);
    }
  }

  const limit = data.limits?.maxTasksPerUser || 0;
  const atLimit = limit > 0 && data.items.length >= limit;
  const mayCreate = canCreate && data.canCreate !== false;

  return (
    <div className="min-h-full bg-gray-50 dark:bg-gray-900 px-4 sm:px-6 py-8">
      <div className="max-w-5xl mx-auto">
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div>
            <h1 className="text-2xl font-semibold text-gray-900 dark:text-gray-100">
              {t('scheduledTasks.title', 'Scheduled tasks')}
            </h1>
            <p className="mt-1 text-sm text-gray-600 dark:text-gray-400">
              {t(
                'scheduledTasks.subtitle',
                'Prompts that run by themselves, as you. Every run becomes its own chat.'
              )}
            </p>
          </div>
          {mayCreate && (
            <Link
              to="/tasks/new"
              aria-disabled={atLimit}
              onClick={e => atLimit && e.preventDefault()}
              className={`inline-flex items-center gap-2 px-4 py-2 rounded-lg text-sm font-medium text-white ${
                atLimit ? 'bg-indigo-300 cursor-not-allowed' : 'bg-indigo-600 hover:bg-indigo-700'
              }`}
              title={
                atLimit
                  ? t(
                      'scheduledTasks.limitReached',
                      'You have reached the limit of {{limit}} tasks',
                      {
                        limit
                      }
                    )
                  : undefined
              }
            >
              <Icon name="plus" size="sm" />
              {t('scheduledTasks.newTask', 'New task')}
            </Link>
          )}
        </div>

        {error && (
          <div
            role="alert"
            className="mt-6 rounded-lg border border-red-200 bg-red-50 dark:bg-red-900/20 dark:border-red-800 px-4 py-3 text-sm text-red-700 dark:text-red-300"
          >
            {error}
          </div>
        )}

        {loading ? (
          <p className="mt-10 text-sm text-gray-500">{t('common.loading', 'Loading…')}</p>
        ) : data.items.length === 0 ? (
          <div className="mt-10 rounded-xl border border-dashed border-gray-300 dark:border-gray-700 p-10 text-center">
            <Icon name="calendar" size="xl" className="mx-auto text-gray-400" />
            <h2 className="mt-3 text-base font-semibold text-gray-900 dark:text-gray-100">
              {t('scheduledTasks.emptyTitle', 'No scheduled tasks yet')}
            </h2>
            <p className="mt-1 text-sm text-gray-600 dark:text-gray-400">
              {t(
                'scheduledTasks.emptyText',
                'Save a prompt to run it every morning, once next week, or only when you click Run now. You can also ask an app with scheduling tools to set one up for you.'
              )}
            </p>
            {mayCreate && (
              <Link
                to="/tasks/new"
                className="mt-4 inline-flex items-center gap-2 px-4 py-2 rounded-lg text-sm font-medium bg-indigo-600 text-white hover:bg-indigo-700"
              >
                <Icon name="plus" size="sm" />
                {t('scheduledTasks.newTask', 'New task')}
              </Link>
            )}
          </div>
        ) : (
          <ul className="mt-6 space-y-3">
            {data.items.map(task => {
              const lastStatus = task.activeRun?.status || task.lastRun?.status;
              return (
                <li
                  key={task.id}
                  className="bg-white dark:bg-gray-800/60 border border-gray-200 dark:border-gray-700 rounded-xl p-4 flex flex-wrap items-center gap-4"
                >
                  <div className="flex-1 min-w-[16rem]">
                    <div className="flex items-center gap-2 flex-wrap">
                      <Link
                        to={`/tasks/${task.id}`}
                        className="font-medium text-gray-900 dark:text-gray-100 hover:text-indigo-600 dark:hover:text-indigo-400"
                      >
                        {task.name}
                      </Link>
                      <TaskStatusBadge status={task.status} />
                      {task.unseenCount > 0 && (
                        <span className="text-xs rounded-full bg-indigo-100 dark:bg-indigo-900/40 text-indigo-700 dark:text-indigo-300 px-2 py-0.5">
                          {t('scheduledTasks.unseen', '{{count}} new', { count: task.unseenCount })}
                        </span>
                      )}
                    </div>
                    <p className="mt-1 text-sm text-gray-600 dark:text-gray-400">
                      {appName(task.appId)} · {task.scheduleDescription}
                    </p>
                    {task.statusReason?.message && task.status !== 'active' && (
                      <p
                        className={`mt-1 text-xs ${
                          task.status === 'completed'
                            ? 'text-gray-500 dark:text-gray-400'
                            : 'text-amber-700 dark:text-amber-400'
                        }`}
                      >
                        {reasonText(t, task.statusReason)}
                      </p>
                    )}
                  </div>
                  <div className="text-sm text-gray-600 dark:text-gray-400 min-w-[10rem]">
                    <div className="text-xs uppercase tracking-wide text-gray-500">
                      {t('scheduledTasks.nextRun', 'Next run')}
                    </div>
                    {task.nextRunAt ? (
                      <span title={formatDateTime(task.nextRunAt, language)}>
                        {formatRelative(task.nextRunAt, language, now)}
                      </span>
                    ) : (
                      <span>—</span>
                    )}
                  </div>
                  <div className="text-sm min-w-[8rem]">
                    <div className="text-xs uppercase tracking-wide text-gray-500">
                      {t('scheduledTasks.lastRun', 'Last run')}
                    </div>
                    {lastStatus ? (
                      <span className="inline-flex items-center gap-2">
                        <RunStatusBadge status={lastStatus} />
                        {!isRunActive(lastStatus) && task.lastRun?.finishedAt && (
                          <span className="text-xs text-gray-500">
                            {formatRelative(task.lastRun.finishedAt, language, now)}
                          </span>
                        )}
                      </span>
                    ) : (
                      <span className="text-gray-500">—</span>
                    )}
                  </div>
                  <Toggle
                    checked={task.status === 'active'}
                    disabled={
                      busy === task.id ||
                      task.status === 'disabled' ||
                      (task.status !== 'active' && !mayCreate)
                    }
                    label={
                      task.status === 'active'
                        ? t('scheduledTasks.pause', 'Pause')
                        : t('scheduledTasks.resume', 'Resume')
                    }
                    onChange={active => toggle(task, active)}
                  />
                </li>
              );
            })}
          </ul>
        )}
      </div>
    </div>
  );
}
