import { useState, useEffect } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import AdminAuth from '../components/AdminAuth';
import AdminNavigation from '../components/AdminNavigation';
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

function CronPreview({ value }) {
  if (!value) return null;
  return <span className="text-xs text-gray-500">cron: {value}</span>;
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

  function isUnsafeKey(k) {
    return k === '__proto__' || k === 'constructor' || k === 'prototype';
  }

  function update(path, value) {
    setProfile(prev => {
      const next = JSON.parse(JSON.stringify(prev));
      const keys = path.split('.');
      // Refuse any path segment that targets a special key. Explicit ===
      // comparisons keep CodeQL's prototype-pollution analyzer happy.
      for (const k of keys) {
        if (isUnsafeKey(k)) return prev;
      }
      let obj = next;
      for (let i = 0; i < keys.length - 1; i++) {
        const k = keys[i];
        if (isUnsafeKey(k)) return prev;
        if (!Object.prototype.hasOwnProperty.call(obj, k) || obj[k] === null) {
          // Use Object.defineProperty so we never assign onto the prototype
          // chain; combined with the isUnsafeKey guard this is belt+suspenders.
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
      if (isUnsafeKey(leaf)) return prev;
      Object.defineProperty(obj, leaf, {
        value,
        writable: true,
        enumerable: true,
        configurable: true
      });
      return next;
    });
  }

  function updateCron(cron) {
    const next = JSON.parse(JSON.stringify(profile));
    next.workflow = next.workflow || { ref: 'embedded', definition: { nodes: [], edges: [] } };
    next.workflow.definition = next.workflow.definition || { nodes: [], edges: [] };
    next.workflow.definition.triggers = cron
      ? [{ type: 'schedule', config: { cron, timezone: 'UTC' } }]
      : [];
    setProfile(next);
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
        <div className="p-8 text-gray-600">Loading…</div>
      </AdminAuth>
    );
  }

  const cron =
    (profile.workflow?.definition?.triggers || []).find(t => t.type === 'schedule')?.config?.cron ||
    '';

  return (
    <AdminAuth>
      <div className="bg-gray-50 min-h-screen">
        <AdminNavigation />
        <div className="max-w-4xl mx-auto py-8 px-4">
          <div className="flex justify-between items-center mb-6">
            <h1 className="text-2xl font-bold">
              {isNew
                ? t('admin.agents.editNew', 'New Agent Profile')
                : profile.name?.en || profile.id}
            </h1>
            <div className="flex gap-2">
              <button
                onClick={() => setMode(mode === 'form' ? 'json' : 'form')}
                className="px-3 py-2 text-sm border bg-white rounded hover:bg-gray-50"
              >
                {mode === 'form' ? 'JSON' : 'Form'}
              </button>
              <button
                onClick={handleSave}
                disabled={saving}
                className="px-4 py-2 text-sm bg-indigo-600 text-white rounded disabled:opacity-50"
              >
                {saving ? 'Saving…' : 'Save'}
              </button>
              <button
                onClick={() => navigate('/admin/agents')}
                className="px-3 py-2 text-sm border bg-white rounded hover:bg-gray-50"
              >
                Cancel
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
            <div className="bg-white border rounded p-6 space-y-6">
              <section>
                <h2 className="text-lg font-semibold mb-3">Identity</h2>
                <div className="grid grid-cols-2 gap-4">
                  <label className="block">
                    <span className="text-sm text-gray-700">ID</span>
                    <input
                      type="text"
                      disabled={!isNew}
                      value={profile.id}
                      onChange={e => update('id', e.target.value)}
                      className="mt-1 block w-full border-gray-300 rounded shadow-sm text-sm"
                    />
                  </label>
                  <label className="block">
                    <span className="text-sm text-gray-700">Name (en)</span>
                    <input
                      type="text"
                      value={profile.name?.en || ''}
                      onChange={e => update('name.en', e.target.value)}
                      className="mt-1 block w-full border-gray-300 rounded shadow-sm text-sm"
                    />
                  </label>
                  <label className="block col-span-2">
                    <span className="text-sm text-gray-700">Description (en)</span>
                    <textarea
                      value={profile.description?.en || ''}
                      onChange={e => update('description.en', e.target.value)}
                      rows={3}
                      className="mt-1 block w-full border-gray-300 rounded shadow-sm text-sm"
                    />
                  </label>
                  <label className="block">
                    <span className="text-sm text-gray-700">Color</span>
                    <input
                      type="text"
                      value={profile.color}
                      onChange={e => update('color', e.target.value)}
                      className="mt-1 block w-full border-gray-300 rounded shadow-sm text-sm"
                    />
                  </label>
                  <label className="block">
                    <span className="text-sm text-gray-700">Icon</span>
                    <input
                      type="text"
                      value={profile.icon}
                      onChange={e => update('icon', e.target.value)}
                      className="mt-1 block w-full border-gray-300 rounded shadow-sm text-sm"
                    />
                  </label>
                </div>
              </section>

              <section>
                <h2 className="text-lg font-semibold mb-3">Schedule (cron)</h2>
                <input
                  type="text"
                  placeholder="*/15 * * * *"
                  value={cron}
                  onChange={e => updateCron(e.target.value)}
                  className="block w-full border-gray-300 rounded shadow-sm text-sm font-mono"
                />
                <CronPreview value={cron} />
              </section>

              <section>
                <h2 className="text-lg font-semibold mb-3">Inbox</h2>
                <input
                  type="text"
                  placeholder="engineering-todos"
                  value={profile.inboxId || ''}
                  onChange={e => update('inboxId', e.target.value)}
                  className="block w-full border-gray-300 rounded shadow-sm text-sm"
                />
              </section>

              <section>
                <h2 className="text-lg font-semibold mb-3">Capabilities</h2>
                <div className="grid grid-cols-2 gap-4">
                  <label className="block">
                    <span className="text-sm text-gray-700">Planner enabled</span>
                    <input
                      type="checkbox"
                      checked={!!profile.planner?.enabled}
                      onChange={e => update('planner.enabled', e.target.checked)}
                      className="ml-2"
                    />
                  </label>
                  <label className="block">
                    <span className="text-sm text-gray-700">Planner max tasks</span>
                    <input
                      type="number"
                      value={profile.planner?.maxTasks ?? 10}
                      onChange={e => update('planner.maxTasks', Number(e.target.value))}
                      className="mt-1 block w-full border-gray-300 rounded shadow-sm text-sm"
                    />
                  </label>
                  <label className="block">
                    <span className="text-sm text-gray-700">Dynamic tasks enabled</span>
                    <input
                      type="checkbox"
                      checked={!!profile.dynamicTasks?.enabled}
                      onChange={e => update('dynamicTasks.enabled', e.target.checked)}
                      className="ml-2"
                    />
                  </label>
                  <label className="block">
                    <span className="text-sm text-gray-700">Max depth</span>
                    <input
                      type="number"
                      value={profile.dynamicTasks?.maxDepth ?? 3}
                      onChange={e => update('dynamicTasks.maxDepth', Number(e.target.value))}
                      className="mt-1 block w-full border-gray-300 rounded shadow-sm text-sm"
                    />
                  </label>
                </div>
              </section>

              <section>
                <h2 className="text-lg font-semibold mb-3">Memory</h2>
                <div className="grid grid-cols-2 gap-4">
                  <label className="block">
                    <span className="text-sm text-gray-700">Memory enabled</span>
                    <input
                      type="checkbox"
                      checked={profile.memory?.enabled !== false}
                      onChange={e => update('memory.enabled', e.target.checked)}
                      className="ml-2"
                    />
                  </label>
                  <label className="block">
                    <span className="text-sm text-gray-700">Auto-include in prompt</span>
                    <input
                      type="checkbox"
                      checked={profile.memory?.autoInclude !== false}
                      onChange={e => update('memory.autoInclude', e.target.checked)}
                      className="ml-2"
                    />
                  </label>
                  <label className="block">
                    <span className="text-sm text-gray-700">Max bytes</span>
                    <input
                      type="number"
                      value={profile.memory?.maxBytes ?? 8192}
                      onChange={e => update('memory.maxBytes', Number(e.target.value))}
                      className="mt-1 block w-full border-gray-300 rounded shadow-sm text-sm"
                    />
                  </label>
                </div>
                {!isNew && (
                  <button
                    type="button"
                    onClick={() => navigate(`/admin/agents/${profile.id}/memory`)}
                    className="mt-3 text-sm text-indigo-600 hover:underline"
                  >
                    Edit memory file →
                  </button>
                )}
              </section>

              <section>
                <h2 className="text-lg font-semibold mb-3">Budgets & Concurrency</h2>
                <div className="grid grid-cols-2 gap-4">
                  <label className="block">
                    <span className="text-sm text-gray-700">Max wall time (seconds)</span>
                    <input
                      type="number"
                      value={profile.budgets?.maxWallTimeSec ?? 600}
                      onChange={e => update('budgets.maxWallTimeSec', Number(e.target.value))}
                      className="mt-1 block w-full border-gray-300 rounded shadow-sm text-sm"
                    />
                  </label>
                  <label className="block">
                    <span className="text-sm text-gray-700">Max concurrent runs</span>
                    <input
                      type="number"
                      value={profile.concurrency?.maxConcurrent ?? 1}
                      onChange={e => update('concurrency.maxConcurrent', Number(e.target.value))}
                      className="mt-1 block w-full border-gray-300 rounded shadow-sm text-sm"
                    />
                  </label>
                </div>
              </section>

              <section>
                <h2 className="text-lg font-semibold mb-3">HITL approver groups</h2>
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
                  className="block w-full border-gray-300 rounded shadow-sm text-sm"
                />
              </section>
            </div>
          )}
        </div>
      </div>
    </AdminAuth>
  );
}
