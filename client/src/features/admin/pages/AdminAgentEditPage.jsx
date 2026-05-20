import { useState, useEffect } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import AdminAuth from '../components/AdminAuth';
import AdminNavigation from '../components/AdminNavigation';
import DynamicLanguageEditor from '../../../shared/components/DynamicLanguageEditor';
import IconPicker from '../../../shared/components/IconPicker';
import {
  fetchAgentProfile,
  createAgentProfile,
  updateAgentProfile
} from '../../../api/agentsAdminApi';

const BLANK_PROFILE = {
  id: '',
  name: { en: '' },
  description: { en: '' },
  color: '#6366F1',
  icon: 'robot',
  workflow: { ref: 'embedded', definition: { nodes: [], edges: [] } },
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

function isUnsafeKey(k) {
  return k === '__proto__' || k === 'constructor' || k === 'prototype';
}

export default function AdminAgentEditPage() {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const { profileId } = useParams();
  const isNew = !profileId || profileId === 'new';
  const [profile, setProfile] = useState(BLANK_PROFILE);
  const [loading, setLoading] = useState(!isNew);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState(null);
  const [mode, setMode] = useState('form');

  useEffect(() => {
    if (isNew) return;
    (async () => {
      try {
        const data = await fetchAgentProfile(profileId);
        setProfile(data?.data || BLANK_PROFILE);
      } catch (err) {
        setError(err.message);
      } finally {
        setLoading(false);
      }
    })();
  }, [profileId, isNew]);

  // Generic dot-path update with prototype-pollution guard.
  function update(path, value) {
    setProfile(prev => {
      const next = JSON.parse(JSON.stringify(prev));
      const keys = path.split('.');
      for (const k of keys) if (isUnsafeKey(k)) return prev;
      let obj = next;
      for (let i = 0; i < keys.length - 1; i++) {
        const k = keys[i];
        if (!Object.prototype.hasOwnProperty.call(obj, k) || obj[k] === null) {
          Object.defineProperty(obj, k, {
            value: {},
            writable: true,
            enumerable: true,
            configurable: true
          });
        }
        obj = obj[k];
      }
      const leaf = keys[keys.length - 1];
      Object.defineProperty(obj, leaf, {
        value,
        writable: true,
        enumerable: true,
        configurable: true
      });
      return next;
    });
  }

  // Replace a top-level localized field (name, description) with a new
  // {en: ..., de: ..., ...} map. Matches the handleLocalizedChange pattern
  // in AppFormEditor / PromptFormEditor.
  function handleLocalizedChange(field, value) {
    if (isUnsafeKey(field)) return;
    setProfile(prev => ({ ...prev, [field]: value }));
  }

  function updateCron(cron) {
    setProfile(prev => {
      const next = JSON.parse(JSON.stringify(prev));
      next.workflow = next.workflow || { ref: 'embedded', definition: { nodes: [], edges: [] } };
      next.workflow.definition = next.workflow.definition || { nodes: [], edges: [] };
      next.workflow.definition.triggers = cron
        ? [{ type: 'schedule', config: { cron, timezone: 'UTC' } }]
        : [];
      return next;
    });
  }

  async function handleSave() {
    setError(null);
    setSaving(true);
    try {
      const payload = profile;
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
            <div className="bg-white border rounded p-6 space-y-8 dark:bg-gray-800 dark:border-gray-700">
              {/* Identity */}
              <section>
                <h2 className="text-lg font-semibold mb-3 text-gray-900 dark:text-gray-100">
                  {t('admin.agents.edit.identity', 'Identity')}
                </h2>
                <div className="grid grid-cols-1 sm:grid-cols-6 gap-4">
                  <div className="sm:col-span-3">
                    <label className="block text-sm font-medium text-gray-700 dark:text-gray-300">
                      {t('admin.agents.edit.id', 'ID')}
                      <span className="text-red-500 ml-1">*</span>
                    </label>
                    <input
                      type="text"
                      disabled={!isNew}
                      value={profile.id}
                      onChange={e => update('id', e.target.value)}
                      placeholder="todo-worker"
                      className="mt-1 block w-full rounded-lg border-gray-300 shadow-sm focus:border-indigo-500 focus:ring-indigo-500 sm:text-sm dark:bg-gray-700 dark:border-gray-600 dark:text-gray-100"
                    />
                  </div>

                  <div className="sm:col-span-3">
                    <label className="block text-sm font-medium text-gray-700 dark:text-gray-300">
                      {t('admin.agents.edit.enabled', 'Enabled')}
                    </label>
                    <div className="mt-2">
                      <input
                        type="checkbox"
                        checked={profile.enabled !== false}
                        onChange={e => update('enabled', e.target.checked)}
                        className="h-4 w-4 text-indigo-600 border-gray-300 rounded"
                      />
                    </div>
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
                      onChange={value => handleLocalizedChange('name', value)}
                      required={true}
                      placeholder={{
                        en: 'TODO Worker',
                        de: 'TODO-Worker'
                      }}
                      name="name"
                    />
                  </div>

                  <div className="sm:col-span-6">
                    <DynamicLanguageEditor
                      label={t('admin.agents.edit.description', 'Description')}
                      value={profile.description || {}}
                      onChange={value => handleLocalizedChange('description', value)}
                      type="textarea"
                      placeholder={{
                        en: 'Describe what the agent does, when it runs, and what tools it uses.',
                        de: 'Beschreibe, was der Agent tut, wann er läuft und welche Tools er verwendet.'
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
                        onChange={e => update('color', e.target.value)}
                        className="h-9 w-12 rounded border border-gray-300 cursor-pointer"
                      />
                      <input
                        type="text"
                        value={profile.color || ''}
                        onChange={e => update('color', e.target.value)}
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
                      onChange={value => update('icon', value)}
                      className="mt-1"
                    />
                  </div>
                </div>
              </section>

              {/* Schedule */}
              <section>
                <h2 className="text-lg font-semibold mb-3 text-gray-900 dark:text-gray-100">
                  {t('admin.agents.edit.schedule', 'Schedule (cron)')}
                </h2>
                <input
                  type="text"
                  placeholder="*/15 * * * *"
                  value={cron}
                  onChange={e => updateCron(e.target.value)}
                  className="block w-full rounded-lg border-gray-300 shadow-sm focus:border-indigo-500 focus:ring-indigo-500 sm:text-sm font-mono dark:bg-gray-700 dark:border-gray-600 dark:text-gray-100"
                />
                {cron && (
                  <p className="mt-2 text-xs text-gray-500 dark:text-gray-400">
                    {t(
                      'admin.agents.edit.scheduleHint',
                      'Standard cron syntax. Leave empty to disable.'
                    )}{' '}
                    <span className="font-mono">{cron}</span>
                  </p>
                )}
              </section>

              {/* Inbox */}
              <section>
                <h2 className="text-lg font-semibold mb-3 text-gray-900 dark:text-gray-100">
                  {t('admin.agents.edit.inbox', 'Inbox')}
                </h2>
                <input
                  type="text"
                  placeholder="engineering-todos"
                  value={profile.inboxId || ''}
                  onChange={e => update('inboxId', e.target.value)}
                  className="block w-full rounded-lg border-gray-300 shadow-sm focus:border-indigo-500 focus:ring-indigo-500 sm:text-sm dark:bg-gray-700 dark:border-gray-600 dark:text-gray-100"
                />
                <p className="mt-1 text-xs text-gray-500 dark:text-gray-400">
                  {t(
                    'admin.agents.edit.inboxHint',
                    'Optional. ID of the inbox this agent reads work from. Create inboxes from Agents → Inboxes.'
                  )}
                </p>
              </section>

              {/* Capabilities */}
              <section>
                <h2 className="text-lg font-semibold mb-3 text-gray-900 dark:text-gray-100">
                  {t('admin.agents.edit.capabilities', 'Capabilities')}
                </h2>
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                  <label className="flex items-center gap-2">
                    <input
                      type="checkbox"
                      checked={!!profile.planner?.enabled}
                      onChange={e => update('planner.enabled', e.target.checked)}
                      className="h-4 w-4 text-indigo-600 border-gray-300 rounded"
                    />
                    <span className="text-sm text-gray-700 dark:text-gray-300">
                      {t('admin.agents.edit.plannerEnabled', 'Planner enabled')}
                    </span>
                  </label>
                  <div>
                    <label className="block text-sm font-medium text-gray-700 dark:text-gray-300">
                      {t('admin.agents.edit.plannerMaxTasks', 'Planner max tasks')}
                    </label>
                    <input
                      type="number"
                      min="1"
                      max="50"
                      value={profile.planner?.maxTasks ?? 10}
                      onChange={e => update('planner.maxTasks', Number(e.target.value))}
                      className="mt-1 block w-full rounded-lg border-gray-300 shadow-sm focus:border-indigo-500 focus:ring-indigo-500 sm:text-sm dark:bg-gray-700 dark:border-gray-600 dark:text-gray-100"
                    />
                  </div>
                  <label className="flex items-center gap-2">
                    <input
                      type="checkbox"
                      checked={!!profile.dynamicTasks?.enabled}
                      onChange={e => update('dynamicTasks.enabled', e.target.checked)}
                      className="h-4 w-4 text-indigo-600 border-gray-300 rounded"
                    />
                    <span className="text-sm text-gray-700 dark:text-gray-300">
                      {t('admin.agents.edit.dynamicTasksEnabled', 'Dynamic tasks enabled')}
                    </span>
                  </label>
                  <div>
                    <label className="block text-sm font-medium text-gray-700 dark:text-gray-300">
                      {t('admin.agents.edit.maxDepth', 'Max depth')}
                    </label>
                    <input
                      type="number"
                      min="0"
                      max="10"
                      value={profile.dynamicTasks?.maxDepth ?? 3}
                      onChange={e => update('dynamicTasks.maxDepth', Number(e.target.value))}
                      className="mt-1 block w-full rounded-lg border-gray-300 shadow-sm focus:border-indigo-500 focus:ring-indigo-500 sm:text-sm dark:bg-gray-700 dark:border-gray-600 dark:text-gray-100"
                    />
                  </div>
                </div>
              </section>

              {/* Memory */}
              <section>
                <h2 className="text-lg font-semibold mb-3 text-gray-900 dark:text-gray-100">
                  {t('admin.agents.edit.memory', 'Memory')}
                </h2>
                <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
                  <label className="flex items-center gap-2">
                    <input
                      type="checkbox"
                      checked={profile.memory?.enabled !== false}
                      onChange={e => update('memory.enabled', e.target.checked)}
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
                      onChange={e => update('memory.autoInclude', e.target.checked)}
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
                      onChange={e => update('memory.maxBytes', Number(e.target.value))}
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
              </section>

              {/* Budgets & concurrency */}
              <section>
                <h2 className="text-lg font-semibold mb-3 text-gray-900 dark:text-gray-100">
                  {t('admin.agents.edit.budgets', 'Budgets & concurrency')}
                </h2>
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
                      onChange={e => update('budgets.maxWallTimeSec', Number(e.target.value))}
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
                      onChange={e => update('concurrency.maxConcurrent', Number(e.target.value))}
                      className="mt-1 block w-full rounded-lg border-gray-300 shadow-sm focus:border-indigo-500 focus:ring-indigo-500 sm:text-sm dark:bg-gray-700 dark:border-gray-600 dark:text-gray-100"
                    />
                  </div>
                </div>
              </section>

              {/* HITL */}
              <section>
                <h2 className="text-lg font-semibold mb-3 text-gray-900 dark:text-gray-100">
                  {t('admin.agents.edit.hitl', 'HITL approver groups')}
                </h2>
                <input
                  type="text"
                  placeholder="agent-operators,agent-operators-todo-worker"
                  value={(profile.hitl?.approverGroups || []).join(',')}
                  onChange={e =>
                    update(
                      'hitl.approverGroups',
                      e.target.value
                        .split(',')
                        .map(s => s.trim())
                        .filter(Boolean)
                    )
                  }
                  className="block w-full rounded-lg border-gray-300 shadow-sm focus:border-indigo-500 focus:ring-indigo-500 sm:text-sm dark:bg-gray-700 dark:border-gray-600 dark:text-gray-100"
                />
                <p className="mt-1 text-xs text-gray-500 dark:text-gray-400">
                  {t(
                    'admin.agents.edit.hitlHint',
                    'Comma-separated group IDs. Users in any of these groups can approve human-checkpoint pauses for this profile.'
                  )}
                </p>
              </section>

              {/* Service account groups */}
              <section>
                <h2 className="text-lg font-semibold mb-3 text-gray-900 dark:text-gray-100">
                  {t('admin.agents.edit.serviceAccount', 'Service account groups')}
                </h2>
                <input
                  type="text"
                  placeholder="agents,authenticated"
                  value={(profile.serviceAccount?.groups || []).join(',')}
                  onChange={e =>
                    update(
                      'serviceAccount.groups',
                      e.target.value
                        .split(',')
                        .map(s => s.trim())
                        .filter(Boolean)
                    )
                  }
                  className="block w-full rounded-lg border-gray-300 shadow-sm focus:border-indigo-500 focus:ring-indigo-500 sm:text-sm dark:bg-gray-700 dark:border-gray-600 dark:text-gray-100"
                />
                <p className="mt-1 text-xs text-gray-500 dark:text-gray-400">
                  {t(
                    'admin.agents.edit.serviceAccountHint',
                    'Groups the agent principal (agent:<id>) belongs to. These determine which apps/tools/models the agent can access.'
                  )}
                </p>
              </section>
            </div>
          )}
        </div>
      </div>
    </AdminAuth>
  );
}
