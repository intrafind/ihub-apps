import { useState, useEffect } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import AdminAuth from '../components/AdminAuth';
import AdminNavigation from '../components/AdminNavigation';
import DynamicLanguageEditor from '../../../shared/components/DynamicLanguageEditor';
import IconPicker from '../../../shared/components/IconPicker';
import ToolsSelector from '../../../shared/components/ToolsSelector';
import SourcePicker from '../components/SourcePicker';
import { getLocalizedContent } from '../../../utils/localizeContent';
import { fetchAdminModels, fetchAdminApps } from '../../../api/adminApi';
import {
  fetchAgentProfile,
  createAgentProfile,
  updateAgentProfile
} from '../../../api/agentsAdminApi';

const BLANK_PROFILE = {
  id: '',
  name: { en: '' },
  description: { en: '' },
  system: { en: '' },
  color: '#6366F1',
  icon: 'robot',
  workflow: { ref: 'embedded' },
  preferredModel: '',
  preferredTemperature: 0.7,
  maxIterations: 10,
  tools: [],
  sources: [],
  apps: [],
  memory: { enabled: true, autoInclude: true, maxBytes: 8192 },
  inboxId: '',
  hitl: { approverGroups: [] },
  planner: { enabled: false, maxTasks: 10 },
  dynamicTasks: { enabled: false, maxDepth: 3 },
  budgets: { maxWallTimeSec: 600 },
  concurrency: { maxConcurrent: 1 },
  artifacts: { outputDir: 'auto', primary: 'report.md' },
  groups: [],
  serviceAccount: { groups: ['agents', 'authenticated'] },
  enabled: true
};

const TOP_LEVEL_FIELDS = new Set([
  'id',
  'name',
  'description',
  'system',
  'color',
  'icon',
  'workflow',
  'preferredModel',
  'preferredTemperature',
  'maxIterations',
  'tools',
  'sources',
  'apps',
  'memory',
  'inboxId',
  'hitl',
  'planner',
  'dynamicTasks',
  'budgets',
  'concurrency',
  'artifacts',
  'groups',
  'serviceAccount',
  'enabled',
  'order'
]);

export default function AdminAgentEditPage() {
  const { t, i18n } = useTranslation();
  const currentLanguage = i18n.language;
  const navigate = useNavigate();
  const { profileId } = useParams();
  const isNew = !profileId || profileId === 'new';

  const [profile, setProfile] = useState(BLANK_PROFILE);
  const [models, setModels] = useState([]);
  const [apps, setApps] = useState([]);
  const [loading, setLoading] = useState(!isNew);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState(null);
  const [mode, setMode] = useState('form');

  useEffect(() => {
    (async () => {
      try {
        const [modelsResp, appsResp] = await Promise.all([fetchAdminModels(), fetchAdminApps()]);
        setModels(modelsResp?.data || modelsResp || []);
        setApps(appsResp?.data || appsResp || []);
      } catch (err) {
        // non-fatal — fields just won't show options
        console.warn('Failed to load models/apps', err);
      }
    })();
  }, []);

  useEffect(() => {
    if (isNew) return;
    (async () => {
      try {
        const data = await fetchAgentProfile(profileId);
        const loaded = data?.data || data || {};
        // Merge BLANK_PROFILE defaults with loaded so newly-added fields
        // (system, preferredModel, etc.) have sensible initial values when
        // editing an older profile.
        setProfile({ ...BLANK_PROFILE, ...loaded });
      } catch (err) {
        setError(err.message);
      } finally {
        setLoading(false);
      }
    })();
  }, [profileId, isNew]);

  // ─── Update helpers (flat-spread; CodeQL-friendly) ───────────────────────
  function handleField(field, value) {
    if (!TOP_LEVEL_FIELDS.has(field)) return;
    setProfile(prev => ({ ...prev, [field]: value }));
  }

  function handlePlanner(partial) {
    setProfile(prev => ({ ...prev, planner: { ...prev.planner, ...partial } }));
  }
  function handleDynamicTasks(partial) {
    setProfile(prev => ({ ...prev, dynamicTasks: { ...prev.dynamicTasks, ...partial } }));
  }
  function handleMemory(partial) {
    setProfile(prev => ({ ...prev, memory: { ...prev.memory, ...partial } }));
  }
  function handleBudgets(partial) {
    setProfile(prev => ({ ...prev, budgets: { ...prev.budgets, ...partial } }));
  }
  function handleConcurrency(partial) {
    setProfile(prev => ({ ...prev, concurrency: { ...prev.concurrency, ...partial } }));
  }
  function handleHitl(partial) {
    setProfile(prev => ({ ...prev, hitl: { ...prev.hitl, ...partial } }));
  }
  function handleServiceAccount(partial) {
    setProfile(prev => ({
      ...prev,
      serviceAccount: { ...prev.serviceAccount, ...partial }
    }));
  }
  function handleCronSchedule(cron) {
    setProfile(prev => {
      const triggers = cron ? [{ type: 'schedule', config: { cron, timezone: 'UTC' } }] : [];
      const def = prev.workflow?.definition || {};
      return {
        ...prev,
        workflow: {
          ...prev.workflow,
          ref: prev.workflow?.ref || 'embedded',
          definition: { ...def, triggers }
        }
      };
    });
  }

  // Strip empty entries from localized maps so we don't send `{en: ''}` which
  // some schemas reject as min-length violations.
  function cleanLocalized(obj) {
    if (!obj || typeof obj !== 'object') return obj;
    const out = {};
    for (const [lang, val] of Object.entries(obj)) {
      if (typeof val === 'string' && val.trim().length > 0) out[lang] = val;
    }
    return Object.keys(out).length > 0 ? out : undefined;
  }

  async function handleSave() {
    setError(null);
    setSaving(true);
    try {
      const payload = { ...profile };
      const name = cleanLocalized(payload.name);
      if (!name || Object.keys(name).length === 0) {
        setError(t('admin.agents.edit.nameRequired', 'Name is required (at least one language).'));
        setSaving(false);
        return;
      }
      payload.name = name;
      const description = cleanLocalized(payload.description);
      if (description) payload.description = description;
      else delete payload.description;
      const system = cleanLocalized(payload.system);
      if (system) payload.system = system;
      else delete payload.system;

      if (isNew) {
        await createAgentProfile(payload);
      } else {
        await updateAgentProfile(profileId, payload);
      }
      navigate('/admin/agents');
    } catch (err) {
      setError(err?.response?.data?.message || err.message);
    } finally {
      setSaving(false);
    }
  }

  if (loading) {
    return (
      <AdminAuth>
        <AdminNavigation />
        <div className="p-8 text-gray-600">{t('common.loading', 'Loading…')}</div>
      </AdminAuth>
    );
  }

  const cron =
    (profile.workflow?.definition?.triggers || []).find(tr => tr.type === 'schedule')?.config
      ?.cron || '';

  return (
    <AdminAuth>
      <div className="bg-gray-50 min-h-screen dark:bg-gray-900">
        <AdminNavigation />
        <div className="max-w-4xl mx-auto py-8 px-4">
          <div className="flex justify-between items-center mb-6">
            <h1 className="text-2xl font-bold text-gray-900 dark:text-gray-100">
              {isNew
                ? t('admin.agents.editNew', 'New Agent Profile')
                : profile.name?.en || profile.id}
            </h1>
            <div className="flex gap-2">
              <button
                onClick={() => setMode(mode === 'form' ? 'json' : 'form')}
                className="px-3 py-2 text-sm border bg-white rounded hover:bg-gray-50"
              >
                {mode === 'form'
                  ? t('admin.common.viewJson', 'JSON')
                  : t('admin.common.viewForm', 'Form')}
              </button>
              <button
                onClick={handleSave}
                disabled={saving}
                className="px-4 py-2 text-sm bg-indigo-600 text-white rounded disabled:opacity-50"
              >
                {saving ? t('common.saving', 'Saving…') : t('common.save', 'Save')}
              </button>
              <button
                onClick={() => navigate('/admin/agents')}
                className="px-3 py-2 text-sm border bg-white rounded hover:bg-gray-50"
              >
                {t('common.cancel', 'Cancel')}
              </button>
            </div>
          </div>

          {error && (
            <div className="mb-4 p-3 bg-red-50 border border-red-200 text-red-800 rounded">
              {error}
            </div>
          )}

          {mode === 'json' ? (
            <textarea
              className="w-full h-[600px] font-mono text-xs p-3 border rounded"
              value={JSON.stringify(profile, null, 2)}
              onChange={e => {
                try {
                  setProfile(JSON.parse(e.target.value));
                } catch {
                  // ignore parse errors while typing
                }
              }}
            />
          ) : (
            <div className="space-y-6">
              {/* Identity */}
              <Section title={t('admin.agents.edit.identity', 'Identity')}>
                <div className="grid grid-cols-1 sm:grid-cols-6 gap-4">
                  <FieldText
                    span={3}
                    label={t('admin.agents.edit.id', 'ID')}
                    required
                    disabled={!isNew}
                    value={profile.id}
                    onChange={v => handleField('id', v)}
                    placeholder="todo-worker"
                  />
                  <div className="sm:col-span-3 flex items-end">
                    <label className="flex items-center gap-2">
                      <input
                        type="checkbox"
                        checked={profile.enabled !== false}
                        onChange={e => handleField('enabled', e.target.checked)}
                        className="h-4 w-4 text-indigo-600 border-gray-300 rounded"
                      />
                      <span className="text-sm text-gray-700 dark:text-gray-300">
                        {t('admin.agents.edit.enabled', 'Enabled')}
                      </span>
                    </label>
                  </div>

                  <div className="sm:col-span-6">
                    <DynamicLanguageEditor
                      label={
                        <span>
                          {t('admin.agents.edit.name', 'Name')}
                          <span className="text-red-500 ml-1">*</span>
                        </span>
                      }
                      value={profile.name || {}}
                      onChange={v => handleField('name', v)}
                      required={true}
                      placeholder={{ en: 'TODO Worker', de: 'TODO-Worker' }}
                      name="name"
                    />
                  </div>

                  <div className="sm:col-span-6">
                    <DynamicLanguageEditor
                      label={t('admin.agents.edit.description', 'Description')}
                      value={profile.description || {}}
                      onChange={v => handleField('description', v)}
                      type="textarea"
                      placeholder={{
                        en: 'Short summary of what this agent does.',
                        de: 'Kurze Beschreibung dessen, was dieser Agent tut.'
                      }}
                      name="description"
                    />
                  </div>

                  <div className="sm:col-span-3">
                    <label className="block text-sm font-medium text-gray-700 dark:text-gray-300">
                      {t('admin.agents.edit.color', 'Color')}
                    </label>
                    <div className="mt-1 flex items-center gap-2">
                      <input
                        type="color"
                        value={profile.color || '#6366F1'}
                        onChange={e => handleField('color', e.target.value)}
                        className="h-9 w-12 rounded border border-gray-300 cursor-pointer"
                      />
                      <input
                        type="text"
                        value={profile.color || ''}
                        onChange={e => handleField('color', e.target.value)}
                        placeholder="#6366F1"
                        className="block w-full rounded-lg border-gray-300 shadow-sm focus:border-indigo-500 focus:ring-indigo-500 sm:text-sm font-mono dark:bg-gray-700 dark:border-gray-600 dark:text-gray-100"
                      />
                    </div>
                  </div>

                  <div className="sm:col-span-3">
                    <label className="block text-sm font-medium text-gray-700 dark:text-gray-300">
                      {t('admin.agents.edit.icon', 'Icon')}
                    </label>
                    <IconPicker
                      value={profile.icon || ''}
                      onChange={v => handleField('icon', v)}
                      className="mt-1"
                    />
                  </div>
                </div>
              </Section>

              {/* Brief — what the agent is and does */}
              <Section
                title={t('admin.agents.edit.brief', 'Agent brief')}
                hint={t(
                  'admin.agents.edit.briefHint',
                  'The system prompt every step of the agent receives. Tell it who it is, what its job is, when to ask a human, and what it should leave behind (artifacts).'
                )}
              >
                <DynamicLanguageEditor
                  label={t('admin.agents.edit.system', 'System Instructions')}
                  value={profile.system || {}}
                  onChange={v => handleField('system', v)}
                  type="textarea"
                  placeholder={{
                    en: 'You are a TODO Worker. On each wake call read_inbox, pick the highest-priority item, do the work, call write_artifact, then write_inbox(mode=markDone).',
                    de: 'Du bist ein TODO-Worker. Rufe bei jedem Wake read_inbox auf, wähle den wichtigsten Eintrag, erledige die Arbeit, rufe write_artifact und write_inbox(mode=markDone) auf.'
                  }}
                  name="system"
                />
              </Section>

              {/* Model & decoding */}
              <Section
                title={t('admin.agents.edit.model', 'Model')}
                hint={t(
                  'admin.agents.edit.modelHint',
                  'Image-generation models are filtered out — agents need a text model that can produce JSON for the planner and tool calls.'
                )}
              >
                <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
                  <div>
                    <label className="block text-sm font-medium text-gray-700 dark:text-gray-300">
                      {t('admin.agents.edit.preferredModel', 'Preferred model')}
                    </label>
                    <select
                      value={profile.preferredModel || ''}
                      onChange={e => handleField('preferredModel', e.target.value)}
                      className="mt-1 block w-full rounded-lg border-gray-300 shadow-sm focus:border-indigo-500 focus:ring-indigo-500 sm:text-sm dark:bg-gray-700 dark:border-gray-600 dark:text-gray-100"
                    >
                      <option value="">
                        {t('admin.agents.edit.selectModel', 'Pick a text model…')}
                      </option>
                      {models
                        .filter(m => !m.supportsImageGeneration)
                        .map(m => (
                          <option key={m.id} value={m.id}>
                            {getLocalizedContent(m.name, currentLanguage) || m.id}
                          </option>
                        ))}
                    </select>
                    {!profile.preferredModel && (
                      <p className="mt-1 text-xs text-yellow-700 dark:text-yellow-400">
                        {t(
                          'admin.agents.edit.modelWarn',
                          'No model selected — the platform default may be an image model and break the planner.'
                        )}
                      </p>
                    )}
                  </div>
                  <div>
                    <label className="block text-sm font-medium text-gray-700 dark:text-gray-300">
                      {t('admin.agents.edit.temperature', 'Temperature')}
                    </label>
                    <input
                      type="number"
                      min="0"
                      max="2"
                      step="0.1"
                      value={profile.preferredTemperature ?? 0.7}
                      onChange={e =>
                        handleField('preferredTemperature', parseFloat(e.target.value))
                      }
                      className="mt-1 block w-full rounded-lg border-gray-300 shadow-sm focus:border-indigo-500 focus:ring-indigo-500 sm:text-sm dark:bg-gray-700 dark:border-gray-600 dark:text-gray-100"
                    />
                  </div>
                  <div>
                    <label className="block text-sm font-medium text-gray-700 dark:text-gray-300">
                      {t('admin.agents.edit.maxIterations', 'Max tool-call iterations per step')}
                    </label>
                    <input
                      type="number"
                      min="1"
                      max="50"
                      value={profile.maxIterations ?? 10}
                      onChange={e => handleField('maxIterations', parseInt(e.target.value) || 10)}
                      className="mt-1 block w-full rounded-lg border-gray-300 shadow-sm focus:border-indigo-500 focus:ring-indigo-500 sm:text-sm dark:bg-gray-700 dark:border-gray-600 dark:text-gray-100"
                    />
                  </div>
                </div>
              </Section>

              {/* Capabilities — tools, apps, sources */}
              <Section
                title={t('admin.agents.edit.capabilities', 'Capabilities')}
                hint={t(
                  'admin.agents.edit.capabilitiesHint',
                  'Memory/inbox/task/artifact tools are auto-registered for every agent. Add provider tools (e.g. webContentExtractor), iHub Apps (for App-as-tool), or knowledge sources here.'
                )}
              >
                <div className="space-y-4">
                  <div>
                    <label className="block text-sm font-medium text-gray-700 dark:text-gray-300">
                      {t('admin.agents.edit.tools', 'Tools')}
                    </label>
                    <ToolsSelector
                      selectedTools={profile.tools || []}
                      onToolsChange={tools => handleField('tools', tools)}
                    />
                  </div>

                  <div>
                    <label className="block text-sm font-medium text-gray-700 dark:text-gray-300">
                      {t('admin.agents.edit.apps', 'iHub Apps (App-as-tool)')}
                    </label>
                    <p className="text-xs text-gray-500 dark:text-gray-400 mb-2">
                      {t(
                        'admin.agents.edit.appsHint',
                        'Apps the agent can invoke as synthetic tools (app__<id>). Requires the features.appAsTool flag to be ON.'
                      )}
                    </p>
                    <AppMultiSelect
                      value={profile.apps || []}
                      apps={apps}
                      onChange={v => handleField('apps', v)}
                      currentLanguage={currentLanguage}
                      t={t}
                    />
                  </div>

                  <div>
                    <label className="block text-sm font-medium text-gray-700 dark:text-gray-300">
                      {t('admin.agents.edit.sources', 'Sources')}
                    </label>
                    <SourcePicker
                      value={profile.sources || []}
                      onChange={v => handleField('sources', v)}
                    />
                  </div>
                </div>
              </Section>

              {/* Decomposition */}
              <Section
                title={t('admin.agents.edit.decomposition', 'Decomposition')}
                hint={t(
                  'admin.agents.edit.decompositionHint',
                  'How the agent breaks work into smaller pieces. Pick whichever applies; if neither is on, the agent runs as a single Prompt step.'
                )}
              >
                <div className="space-y-4">
                  <div className="rounded border border-gray-200 dark:border-gray-700 p-3">
                    <label className="flex items-start gap-2">
                      <input
                        type="checkbox"
                        checked={!!profile.planner?.enabled}
                        onChange={e => handlePlanner({ enabled: e.target.checked })}
                        className="h-4 w-4 mt-0.5 text-indigo-600 border-gray-300 rounded"
                      />
                      <span>
                        <span className="text-sm font-medium text-gray-800 dark:text-gray-200">
                          {t('admin.agents.edit.plannerEnabled', 'Planner (upfront)')}
                        </span>
                        <p className="text-xs text-gray-500 dark:text-gray-400 mt-0.5">
                          {t(
                            'admin.agents.edit.plannerExplain',
                            'Before doing work, a Planner LLM call produces N sub-tasks and the runtime materializes them as a sub-workflow. Best when the work is non-trivially decomposable up front (research, multi-step analysis).'
                          )}
                        </p>
                      </span>
                    </label>
                    <div className="mt-2 pl-6">
                      <label className="block text-xs text-gray-600 dark:text-gray-400">
                        {t('admin.agents.edit.plannerMaxTasks', 'Max tasks in initial plan')}
                      </label>
                      <input
                        type="number"
                        min="1"
                        max="50"
                        disabled={!profile.planner?.enabled}
                        value={profile.planner?.maxTasks ?? 10}
                        onChange={e => handlePlanner({ maxTasks: Number(e.target.value) })}
                        className="mt-1 block w-32 rounded-lg border-gray-300 shadow-sm focus:border-indigo-500 focus:ring-indigo-500 sm:text-sm dark:bg-gray-700 dark:border-gray-600 dark:text-gray-100 disabled:opacity-50"
                      />
                    </div>
                  </div>

                  <div className="rounded border border-gray-200 dark:border-gray-700 p-3">
                    <label className="flex items-start gap-2">
                      <input
                        type="checkbox"
                        checked={!!profile.dynamicTasks?.enabled}
                        onChange={e => handleDynamicTasks({ enabled: e.target.checked })}
                        className="h-4 w-4 mt-0.5 text-indigo-600 border-gray-300 rounded"
                      />
                      <span>
                        <span className="text-sm font-medium text-gray-800 dark:text-gray-200">
                          {t('admin.agents.edit.dynamicTasksEnabled', 'Dynamic tasks (runtime)')}
                        </span>
                        <p className="text-xs text-gray-500 dark:text-gray-400 mt-0.5">
                          {t(
                            'admin.agents.edit.dynamicTasksExplain',
                            'At runtime the agent may call create_task() to enqueue work; a drain loop processes it FIFO until empty. Best when sub-tasks are discovered mid-run (e.g. one inbox item turns into 3 follow-ups). Combine with Planner if you also want an upfront plan.'
                          )}
                        </p>
                      </span>
                    </label>
                    <div className="mt-2 pl-6">
                      <label className="block text-xs text-gray-600 dark:text-gray-400">
                        {t(
                          'admin.agents.edit.maxDepth',
                          'Max depth (refuse create_task beyond this nesting)'
                        )}
                      </label>
                      <input
                        type="number"
                        min="0"
                        max="10"
                        disabled={!profile.dynamicTasks?.enabled}
                        value={profile.dynamicTasks?.maxDepth ?? 3}
                        onChange={e => handleDynamicTasks({ maxDepth: Number(e.target.value) })}
                        className="mt-1 block w-32 rounded-lg border-gray-300 shadow-sm focus:border-indigo-500 focus:ring-indigo-500 sm:text-sm dark:bg-gray-700 dark:border-gray-600 dark:text-gray-100 disabled:opacity-50"
                      />
                    </div>
                  </div>
                </div>
              </Section>

              {/* Schedule */}
              <Section
                title={t('admin.agents.edit.schedule', 'Schedule')}
                hint={t(
                  'admin.agents.edit.scheduleHint',
                  'Optional cron expression. The agent runs on this schedule under its service-account identity. Leave empty for manual / webhook only.'
                )}
              >
                <input
                  type="text"
                  placeholder="*/15 * * * *"
                  value={cron}
                  onChange={e => handleCronSchedule(e.target.value)}
                  className="block w-full rounded-lg border-gray-300 shadow-sm focus:border-indigo-500 focus:ring-indigo-500 sm:text-sm font-mono dark:bg-gray-700 dark:border-gray-600 dark:text-gray-100"
                />
              </Section>

              {/* Inbox */}
              <Section
                title={t('admin.agents.edit.inbox', 'Inbox')}
                hint={t(
                  'admin.agents.edit.inboxHint',
                  'Optional. ID of the inbox this agent reads work from via read_inbox. Create inboxes from Agents → Inboxes.'
                )}
              >
                <input
                  type="text"
                  placeholder="engineering-todos"
                  value={profile.inboxId || ''}
                  onChange={e => handleField('inboxId', e.target.value)}
                  className="block w-full rounded-lg border-gray-300 shadow-sm focus:border-indigo-500 focus:ring-indigo-500 sm:text-sm dark:bg-gray-700 dark:border-gray-600 dark:text-gray-100"
                />
              </Section>

              {/* Memory */}
              <Section title={t('admin.agents.edit.memory', 'Memory')}>
                <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
                  <label className="flex items-center gap-2">
                    <input
                      type="checkbox"
                      checked={profile.memory?.enabled !== false}
                      onChange={e => handleMemory({ enabled: e.target.checked })}
                      className="h-4 w-4 text-indigo-600 border-gray-300 rounded"
                    />
                    <span className="text-sm text-gray-700 dark:text-gray-300">
                      {t('admin.agents.edit.memoryEnabled', 'Enabled')}
                    </span>
                  </label>
                  <label className="flex items-center gap-2">
                    <input
                      type="checkbox"
                      checked={profile.memory?.autoInclude !== false}
                      onChange={e => handleMemory({ autoInclude: e.target.checked })}
                      className="h-4 w-4 text-indigo-600 border-gray-300 rounded"
                    />
                    <span className="text-sm text-gray-700 dark:text-gray-300">
                      {t('admin.agents.edit.autoInclude', 'Auto-include in prompt')}
                    </span>
                  </label>
                  <div>
                    <label className="block text-sm font-medium text-gray-700 dark:text-gray-300">
                      {t('admin.agents.edit.maxBytes', 'Max bytes')}
                    </label>
                    <input
                      type="number"
                      min="0"
                      max="1000000"
                      value={profile.memory?.maxBytes ?? 8192}
                      onChange={e => handleMemory({ maxBytes: Number(e.target.value) })}
                      className="mt-1 block w-full rounded-lg border-gray-300 shadow-sm focus:border-indigo-500 focus:ring-indigo-500 sm:text-sm dark:bg-gray-700 dark:border-gray-600 dark:text-gray-100"
                    />
                  </div>
                </div>
                {!isNew && (
                  <button
                    type="button"
                    onClick={() => navigate(`/admin/agents/${profile.id}/memory`)}
                    className="mt-3 text-sm text-indigo-600 hover:underline"
                  >
                    {t('admin.agents.edit.editMemoryFile', 'Edit memory file →')}
                  </button>
                )}
              </Section>

              {/* Budgets & concurrency */}
              <Section title={t('admin.agents.edit.budgets', 'Budgets & concurrency')}>
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                  <div>
                    <label className="block text-sm font-medium text-gray-700 dark:text-gray-300">
                      {t('admin.agents.edit.maxWallTimeSec', 'Max wall time (seconds)')}
                    </label>
                    <input
                      type="number"
                      min="10"
                      max="86400"
                      value={profile.budgets?.maxWallTimeSec ?? 600}
                      onChange={e => handleBudgets({ maxWallTimeSec: Number(e.target.value) })}
                      className="mt-1 block w-full rounded-lg border-gray-300 shadow-sm focus:border-indigo-500 focus:ring-indigo-500 sm:text-sm dark:bg-gray-700 dark:border-gray-600 dark:text-gray-100"
                    />
                  </div>
                  <div>
                    <label className="block text-sm font-medium text-gray-700 dark:text-gray-300">
                      {t('admin.agents.edit.maxConcurrent', 'Max concurrent runs')}
                    </label>
                    <input
                      type="number"
                      min="1"
                      max="10"
                      value={profile.concurrency?.maxConcurrent ?? 1}
                      onChange={e => handleConcurrency({ maxConcurrent: Number(e.target.value) })}
                      className="mt-1 block w-full rounded-lg border-gray-300 shadow-sm focus:border-indigo-500 focus:ring-indigo-500 sm:text-sm dark:bg-gray-700 dark:border-gray-600 dark:text-gray-100"
                    />
                  </div>
                </div>
              </Section>

              {/* HITL */}
              <Section
                title={t('admin.agents.edit.hitl', 'HITL approver groups')}
                hint={t(
                  'admin.agents.edit.hitlHint',
                  'Comma-separated group IDs. Users in any of these groups can approve human-checkpoint pauses for this profile.'
                )}
              >
                <input
                  type="text"
                  placeholder="agent-operators"
                  value={(profile.hitl?.approverGroups || []).join(',')}
                  onChange={e =>
                    handleHitl({
                      approverGroups: e.target.value
                        .split(',')
                        .map(s => s.trim())
                        .filter(Boolean)
                    })
                  }
                  className="block w-full rounded-lg border-gray-300 shadow-sm focus:border-indigo-500 focus:ring-indigo-500 sm:text-sm dark:bg-gray-700 dark:border-gray-600 dark:text-gray-100"
                />
              </Section>

              {/* Service account */}
              <Section
                title={t('admin.agents.edit.serviceAccount', 'Service account groups')}
                hint={t(
                  'admin.agents.edit.serviceAccountHint',
                  'Groups the agent principal (agent:<id>) belongs to. These determine which apps/tools/models the agent can access via the standard group permission system.'
                )}
              >
                <input
                  type="text"
                  placeholder="agents,authenticated"
                  value={(profile.serviceAccount?.groups || []).join(',')}
                  onChange={e =>
                    handleServiceAccount({
                      groups: e.target.value
                        .split(',')
                        .map(s => s.trim())
                        .filter(Boolean)
                    })
                  }
                  className="block w-full rounded-lg border-gray-300 shadow-sm focus:border-indigo-500 focus:ring-indigo-500 sm:text-sm dark:bg-gray-700 dark:border-gray-600 dark:text-gray-100"
                />
              </Section>
            </div>
          )}
        </div>
      </div>
    </AdminAuth>
  );
}

function Section({ title, hint, children }) {
  return (
    <div className="bg-white dark:bg-gray-800 shadow rounded-lg p-6">
      <h2 className="text-lg font-semibold text-gray-900 dark:text-gray-100">{title}</h2>
      {hint && <p className="mt-1 mb-3 text-sm text-gray-500 dark:text-gray-400">{hint}</p>}
      {!hint && <div className="mt-3" />}
      {children}
    </div>
  );
}

function FieldText({ span, label, required, value, onChange, placeholder, disabled }) {
  const colClass = span === 3 ? 'sm:col-span-3' : span === 6 ? 'sm:col-span-6' : '';
  return (
    <div className={colClass}>
      <label className="block text-sm font-medium text-gray-700 dark:text-gray-300">
        {label}
        {required && <span className="text-red-500 ml-1">*</span>}
      </label>
      <input
        type="text"
        disabled={disabled}
        value={value || ''}
        onChange={e => onChange(e.target.value)}
        placeholder={placeholder}
        className="mt-1 block w-full rounded-lg border-gray-300 shadow-sm focus:border-indigo-500 focus:ring-indigo-500 sm:text-sm dark:bg-gray-700 dark:border-gray-600 dark:text-gray-100 disabled:opacity-50"
      />
    </div>
  );
}

function AppMultiSelect({ value, apps, onChange, currentLanguage, t }) {
  const valueSet = new Set(value || []);
  function toggle(id) {
    const next = new Set(valueSet);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    onChange(Array.from(next));
  }
  const enabled = (apps || []).filter(
    a => a.enabled !== false && a.type !== 'redirect' && a.type !== 'iframe'
  );
  return (
    <div className="rounded-lg border border-gray-200 dark:border-gray-700 max-h-56 overflow-y-auto">
      {enabled.length === 0 ? (
        <p className="p-3 text-xs text-gray-500 dark:text-gray-400">
          {t('admin.agents.edit.noApps', 'No chat-type apps available.')}
        </p>
      ) : (
        <ul className="divide-y divide-gray-200 dark:divide-gray-700">
          {enabled.map(a => (
            <li key={a.id} className="px-3 py-2">
              <label className="flex items-center gap-2 cursor-pointer">
                <input
                  type="checkbox"
                  checked={valueSet.has(a.id)}
                  onChange={() => toggle(a.id)}
                  className="h-4 w-4 text-indigo-600 border-gray-300 rounded"
                />
                <span className="text-sm text-gray-800 dark:text-gray-200">
                  {getLocalizedContent(a.name, currentLanguage) || a.id}
                </span>
                <span className="text-xs text-gray-500 font-mono">{a.id}</span>
              </label>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
