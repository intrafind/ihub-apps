import { useEffect, useMemo, useState } from 'react';
import { Link, useLocation, useNavigate, useParams } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import useApps from '../../../shared/hooks/useApps';
import {
  browserTimezone,
  createScheduledTask,
  fetchModels,
  fetchScheduledTask,
  fetchScheduledTaskAppTools,
  updateScheduledTask
} from '../../../api';
import { getLocalizedContent } from '../../../utils/localizeContent';
import ScheduleBuilder from '../components/ScheduleBuilder';
import { useScheduledTaskLimits } from '../hooks/useScheduledTasksConfig';
import { errorMessage, fieldErrors, formToSchedule, scheduleToForm } from '../utils/taskFormat';

const input =
  'block w-full rounded-lg border border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-800 px-3 py-2 text-sm text-gray-900 dark:text-gray-100 focus:border-indigo-500 focus:ring-indigo-500';
const label = 'block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1';
const section =
  'bg-white dark:bg-gray-800/60 border border-gray-200 dark:border-gray-700 rounded-xl p-5 space-y-4';

const RUN_VARIABLES = [
  'run_time',
  'scheduled_time',
  'last_run_at',
  'last_successful_run_at',
  'run_number',
  'task_name'
];

function emptyDraft(defaultAppId) {
  return {
    name: '',
    description: '',
    instructions: '',
    appId: defaultAppId || '',
    modelId: '',
    variables: {},
    enabledTools: null,
    notify: 'always',
    schedule: { type: 'daily', time: '08:00', timezone: browserTimezone() }
  };
}

/**
 * Create or edit a scheduled task. A new task can arrive pre-filled — from
 * "Schedule this…" on a chat message or "Edit in form" on a confirmation
 * card — through the router state `{ draft, proposalId?, sourceChatId? }`.
 */
export default function TaskEditorPage() {
  const { t, i18n } = useTranslation();
  const language = i18n.language;
  const navigate = useNavigate();
  const location = useLocation();
  const { taskId } = useParams();
  const editing = Boolean(taskId);
  const { apps } = useApps();
  const limits = useScheduledTaskLimits();

  const incoming = location.state || {};
  const [draft, setDraft] = useState(() => ({ ...emptyDraft(), ...(incoming.draft || {}) }));
  const [scheduleForm, setScheduleForm] = useState(() =>
    scheduleToForm(incoming.draft?.schedule || emptyDraft().schedule, browserTimezone())
  );
  const [loading, setLoading] = useState(editing);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState(null);
  const [errors, setErrors] = useState({});
  const [tools, setTools] = useState([]);
  const [models, setModels] = useState([]);

  useEffect(() => {
    if (!editing) return;
    let cancelled = false;
    fetchScheduledTask(taskId)
      .then(task => {
        if (cancelled) return;
        setDraft({
          name: task.name,
          description: task.description || '',
          instructions: task.instructions,
          appId: task.appId,
          modelId: task.modelId || '',
          variables: task.variables || {},
          enabledTools: task.enabledTools ?? null,
          notify: task.notify || 'always',
          schedule: task.schedule
        });
        setScheduleForm(scheduleToForm(task.schedule, browserTimezone()));
      })
      .catch(err => !cancelled && setError(errorMessage(err)))
      .finally(() => !cancelled && setLoading(false));
    return () => {
      cancelled = true;
    };
  }, [editing, taskId]);

  // Default app: the first one the user may use.
  useEffect(() => {
    if (!draft.appId && apps.length > 0) setDraft(prev => ({ ...prev, appId: apps[0].id }));
  }, [apps, draft.appId]);

  const app = useMemo(() => apps.find(a => a.id === draft.appId) || null, [apps, draft.appId]);

  useEffect(() => {
    if (!draft.appId) return undefined;
    let cancelled = false;
    fetchScheduledTaskAppTools(draft.appId)
      .then(result => !cancelled && setTools(Array.isArray(result?.items) ? result.items : []))
      .catch(() => !cancelled && setTools([]));
    return () => {
      cancelled = true;
    };
  }, [draft.appId]);

  useEffect(() => {
    let cancelled = false;
    fetchModels()
      .then(list => !cancelled && setModels(Array.isArray(list) ? list : []))
      .catch(() => !cancelled && setModels([]));
    return () => {
      cancelled = true;
    };
  }, []);

  const appModels = useMemo(() => {
    if (!app || app.disallowModelSelection) return [];
    const allowed = Array.isArray(app.allowedModels) && app.allowedModels.length > 0;
    return models.filter(model => !allowed || app.allowedModels.includes(model.id));
  }, [app, models]);

  const toggleable = tools.filter(tool => tool.toggleable);
  const alwaysOn = tools.filter(tool => !tool.toggleable);
  const customTools = Array.isArray(draft.enabledTools);

  const set = patch => setDraft(prev => ({ ...prev, ...patch }));
  const setVariable = (name, value) =>
    setDraft(prev => ({ ...prev, variables: { ...(prev.variables || {}), [name]: value } }));

  async function handleSubmit(event) {
    event.preventDefault();
    setSaving(true);
    setError(null);
    setErrors({});
    const body = {
      name: draft.name,
      description: draft.description,
      instructions: draft.instructions,
      appId: draft.appId,
      modelId: draft.modelId || null,
      variables: draft.variables || {},
      enabledTools: customTools ? draft.enabledTools : null,
      notify: draft.notify,
      schedule: formToSchedule(scheduleForm)
    };
    try {
      const saved = editing
        ? await updateScheduledTask(taskId, body)
        : await createScheduledTask({
            ...body,
            ...(incoming.proposalId ? { proposalId: incoming.proposalId } : {}),
            ...(incoming.sourceChatId ? { sourceChatId: incoming.sourceChatId } : {})
          });
      navigate(`/tasks/${saved.id}`, { replace: true });
    } catch (err) {
      setErrors(fieldErrors(err));
      setError(errorMessage(err, t('scheduledTasks.errors.save', 'The task could not be saved')));
    } finally {
      setSaving(false);
    }
  }

  if (loading) {
    return (
      <div className="min-h-full bg-gray-50 dark:bg-gray-900 px-6 py-10">
        <p className="max-w-3xl mx-auto text-gray-500">{t('common.loading', 'Loading…')}</p>
      </div>
    );
  }

  const variableFields = Array.isArray(app?.variables) ? app.variables : [];

  return (
    <div className="min-h-full bg-gray-50 dark:bg-gray-900 px-4 sm:px-6 py-8">
      <form className="max-w-3xl mx-auto space-y-6" onSubmit={handleSubmit} noValidate>
        <div>
          <Link
            to={editing ? `/tasks/${taskId}` : '/tasks'}
            className="text-sm text-indigo-600 dark:text-indigo-400 hover:underline"
          >
            ← {t('scheduledTasks.backToTasks', 'Scheduled tasks')}
          </Link>
          <h1 className="mt-2 text-2xl font-semibold text-gray-900 dark:text-gray-100">
            {editing
              ? t('scheduledTasks.editTitle', 'Edit scheduled task')
              : t('scheduledTasks.newTitle', 'New scheduled task')}
          </h1>
          <p className="mt-1 text-sm text-gray-600 dark:text-gray-400">
            {t(
              'scheduledTasks.editorIntro',
              'The instructions are sent to the app on every run, as you, with the tools and integrations you pick. Each run becomes its own chat.'
            )}
          </p>
        </div>

        {error && (
          <div
            role="alert"
            className="rounded-lg border border-red-200 bg-red-50 dark:bg-red-900/20 dark:border-red-800 px-4 py-3 text-sm text-red-700 dark:text-red-300"
          >
            {error}
          </div>
        )}

        <section className={section}>
          <div>
            <label htmlFor="task-name" className={label}>
              {t('scheduledTasks.fields.name', 'Name')}
            </label>
            <input
              id="task-name"
              className={input}
              maxLength={120}
              required
              value={draft.name}
              onChange={e => set({ name: e.target.value })}
            />
            {errors.name && <p className="mt-1 text-xs text-red-600">{errors.name}</p>}
          </div>
          <div>
            <label htmlFor="task-description" className={label}>
              {t('scheduledTasks.fields.description', 'Description (optional)')}
            </label>
            <input
              id="task-description"
              className={input}
              maxLength={1000}
              value={draft.description}
              onChange={e => set({ description: e.target.value })}
            />
          </div>
        </section>

        <section className={section}>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            <div>
              <label htmlFor="task-app" className={label}>
                {t('scheduledTasks.fields.app', 'App')}
              </label>
              <select
                id="task-app"
                className={input}
                value={draft.appId}
                onChange={e =>
                  set({ appId: e.target.value, enabledTools: null, modelId: '', variables: {} })
                }
              >
                {!app && draft.appId && <option value={draft.appId}>{draft.appId}</option>}
                {apps.map(a => (
                  <option key={a.id} value={a.id}>
                    {getLocalizedContent(a.name, language) || a.id}
                  </option>
                ))}
              </select>
              {errors.appId && <p className="mt-1 text-xs text-red-600">{errors.appId}</p>}
            </div>
            {appModels.length > 0 && (
              <div>
                <label htmlFor="task-model" className={label}>
                  {t('scheduledTasks.fields.model', 'Model')}
                </label>
                <select
                  id="task-model"
                  className={input}
                  value={draft.modelId}
                  onChange={e => set({ modelId: e.target.value })}
                >
                  <option value="">
                    {t('scheduledTasks.fields.appDefaultModel', "App's default")}
                  </option>
                  {appModels.map(model => (
                    <option key={model.id} value={model.id}>
                      {getLocalizedContent(model.name, language) || model.id}
                    </option>
                  ))}
                </select>
                {errors.modelId && <p className="mt-1 text-xs text-red-600">{errors.modelId}</p>}
              </div>
            )}
          </div>

          {variableFields.length > 0 && (
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
              {variableFields.map(variable => {
                const id = `task-var-${variable.name}`;
                const value = draft.variables?.[variable.name] ?? '';
                const fieldLabel = getLocalizedContent(variable.label, language) || variable.name;
                return (
                  <div key={variable.name}>
                    <label htmlFor={id} className={label}>
                      {fieldLabel}
                      {variable.required ? ' *' : ''}
                    </label>
                    {variable.type === 'select' && Array.isArray(variable.predefinedValues) ? (
                      <select
                        id={id}
                        className={input}
                        value={value}
                        onChange={e => setVariable(variable.name, e.target.value)}
                      >
                        <option value="" />
                        {variable.predefinedValues.map(option => (
                          <option key={option.value} value={option.value}>
                            {getLocalizedContent(option.label, language) || option.value}
                          </option>
                        ))}
                      </select>
                    ) : variable.type === 'text' ? (
                      <textarea
                        id={id}
                        rows={3}
                        className={input}
                        value={value}
                        onChange={e => setVariable(variable.name, e.target.value)}
                      />
                    ) : (
                      <input
                        id={id}
                        type={
                          variable.type === 'number'
                            ? 'number'
                            : variable.type === 'date'
                              ? 'date'
                              : 'text'
                        }
                        className={input}
                        value={value}
                        onChange={e => setVariable(variable.name, e.target.value)}
                      />
                    )}
                    {errors[`variables.${variable.name}`] && (
                      <p className="mt-1 text-xs text-red-600">
                        {errors[`variables.${variable.name}`]}
                      </p>
                    )}
                  </div>
                );
              })}
            </div>
          )}

          <div>
            <label htmlFor="task-instructions" className={label}>
              {t('scheduledTasks.fields.instructions', 'Instructions')}
            </label>
            <textarea
              id="task-instructions"
              rows={6}
              className={input}
              maxLength={limits.maxInstructionLength}
              value={draft.instructions}
              onChange={e => set({ instructions: e.target.value })}
            />
            {errors.instructions && (
              <p className="mt-1 text-xs text-red-600">{errors.instructions}</p>
            )}
            <details className="mt-2 text-xs text-gray-600 dark:text-gray-400">
              <summary className="cursor-pointer">
                {t('scheduledTasks.variablesHelp', 'Variables you can use')}
              </summary>
              <p className="mt-1">
                {t(
                  'scheduledTasks.variablesHelpText',
                  'Runs do not see each other. To ask for "what changed since last time", use the time of the last run in the instructions:'
                )}
              </p>
              <ul className="mt-1 space-y-0.5 font-mono">
                {RUN_VARIABLES.map(name => (
                  <li key={name}>
                    <button
                      type="button"
                      className="hover:underline"
                      onClick={() => set({ instructions: `${draft.instructions}{{${name}}}` })}
                    >{`{{${name}}}`}</button>{' '}
                    <span className="font-sans">
                      — {t(`scheduledTasks.variables.${name}`, name)}
                    </span>
                  </li>
                ))}
              </ul>
            </details>
          </div>
        </section>

        {tools.length > 0 && (
          <section className={section}>
            <div className="flex items-center justify-between gap-4">
              <h2 className="text-base font-semibold text-gray-900 dark:text-gray-100">
                {t('scheduledTasks.fields.tools', 'Tools and integrations')}
              </h2>
              {toggleable.length > 0 && (
                <label className="inline-flex items-center gap-2 text-sm text-gray-700 dark:text-gray-300">
                  <input
                    type="checkbox"
                    className="rounded border-gray-300 text-indigo-600"
                    checked={!customTools}
                    onChange={e =>
                      set({
                        enabledTools: e.target.checked ? null : toggleable.map(tool => tool.id)
                      })
                    }
                  />
                  {t('scheduledTasks.fields.appDefaultTools', "Use the app's defaults")}
                </label>
              )}
            </div>
            <ul className="space-y-2">
              {toggleable.map(tool => {
                const checked = customTools ? draft.enabledTools.includes(tool.id) : true;
                return (
                  <li key={tool.id} className="flex items-center gap-3">
                    <input
                      id={`tool-${tool.id}`}
                      type="checkbox"
                      className="rounded border-gray-300 text-indigo-600"
                      disabled={!customTools}
                      checked={checked}
                      onChange={e =>
                        set({
                          enabledTools: e.target.checked
                            ? [...draft.enabledTools, tool.id]
                            : draft.enabledTools.filter(id => id !== tool.id)
                        })
                      }
                    />
                    <label
                      htmlFor={`tool-${tool.id}`}
                      className="text-sm text-gray-800 dark:text-gray-200"
                    >
                      {tool.name}
                    </label>
                    {tool.requiresApproval && (
                      <span className="text-xs rounded-full bg-amber-100 dark:bg-amber-900/30 text-amber-800 dark:text-amber-300 px-2 py-0.5">
                        {t('scheduledTasks.needsApproval', 'Asks for approval')}
                      </span>
                    )}
                  </li>
                );
              })}
              {alwaysOn.map(tool => (
                <li
                  key={tool.id}
                  className="flex items-center gap-3 text-sm text-gray-600 dark:text-gray-400"
                >
                  <input type="checkbox" checked disabled className="rounded border-gray-300" />
                  <span>{tool.name}</span>
                  <span className="text-xs">
                    ({t('scheduledTasks.fields.alwaysIncluded', 'always included')})
                  </span>
                </li>
              ))}
            </ul>
            {errors.enabledTools && <p className="text-xs text-red-600">{errors.enabledTools}</p>}
          </section>
        )}

        <section className={section}>
          <h2 className="text-base font-semibold text-gray-900 dark:text-gray-100">
            {t('scheduledTasks.fields.schedule', 'Schedule')}
          </h2>
          <ScheduleBuilder
            form={scheduleForm}
            onChange={setScheduleForm}
            staggerMinutes={limits.staggerMinutes}
          />
        </section>

        <section className={section}>
          <div className="sm:w-1/2">
            <label htmlFor="task-notify" className={label}>
              {t('scheduledTasks.fields.notify', 'Notify me')}
            </label>
            <select
              id="task-notify"
              className={input}
              value={draft.notify}
              onChange={e => set({ notify: e.target.value })}
            >
              <option value="always">{t('scheduledTasks.notify.always', 'After every run')}</option>
              <option value="failure">
                {t('scheduledTasks.notify.failure', 'Only when a run fails')}
              </option>
              <option value="never">{t('scheduledTasks.notify.never', 'Never')}</option>
            </select>
          </div>
        </section>

        <div className="flex items-center justify-end gap-3">
          <Link
            to={editing ? `/tasks/${taskId}` : '/tasks'}
            className="px-4 py-2 rounded-lg text-sm font-medium text-gray-700 dark:text-gray-300 hover:bg-gray-100 dark:hover:bg-gray-800"
          >
            {t('common.cancel', 'Cancel')}
          </Link>
          <button
            type="submit"
            disabled={saving}
            className="px-4 py-2 rounded-lg text-sm font-medium bg-indigo-600 text-white hover:bg-indigo-700 disabled:opacity-60"
          >
            {saving
              ? t('common.saving', 'Saving…')
              : editing
                ? t('common.save', 'Save')
                : t('scheduledTasks.create', 'Create task')}
          </button>
        </div>
      </form>
    </div>
  );
}
