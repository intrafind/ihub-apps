import { useState, useEffect } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import AdminBreadcrumb from '../components/AdminBreadcrumb';
import { useUnsavedChanges } from '../hooks/useUnsavedChanges';
import ConfirmDialog from '../../../shared/components/ConfirmDialog';
import DynamicLanguageEditor from '../../../shared/components/DynamicLanguageEditor';
import IconPicker from '../../../shared/components/IconPicker';
import ToolsSelector from '../../../shared/components/ToolsSelector';
import SkillsSelector from '../../../shared/components/SkillsSelector';
import SourcePicker from '../components/SourcePicker';
import { getLocalizedContent } from '../../../utils/localizeContent';
import { fetchAdminApps, fetchAdminModels, getAdminApiErrorMessage } from '../../../api/adminApi';
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
  skills: [],
  memory: {
    enabled: true,
    autoInclude: true,
    maxBytes: 8192,
    modelId: '',
    temperature: 0.2,
    system: { en: '' },
    prompt: { en: '' }
  },
  inboxId: '',
  hitl: { approverGroups: [] },
  planner: {
    enabled: false,
    maxTasks: 10,
    system: { en: '' },
    goal: { en: '' },
    modelId: ''
  },
  synthesizer: {
    enabled: true,
    system: { en: '' },
    prompt: { en: '' },
    modelId: ''
  },
  dynamicTasks: { enabled: false, maxDepth: 3 },
  review: {
    enabled: false,
    strictness: 'balanced',
    modelId: '',
    system: { en: '' }
  },
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
  'skills',
  'memory',
  'inboxId',
  'hitl',
  'planner',
  'synthesizer',
  'dynamicTasks',
  'review',
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

  const [profile, setProfile] = useState(() => structuredClone(BLANK_PROFILE));
  const [initialData, setInitialData] = useState(() =>
    isNew ? structuredClone(BLANK_PROFILE) : null
  );
  const [models, setModels] = useState([]);
  const [apps, setApps] = useState([]);
  const [loading, setLoading] = useState(!isNew);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState(null);
  const [mode, setMode] = useState('form');

  const { blocker, markSaved } = useUnsavedChanges(initialData, profile);

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
        const mergedProfile = { ...BLANK_PROFILE, ...loaded };
        setProfile(mergedProfile);
        setInitialData(structuredClone(mergedProfile));
      } catch (err) {
        setError(getAdminApiErrorMessage(err));
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
  function handleSynthesizer(partial) {
    setProfile(prev => ({ ...prev, synthesizer: { ...prev.synthesizer, ...partial } }));
  }

  // Pre-compute the Google+webSearch+apps incompatibility flag so the JSX
  // doesn't need an IIFE (which trips the React-compiler-aware lint rule).
  const incompatibleAppGroundingCombo = (() => {
    const modelId = profile.preferredModel || '';
    const selectedModel = models.find(m => m.id === modelId);
    const isGoogle = selectedModel?.provider === 'google';
    const hasWebSearch = (profile.tools || []).includes('webSearch');
    const hasApps = (profile.apps || []).length > 0;
    if (isGoogle && hasWebSearch && hasApps) return modelId;
    return null;
  })();
  function handleDynamicTasks(partial) {
    setProfile(prev => ({ ...prev, dynamicTasks: { ...prev.dynamicTasks, ...partial } }));
  }
  function handleReview(partial) {
    setProfile(prev => ({ ...prev, review: { ...prev.review, ...partial } }));
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
      const payload = structuredClone(profile);
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

      // Clean nested localized fields on planner/synthesizer so empty strings
      // don't reach the backend schema (which rejects empty localized maps).
      if (payload.planner && typeof payload.planner === 'object') {
        const plannerSystem = cleanLocalized(payload.planner.system);
        if (plannerSystem) payload.planner.system = plannerSystem;
        else delete payload.planner.system;
        const plannerGoal = cleanLocalized(payload.planner.goal);
        if (plannerGoal) payload.planner.goal = plannerGoal;
        else delete payload.planner.goal;
        if (typeof payload.planner.modelId === 'string' && !payload.planner.modelId.trim()) {
          delete payload.planner.modelId;
        }
      }
      if (payload.synthesizer && typeof payload.synthesizer === 'object') {
        const synthSystem = cleanLocalized(payload.synthesizer.system);
        if (synthSystem) payload.synthesizer.system = synthSystem;
        else delete payload.synthesizer.system;
        const synthPrompt = cleanLocalized(payload.synthesizer.prompt);
        if (synthPrompt) payload.synthesizer.prompt = synthPrompt;
        else delete payload.synthesizer.prompt;
        if (
          typeof payload.synthesizer.modelId === 'string' &&
          !payload.synthesizer.modelId.trim()
        ) {
          delete payload.synthesizer.modelId;
        }
      }
      if (payload.memory && typeof payload.memory === 'object') {
        const memorySystem = cleanLocalized(payload.memory.system);
        if (memorySystem) payload.memory.system = memorySystem;
        else delete payload.memory.system;
        const memoryPrompt = cleanLocalized(payload.memory.prompt);
        if (memoryPrompt) payload.memory.prompt = memoryPrompt;
        else delete payload.memory.prompt;
        if (typeof payload.memory.modelId === 'string' && !payload.memory.modelId.trim()) {
          delete payload.memory.modelId;
        }
      }
      if (payload.review && typeof payload.review === 'object') {
        const reviewSystem = cleanLocalized(payload.review.system);
        if (reviewSystem) payload.review.system = reviewSystem;
        else delete payload.review.system;
        if (typeof payload.review.modelId === 'string' && !payload.review.modelId.trim()) {
          delete payload.review.modelId;
        }
        ['maxRounds', 'stallLimit'].forEach(k => {
          if (payload.review[k] == null || payload.review[k] === '') delete payload.review[k];
        });
        if (typeof payload.review.criteria === 'string' && !payload.review.criteria.trim())
          delete payload.review.criteria;
      }

      if (isNew) {
        await createAgentProfile(payload);
      } else {
        await updateAgentProfile(profileId, payload);
      }
      markSaved();
      navigate('/admin/agents');
    } catch (err) {
      setError(err?.response?.data?.message || err.message);
    } finally {
      setSaving(false);
    }
  }

  if (loading) {
    return <div className="p-8 text-gray-600">{t('common.loading', 'Loading…')}</div>;
  }

  const cron =
    (profile.workflow?.definition?.triggers || []).find(tr => tr.type === 'schedule')?.config
      ?.cron || '';

  return (
    <div className="bg-gray-50 min-h-screen dark:bg-gray-900">
      <div className="max-w-4xl mx-auto py-8 px-4">
        <AdminBreadcrumb
          crumbs={[
            { label: 'Admin', href: '/admin' },
            { label: 'Agents', href: '/admin/agents' },
            { label: isNew ? 'New Agent' : (profile?.name?.en ?? profileId) }
          ]}
        />
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

            {/* Agent persona — used when executing planned tasks. */}
            <Section
              title={t('admin.agents.edit.brief', 'Agent persona')}
              hint={t(
                'admin.agents.edit.briefHint',
                "The persona used when executing planned tasks. Describes the agent's role, voice, and domain expertise. Do NOT include workflow instructions (read inbox / write artifact / mark done) — the runtime handles those automatically."
              )}
            >
              <DynamicLanguageEditor
                label={t('admin.agents.edit.system', 'Agent persona system prompt')}
                value={profile.system || {}}
                onChange={v => handleField('system', v)}
                type="textarea"
                placeholder={{
                  en: 'You are a research analyst with deep knowledge of enterprise software. Be concise, cite sources, and prefer primary documentation over secondary commentary.',
                  de: 'Du bist ein Research-Analyst mit fundierten Kenntnissen über Unternehmenssoftware. Fasse dich kurz, zitiere Quellen und bevorzuge Primärdokumentation gegenüber Sekundärkommentaren.'
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
                    onChange={e => handleField('preferredTemperature', parseFloat(e.target.value))}
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
              title={t('admin.agents.edit.capabilities', 'Capabilities (task executors)')}
              hint={t(
                'admin.agents.edit.capabilitiesHint',
                'Research tools available to each planned task — webSearch, calculators, apps, knowledge sources. Memory tools are auto-attached. Inbox and artifact lifecycle are owned by the runtime now, NOT exposed as LLM tools (add them here only as an opt-in escape hatch).'
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
                  {incompatibleAppGroundingCombo && (
                    <div className="mt-2 text-xs bg-amber-50 border border-amber-300 rounded p-2 text-amber-900">
                      <span className="font-medium">⚠ App tools won’t run on this profile.</span>{' '}
                      {incompatibleAppGroundingCombo} (Google) uses native grounding when{' '}
                      <span className="font-mono">webSearch</span> is configured, and Google models
                      can’t combine native grounding with function calling. To use apps: remove{' '}
                      <span className="font-mono">webSearch</span> from Tools, or pick a non-Google
                      model.
                    </div>
                  )}
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

                <div>
                  <label className="block text-sm font-medium text-gray-700 dark:text-gray-300">
                    {t('admin.agents.edit.skills', 'Skills (instructional knowledge)')}
                  </label>
                  <p className="text-xs text-gray-500 dark:text-gray-400 mb-2">
                    {t(
                      'admin.agents.edit.skillsHint',
                      'Skills describe HOW to do something (e.g. "for person research, do these steps"). The planner sees the list and can pre-activate skills via the plan JSON; task workers can also activate them mid-run via the activate_skill tool. The runtime injects activated skill bodies into the system prompt so the agent follows them.'
                    )}
                  </p>
                  <SkillsSelector
                    selectedSkills={profile.skills || []}
                    onSkillsChange={skills => handleField('skills', skills)}
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
                  <div className="mt-2 pl-6 space-y-3">
                    <div>
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
                    <div>
                      <label className="block text-xs text-gray-600 dark:text-gray-400">
                        {t('admin.agents.edit.plannerModel', 'Planner model (optional)')}
                      </label>
                      <p className="text-xs text-gray-500 dark:text-gray-400 mt-0.5">
                        {t(
                          'admin.agents.edit.plannerModelHint',
                          'Override the agent model for the decomposition LLM call. Useful when you want a stronger model for planning and a cheaper model for execution. Leave blank to inherit Preferred model.'
                        )}
                      </p>
                      <select
                        disabled={!profile.planner?.enabled}
                        value={profile.planner?.modelId || ''}
                        onChange={e => handlePlanner({ modelId: e.target.value })}
                        className="mt-1 block w-full rounded-lg border-gray-300 shadow-sm focus:border-indigo-500 focus:ring-indigo-500 sm:text-sm dark:bg-gray-700 dark:border-gray-600 dark:text-gray-100 disabled:opacity-50"
                      >
                        <option value="">
                          {t('admin.agents.edit.plannerModelInherit', '(inherit Preferred model)')}
                        </option>
                        {models
                          .filter(m => !m.supportsImageGeneration)
                          .map(m => (
                            <option key={m.id} value={m.id}>
                              {getLocalizedContent(m.name, currentLanguage) || m.id}
                            </option>
                          ))}
                      </select>
                    </div>
                    <DynamicLanguageEditor
                      label={t(
                        'admin.agents.edit.plannerSystem',
                        'Planner system prompt (instructions for decomposition)'
                      )}
                      value={profile.planner?.system || {}}
                      onChange={v => handlePlanner({ system: v })}
                      type="textarea"
                      placeholder={{
                        en: 'You are a planner. Given a brief, decompose it into independently-executable research/work tasks. Return a structured JSON plan.',
                        de: 'Du bist ein Planer. Zerlege den Auftrag in unabhängig ausführbare Recherche-/Arbeitsschritte. Antworte mit einem strukturierten JSON-Plan.'
                      }}
                      name="planner-system"
                    />
                    <DynamicLanguageEditor
                      label={t(
                        'admin.agents.edit.plannerGoal',
                        'Planner goal template (what the planner is given)'
                      )}
                      value={profile.planner?.goal || {}}
                      onChange={v => handlePlanner({ goal: v })}
                      type="textarea"
                      placeholder={{
                        en: '## Item to process\n${$.data.currentInboxItem}\n\n## Original brief\n${$.data.brief}',
                        de: '## Bearbeitungspunkt\n${$.data.currentInboxItem}\n\n## Ursprünglicher Auftrag\n${$.data.brief}'
                      }}
                      name="planner-goal"
                    />
                    <p className="text-xs text-gray-500 dark:text-gray-400">
                      {t(
                        'admin.agents.edit.plannerVariables',
                        'Available variables: ${$.data.currentInboxItem} — the item picked from the inbox; ${$.data.brief} — the original trigger brief.'
                      )}
                    </p>
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
                  <div>
                    <label className="block text-xs text-gray-600 dark:text-gray-400">
                      {t(
                        'admin.agents.edit.dynamicTasksModel',
                        'Preferred model for sub-task executions'
                      )}
                    </label>
                    <select
                      disabled={!profile.dynamicTasks?.enabled}
                      value={profile.dynamicTasks?.modelId || ''}
                      onChange={e => handleDynamicTasks({ modelId: e.target.value || undefined })}
                      className="mt-1 block w-full rounded-lg border-gray-300 shadow-sm focus:border-indigo-500 focus:ring-indigo-500 sm:text-sm dark:bg-gray-700 dark:border-gray-600 dark:text-gray-100 disabled:opacity-50"
                    >
                      <option value="">
                        {t(
                          'admin.agents.edit.dynamicTasksModelDefault',
                          '(use agent preferred model)'
                        )}
                      </option>
                      {(models || []).map(m => (
                        <option key={m.id} value={m.id}>
                          {m.name?.en || m.name || m.id}
                        </option>
                      ))}
                    </select>
                    <p className="mt-1 text-xs text-gray-500 dark:text-gray-400">
                      {t(
                        'admin.agents.edit.dynamicTasksModelHint',
                        'Optional: pick a cheaper / faster model for the per-task workers while the orchestrating agent keeps a stronger model. The selected model is also propagated to any app__* invocations.'
                      )}
                    </p>
                  </div>
                </div>
              </div>
            </Section>

            {/* Synthesizer — final LLM step that composes the report */}
            <Section
              title={t('admin.agents.edit.synthesizer', 'Synthesizer (final report)')}
              hint={t(
                'admin.agents.edit.synthesizerHint',
                'A single LLM call that composes the final markdown deliverable from the planned task results. The synthesizer has no tools — it is pure text-in/text-out, and the runtime persists its output as the primary artifact. Disable for cases where the last task is itself the final artifact.'
              )}
            >
              <div className="space-y-4">
                <label className="flex items-start gap-2">
                  <input
                    type="checkbox"
                    checked={profile.synthesizer?.enabled !== false}
                    onChange={e => handleSynthesizer({ enabled: e.target.checked })}
                    className="h-4 w-4 mt-0.5 text-indigo-600 border-gray-300 rounded"
                  />
                  <span>
                    <span className="text-sm font-medium text-gray-800 dark:text-gray-200">
                      {t('admin.agents.edit.synthesizerEnabled', 'Synthesize final report')}
                    </span>
                    <p className="text-xs text-gray-500 dark:text-gray-400 mt-0.5">
                      {t(
                        'admin.agents.edit.synthesizerEnabledHint',
                        'When enabled, after all planner tasks complete the synthesizer runs once and the runtime saves its output as the primary artifact (default report.md). Inbox lifecycle is closed by the runtime afterwards.'
                      )}
                    </p>
                  </span>
                </label>
                <div>
                  <label className="block text-sm text-gray-600 dark:text-gray-400">
                    {t('admin.agents.edit.synthesizerModel', 'Synthesizer model (optional)')}
                  </label>
                  <select
                    value={profile.synthesizer?.modelId || ''}
                    onChange={e => handleSynthesizer({ modelId: e.target.value })}
                    className="mt-1 block w-full rounded-lg border-gray-300 shadow-sm focus:border-indigo-500 focus:ring-indigo-500 sm:text-sm dark:bg-gray-700 dark:border-gray-600 dark:text-gray-100"
                  >
                    <option value="">
                      {t('admin.agents.edit.synthesizerModelInherit', '(inherit Preferred model)')}
                    </option>
                    {models
                      .filter(m => !m.supportsImageGeneration)
                      .map(m => (
                        <option key={m.id} value={m.id}>
                          {getLocalizedContent(m.name, currentLanguage) || m.id}
                        </option>
                      ))}
                  </select>
                </div>
                <div>
                  <label className="block text-sm text-gray-600 dark:text-gray-400">
                    {t('admin.agents.edit.synthesizerMaxTokens', 'Output token budget')}
                  </label>
                  <p className="text-xs text-gray-500 dark:text-gray-400 mt-0.5">
                    {t(
                      'admin.agents.edit.synthesizerMaxTokensHint',
                      'Hard cap on the synthesizer output. Provider defaults (4-8K) frequently truncate comprehensive research reports — raise this if you see the report cut off. Cost scales with the value.'
                    )}
                  </p>
                  <input
                    type="number"
                    min="1000"
                    max="32000"
                    step="1000"
                    value={profile.synthesizer?.maxTokens ?? 8000}
                    onChange={e => handleSynthesizer({ maxTokens: Number(e.target.value) || 8000 })}
                    className="mt-1 block w-40 rounded-lg border-gray-300 shadow-sm focus:border-indigo-500 focus:ring-indigo-500 sm:text-sm dark:bg-gray-700 dark:border-gray-600 dark:text-gray-100"
                  />
                </div>
                <DynamicLanguageEditor
                  label={t('admin.agents.edit.synthesizerSystem', 'Synthesizer system prompt')}
                  value={profile.synthesizer?.system || {}}
                  onChange={v => handleSynthesizer({ system: v })}
                  type="textarea"
                  placeholder={{
                    en: 'You are a synthesizer. Produce one cohesive markdown deliverable from the sub-task results. Do not invent facts. Do not call tools — just write the report.',
                    de: 'Du bist ein Synthesizer. Erstelle aus den Teilaufgabenergebnissen ein zusammenhängendes Markdown-Dokument. Erfinde keine Fakten. Rufe keine Tools auf — schreibe den Bericht.'
                  }}
                  name="synthesizer-system"
                />
                <DynamicLanguageEditor
                  label={t('admin.agents.edit.synthesizerPrompt', 'Synthesizer prompt template')}
                  value={profile.synthesizer?.prompt || {}}
                  onChange={v => handleSynthesizer({ prompt: v })}
                  type="textarea"
                  placeholder={{
                    en: '## Brief\n${$.data.brief}\n\n## Item being processed\n${$.data.currentInboxItem}\n\n## Sub-task results\n{{previousTaskResults}}\n\nProduce the final markdown report.',
                    de: '## Auftrag\n${$.data.brief}\n\n## Bearbeitungspunkt\n${$.data.currentInboxItem}\n\n## Teilaufgabenergebnisse\n{{previousTaskResults}}\n\nErstelle den finalen Markdown-Bericht.'
                  }}
                  name="synthesizer-prompt"
                />
                <p className="text-xs text-gray-500 dark:text-gray-400">
                  {t(
                    'admin.agents.edit.synthesizerVariables',
                    'Available variables: ${$.data.brief}, ${$.data.currentInboxItem}, {{previousTaskResults}} — runtime-formatted markdown block of all completed task outputs in order.'
                  )}
                </p>
              </div>
            </Section>

            {/* Plan-and-review loop — opt-in iterative planner */}
            <Section
              title={t('admin.agents.edit.review', 'Plan-and-review loop')}
              hint={t(
                'admin.agents.edit.reviewHint',
                'After the planner finishes a round of tasks, a toolless reviewer judges sufficiency against the brief. If material gaps remain, the loop returns control to the planner with prior task results and reviewer-identified gaps surfaced; the planner emits only new gap-closing tasks (task ids namespaced "r{round}_*"). Bounded by Max rounds. Requires the Planner.'
              )}
            >
              <div className="space-y-4">
                <div>
                  <label className="block text-sm text-gray-600 dark:text-gray-400">
                    {t('admin.agents.edit.reviewStrictness', 'Review strictness')}
                  </label>
                  <p className="text-xs text-gray-500 dark:text-gray-400 mt-0.5">
                    {t(
                      'admin.agents.edit.reviewStrictnessHint',
                      'How strict the adversarial review is and how many rounds it runs. Lenient: accept a partial result fast (2 rounds). Balanced: accept once gaps stop shrinking (4 rounds). Strict: require a full pass (6 rounds).'
                    )}
                  </p>
                  <select
                    value={profile.review?.strictness || 'balanced'}
                    onChange={e => handleReview({ strictness: e.target.value })}
                    className="mt-1 block w-full rounded-lg border-gray-300 shadow-sm focus:border-indigo-500 focus:ring-indigo-500 sm:text-sm dark:bg-gray-700 dark:border-gray-600 dark:text-gray-100"
                  >
                    <option value="lenient">
                      {t('admin.agents.edit.reviewLenient', 'Lenient')}
                    </option>
                    <option value="balanced">
                      {t('admin.agents.edit.reviewBalanced', 'Balanced')}
                    </option>
                    <option value="strict">{t('admin.agents.edit.reviewStrict', 'Strict')}</option>
                  </select>
                </div>

                <label className="flex items-start gap-2">
                  <input
                    type="checkbox"
                    checked={!!profile.review?.enabled}
                    onChange={e => handleReview({ enabled: e.target.checked })}
                    disabled={!profile.planner?.enabled}
                    className="h-4 w-4 mt-0.5 text-indigo-600 border-gray-300 rounded"
                  />
                  <span>
                    <span className="text-sm font-medium text-gray-800 dark:text-gray-200">
                      {t('admin.agents.edit.reviewEnabled', 'Enable plan-and-review loop')}
                    </span>
                    <p className="text-xs text-gray-500 dark:text-gray-400 mt-0.5">
                      {t(
                        'admin.agents.edit.reviewEnabledHint',
                        'Off by default. When on, the planner runs inside a while-loop with a reviewer; the loop terminates when the reviewer reports no material gaps or the Max rounds budget is reached, then the synthesizer runs once over the union of all rounds’ work.'
                      )}
                    </p>
                    {!profile.planner?.enabled && (
                      <p className="text-xs text-amber-600 dark:text-amber-400 mt-1">
                        {t(
                          'admin.agents.edit.reviewRequiresPlanner',
                          'Enable the Planner section above to use the review loop.'
                        )}
                      </p>
                    )}
                  </span>
                </label>

                <div>
                  <label className="block text-sm text-gray-600 dark:text-gray-400">
                    {t('admin.agents.edit.reviewMaxRounds', 'Max rounds (advanced, optional)')}
                  </label>
                  <p className="text-xs text-gray-500 dark:text-gray-400 mt-0.5">
                    {t(
                      'admin.agents.edit.reviewMaxRoundsHint',
                      'Hard cap on planner-reviewer iterations (1–10). Leave blank to use the strictness preset. The first round is the initial plan; subsequent rounds run only if the reviewer flags material gaps. Total tasks across all rounds remain bounded by the shared planner budget (default 100).'
                    )}
                  </p>
                  <input
                    type="number"
                    min="1"
                    max="10"
                    value={profile.review?.maxRounds ?? ''}
                    onChange={e =>
                      handleReview({
                        maxRounds:
                          e.target.value === '' ? undefined : Number(e.target.value) || undefined
                      })
                    }
                    className="mt-1 block w-24 rounded-lg border-gray-300 shadow-sm focus:border-indigo-500 focus:ring-indigo-500 sm:text-sm dark:bg-gray-700 dark:border-gray-600 dark:text-gray-100 disabled:opacity-50"
                  />
                </div>

                <div>
                  <label className="block text-sm text-gray-600 dark:text-gray-400">
                    {t('admin.agents.edit.reviewStallLimit', 'Stall limit (advanced, optional)')}
                  </label>
                  <p className="text-xs text-gray-500 dark:text-gray-400 mt-0.5">
                    {t(
                      'admin.agents.edit.reviewStallLimitHint',
                      'Stop early after this many rounds with no reduction in gaps. Leave blank to use the strictness preset.'
                    )}
                  </p>
                  <input
                    type="number"
                    min="1"
                    max="5"
                    value={profile.review?.stallLimit ?? ''}
                    onChange={e =>
                      handleReview({
                        stallLimit:
                          e.target.value === '' ? undefined : Number(e.target.value) || undefined
                      })
                    }
                    className="mt-1 block w-24 rounded-lg border-gray-300 shadow-sm focus:border-indigo-500 focus:ring-indigo-500 sm:text-sm dark:bg-gray-700 dark:border-gray-600 dark:text-gray-100"
                  />
                </div>
                <div>
                  <label className="block text-sm text-gray-600 dark:text-gray-400">
                    {t(
                      'admin.agents.edit.reviewCriteria',
                      'Acceptance criteria (advanced, optional)'
                    )}
                  </label>
                  <p className="text-xs text-gray-500 dark:text-gray-400 mt-0.5">
                    {t(
                      'admin.agents.edit.reviewCriteriaHint',
                      'Free-text description of what the reviewer should treat as "good enough" for this agent. Overrides the default review criteria.'
                    )}
                  </p>
                  <textarea
                    rows={3}
                    value={profile.review?.criteria || ''}
                    onChange={e => handleReview({ criteria: e.target.value })}
                    className="mt-1 block w-full rounded-lg border-gray-300 shadow-sm focus:border-indigo-500 focus:ring-indigo-500 sm:text-sm dark:bg-gray-700 dark:border-gray-600 dark:text-gray-100"
                  />
                </div>

                <div>
                  <label className="block text-sm text-gray-600 dark:text-gray-400">
                    {t('admin.agents.edit.reviewModel', 'Reviewer model (optional)')}
                  </label>
                  <p className="text-xs text-gray-500 dark:text-gray-400 mt-0.5">
                    {t(
                      'admin.agents.edit.reviewModelHint',
                      'Pin a specific model for the reviewer node. The reviewer is toolless and produces a short structured JSON verdict, so a cheaper/faster model is usually fine. Falls back to Preferred model when unset.'
                    )}
                  </p>
                  <select
                    disabled={!profile.review?.enabled}
                    value={profile.review?.modelId || ''}
                    onChange={e => handleReview({ modelId: e.target.value })}
                    className="mt-1 block w-full rounded-lg border-gray-300 shadow-sm focus:border-indigo-500 focus:ring-indigo-500 sm:text-sm dark:bg-gray-700 dark:border-gray-600 dark:text-gray-100 disabled:opacity-50"
                  >
                    <option value="">
                      {t('admin.agents.edit.reviewModelInherit', '(inherit Preferred model)')}
                    </option>
                    {models
                      .filter(m => !m.supportsImageGeneration)
                      .map(m => (
                        <option key={m.id} value={m.id}>
                          {getLocalizedContent(m.name, currentLanguage) || m.id}
                        </option>
                      ))}
                  </select>
                </div>

                <DynamicLanguageEditor
                  label={t('admin.agents.edit.reviewSystem', 'Reviewer system prompt (optional)')}
                  value={profile.review?.system || {}}
                  onChange={v => handleReview({ system: v })}
                  type="textarea"
                  placeholder={{
                    en: 'You are a strict reviewer. Judge whether the planner gathered enough evidence to comprehensively answer the brief. Return JSON { "needs_more_work": <bool>, "rationale": "...", "gaps": ["..."] }. Set needs_more_work=true ONLY for material gaps. Cap gaps at 5.',
                    de: 'Du bist ein strenger Reviewer. Beurteile, ob der Planner genügend Belege gesammelt hat, um den Auftrag umfassend zu beantworten. Antworte als JSON { "needs_more_work": <bool>, "rationale": "...", "gaps": ["..."] }. Setze needs_more_work nur bei wesentlichen Lücken auf true.'
                  }}
                  name="review-system"
                />
                <p className="text-xs text-gray-500 dark:text-gray-400">
                  {t(
                    'admin.agents.edit.reviewVariables',
                    'The default reviewer prompt template surfaces ${$.data.brief}, the current review round, {{previousTaskResults}}, the citations ledger, and prior reviewer rationale.'
                  )}
                </p>
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
                'Optional. ID of the inbox this agent reads work from. The runtime auto-picks the highest-priority open item at the start of each run and marks it done at the end — no LLM tool calls involved. Create inboxes from Agents → Inboxes.'
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

              {/* Memory composer — explicit LLM step at end of run */}
              <div className="mt-6 pt-6 border-t border-gray-200 dark:border-gray-700 space-y-4">
                <div>
                  <h3 className="text-sm font-medium text-gray-800 dark:text-gray-200">
                    {t('admin.agents.edit.memoryComposer', 'Memory composer (write step)')}
                  </h3>
                  <p className="text-xs text-gray-500 dark:text-gray-400 mt-0.5">
                    {t(
                      'admin.agents.edit.memoryComposerHint',
                      'A toolless LLM step that runs at the end of the workflow, sees the brief, task results, citations, tools/apps used, and the current memory file, and decides what (if anything) is worth committing to long-term memory. Its output goes through the deterministic memory-finalize node which performs the actual file write. Only used when Memory is enabled.'
                    )}
                  </p>
                </div>
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                  <div>
                    <label className="block text-sm text-gray-600 dark:text-gray-400">
                      {t('admin.agents.edit.memoryComposerModel', 'Composer model (optional)')}
                    </label>
                    <select
                      disabled={profile.memory?.enabled === false}
                      value={profile.memory?.modelId || ''}
                      onChange={e => handleMemory({ modelId: e.target.value })}
                      className="mt-1 block w-full rounded-lg border-gray-300 shadow-sm focus:border-indigo-500 focus:ring-indigo-500 sm:text-sm dark:bg-gray-700 dark:border-gray-600 dark:text-gray-100 disabled:opacity-50"
                    >
                      <option value="">
                        {t(
                          'admin.agents.edit.memoryComposerModelInherit',
                          '(inherit Preferred model)'
                        )}
                      </option>
                      {models
                        .filter(m => !m.supportsImageGeneration)
                        .map(m => (
                          <option key={m.id} value={m.id}>
                            {getLocalizedContent(m.name, currentLanguage) || m.id}
                          </option>
                        ))}
                    </select>
                  </div>
                  <div>
                    <label className="block text-sm text-gray-600 dark:text-gray-400">
                      {t(
                        'admin.agents.edit.memoryComposerTemperature',
                        'Composer temperature (default 0.2)'
                      )}
                    </label>
                    <input
                      type="number"
                      min="0"
                      max="2"
                      step="0.1"
                      disabled={profile.memory?.enabled === false}
                      value={profile.memory?.temperature ?? 0.2}
                      onChange={e =>
                        handleMemory({
                          temperature: Number.isFinite(Number(e.target.value))
                            ? Number(e.target.value)
                            : 0.2
                        })
                      }
                      className="mt-1 block w-full rounded-lg border-gray-300 shadow-sm focus:border-indigo-500 focus:ring-indigo-500 sm:text-sm dark:bg-gray-700 dark:border-gray-600 dark:text-gray-100 disabled:opacity-50"
                    />
                  </div>
                </div>
                <DynamicLanguageEditor
                  label={t(
                    'admin.agents.edit.memoryComposerSystem',
                    'Composer system prompt (optional)'
                  )}
                  value={profile.memory?.system || {}}
                  onChange={v => handleMemory({ system: v })}
                  type="textarea"
                  placeholder={{
                    en: 'You are a memory composer. Decide what (if anything) from this run is worth committing to long-term memory. Return JSON { "skip": <bool>, "mode": "append"|"replace", "content": "...", "summary": "..." }. Cite the tool/app/URL that produced each fact. Skip when memory already contains the fact or when nothing durable was learned.',
                    de: 'Du bist ein Memory-Composer. Entscheide, was (wenn überhaupt) aus diesem Lauf in das Langzeitgedächtnis übernommen werden soll. Antworte als JSON { "skip": <bool>, "mode": "append"|"replace", "content": "...", "summary": "..." }. Nenne die Quelle (Tool / App / URL) zu jedem Fakt.'
                  }}
                  name="memory-composer-system"
                />
                <DynamicLanguageEditor
                  label={t(
                    'admin.agents.edit.memoryComposerPrompt',
                    'Composer prompt template (optional)'
                  )}
                  value={profile.memory?.prompt || {}}
                  onChange={v => handleMemory({ prompt: v })}
                  type="textarea"
                  placeholder={{
                    en: '## Original brief\n${$.data.brief}\n\n## Sub-task results\n{{previousTaskResults}}\n\n## Citations\n{{citations}}\n\n## Current memory\n{{currentMemory}}\n\nDecide what to commit and return the JSON.',
                    de: '## Auftrag\n${$.data.brief}\n\n## Teilergebnisse\n{{previousTaskResults}}\n\n## Zitate\n{{citations}}\n\n## Aktuelles Gedächtnis\n{{currentMemory}}\n\nEntscheide und gib das JSON zurück.'
                  }}
                  name="memory-composer-prompt"
                />
              </div>
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
                  <p className="text-xs text-gray-500 dark:text-gray-400 mt-1">
                    {t(
                      'admin.agents.edit.maxWallTimeSecHint',
                      'Caps the whole run AND drives the planner-node timeout (= this value − 5s). If the planner times out before the sub-workflow finishes, partial work survives but the final synthesizer never runs. Defaults to 600s (10 min). Raise to 1800s (30 min) or more for multi-task research runs.'
                    )}
                  </p>
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

      <ConfirmDialog
        isOpen={blocker.state === 'blocked'}
        title="Unsaved Changes"
        message="You have unsaved changes. Leave anyway?"
        confirmLabel="Leave"
        denyLabel="Stay"
        danger={false}
        onConfirm={() => blocker.proceed?.()}
        onDeny={() => blocker.reset?.()}
      />
    </div>
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
