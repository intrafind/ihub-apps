import { useState, useEffect } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import {
  buildMemoryFromTool,
  fetchAgentMemory,
  fetchMemoryShaperPrompt,
  writeAgentMemory
} from '../../../api/agentsAdminApi';
import { fetchAdminTools } from '../../../api/adminApi';
import AdminBreadcrumb from '../components/AdminBreadcrumb';

export default function AdminAgentMemoryPage() {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const { profileId } = useParams();
  const [body, setBody] = useState('');
  const [version, setVersion] = useState(0);
  const [updatedAt, setUpdatedAt] = useState(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState(null);

  // "Build from tool" form state
  const [tools, setTools] = useState([]);
  const [showBuilder, setShowBuilder] = useState(false);
  const [builderToolId, setBuilderToolId] = useState('');
  const [builderSection, setBuilderSection] = useState('iFinder corpus map');
  const [builderMode, setBuilderMode] = useState('replace-section');
  const [builderParams, setBuilderParams] = useState('{\n  "searchProfile": ""\n}');
  const [building, setBuilding] = useState(false);
  const [builderStatus, setBuilderStatus] = useState(null);
  const [shape, setShape] = useState(true);
  const [shapePrompt, setShapePrompt] = useState('');
  const [showShapePrompt, setShowShapePrompt] = useState(false);

  useEffect(() => {
    (async () => {
      try {
        const res = await fetchAgentMemory(profileId);
        const data = res?.data || {};
        setBody(data.body || '');
        setVersion(data.version || 0);
        setUpdatedAt(data.updatedAt || null);
      } catch (err) {
        setError(err.message);
      } finally {
        setLoading(false);
      }
    })();
  }, [profileId]);

  useEffect(() => {
    (async () => {
      try {
        const list = await fetchAdminTools();
        // The admin tools endpoint returns the raw catalog (parents have a
        // `functions` block). The dispatcher exposes each function as a
        // separate tool id (e.g. `iFinder_discover`), so expand the same way
        // here for the picker.
        const expanded = [];
        for (const tool of list || []) {
          const baseName = typeof tool.name === 'string' ? tool.name : tool.name?.en || tool.id;
          if (tool.functions && typeof tool.functions === 'object') {
            for (const fn of Object.keys(tool.functions)) {
              const fnId = `${tool.id}_${fn}`;
              expanded.push({ id: fnId, label: `${baseName} · ${fn} (${fnId})` });
            }
          } else {
            expanded.push({ id: tool.id, label: `${baseName} (${tool.id})` });
          }
        }
        expanded.sort((a, b) => a.id.localeCompare(b.id));
        setTools(expanded);
      } catch {
        setTools([]);
      }
    })();
  }, []);

  useEffect(() => {
    (async () => {
      try {
        const res = await fetchMemoryShaperPrompt();
        const prompt = res?.data?.prompt;
        if (typeof prompt === 'string' && prompt.length > 0) {
          setShapePrompt(prompt);
        }
      } catch {
        // non-fatal: textarea will start empty and the server falls back
        // to its built-in default if shapePrompt is missing.
      }
    })();
  }, []);

  async function reloadMemory() {
    const res = await fetchAgentMemory(profileId);
    const data = res?.data || {};
    setBody(data.body || '');
    setVersion(data.version || 0);
    setUpdatedAt(data.updatedAt || null);
  }

  async function handleBuild() {
    setBuilderStatus(null);
    if (!builderToolId) {
      setBuilderStatus({
        kind: 'error',
        msg: t('admin.agents.memory.builder.pickTool', 'Pick a tool first.')
      });
      return;
    }
    if (!builderSection.trim()) {
      setBuilderStatus({
        kind: 'error',
        msg: t('admin.agents.memory.builder.sectionRequired', 'Section heading is required.')
      });
      return;
    }
    let params;
    try {
      params = builderParams.trim() ? JSON.parse(builderParams) : {};
    } catch (err) {
      setBuilderStatus({
        kind: 'error',
        msg: t('admin.agents.memory.builder.invalidJson', 'Params must be valid JSON: {{msg}}', {
          msg: err.message
        })
      });
      return;
    }
    setBuilding(true);
    try {
      const res = await buildMemoryFromTool(profileId, {
        toolId: builderToolId,
        params,
        section: builderSection.trim(),
        mode: builderMode,
        shape,
        shapePrompt: shape ? shapePrompt : undefined
      });
      const newVersion = res?.data?.version;
      setBuilderStatus({
        kind: 'success',
        msg: t(
          'admin.agents.memory.builder.success',
          'Wrote section "{{section}}" (memory v{{version}}). The textarea below now shows the latest memory — edit and Save if you want to tweak it further.',
          { section: builderSection.trim(), version: newVersion }
        )
      });
      await reloadMemory();
    } catch (err) {
      setBuilderStatus({
        kind: 'error',
        msg: err?.response?.data?.message || err.message
      });
    } finally {
      setBuilding(false);
    }
  }

  async function handleSave() {
    setSaving(true);
    setError(null);
    try {
      const res = await writeAgentMemory(profileId, {
        content: body,
        expectedVersion: version
      });
      setVersion(res?.data?.version || version + 1);
    } catch (err) {
      const code = err?.response?.data?.error;
      if (code === 'VERSION_CONFLICT') {
        setError(
          t(
            'admin.agents.memory.versionConflict',
            'Conflict: memory was modified elsewhere. Reload to see the latest.'
          )
        );
      } else {
        setError(err.message);
      }
    } finally {
      setSaving(false);
    }
  }

  if (loading) {
    return (
      <div className="p-8 text-gray-600 dark:text-gray-400">{t('common.loading', 'Loading…')}</div>
    );
  }

  return (
    <div className="bg-gray-50 dark:bg-gray-950 min-h-screen">
      <div className="max-w-4xl mx-auto py-8 px-4">
        <AdminBreadcrumb
          crumbs={[
            { label: t('admin.title', 'Admin'), href: '/admin' },
            { label: t('admin.agents.title', 'Agent Profiles'), href: '/admin/agents' },
            { label: profileId, href: `/admin/agents/${profileId}` },
            { label: t('admin.agents.memory.crumb', 'Memory') }
          ]}
        />
        <div className="flex justify-between items-center mb-4">
          <h1 className="text-2xl font-bold text-gray-900 dark:text-gray-100">
            {t('admin.agents.memory.title', 'Memory — {{profileId}}', { profileId })}
          </h1>
          <div className="flex gap-2">
            <button
              onClick={handleSave}
              disabled={saving}
              className="px-4 py-2 bg-indigo-600 hover:bg-indigo-700 text-white rounded disabled:opacity-50"
            >
              {saving ? t('common.saving', 'Saving…') : t('common.save', 'Save')}
            </button>
            <button
              onClick={() => navigate(`/admin/agents/${profileId}`)}
              className="px-4 py-2 border border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-800 text-gray-700 dark:text-gray-300 hover:bg-gray-50 dark:hover:bg-gray-700 rounded"
            >
              {t('admin.agents.memory.backToProfile', 'Back to profile')}
            </button>
          </div>
        </div>
        <div className="text-xs text-gray-500 dark:text-gray-400 mb-2">
          {t('admin.agents.memory.versionLine', 'Version {{version}}{{updatedSuffix}}', {
            version,
            updatedSuffix: updatedAt ? ` · updated ${updatedAt}` : ''
          })}
        </div>
        {error && (
          <div className="mb-3 p-3 bg-red-50 dark:bg-red-900/20 border border-red-200 dark:border-red-800 text-red-800 dark:text-red-300 rounded">
            {error}
          </div>
        )}

        <div className="mb-4 border border-gray-200 dark:border-gray-700 rounded bg-white dark:bg-gray-800">
          <button
            type="button"
            onClick={() => setShowBuilder(s => !s)}
            className="w-full px-3 py-2 text-left text-sm font-medium text-gray-700 dark:text-gray-200 hover:bg-gray-50 dark:hover:bg-gray-700 rounded-t flex justify-between items-center"
          >
            <span>
              {t('admin.agents.memory.builder.title', 'Build memory section from a tool')}
            </span>
            <span className="text-xs text-gray-500">{showBuilder ? '▾' : '▸'}</span>
          </button>
          {showBuilder && (
            <div className="p-3 border-t border-gray-200 dark:border-gray-700 space-y-3 text-sm">
              <p className="text-xs text-gray-500 dark:text-gray-400">
                {t(
                  'admin.agents.memory.builder.help',
                  "Runs any registered tool with admin context and writes its (markdown) output to a named section of this profile's memory. Example: iFinder_discover with searchProfile builds a corpus map."
                )}
              </p>
              <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
                <div>
                  <label className="block text-xs text-gray-600 dark:text-gray-300 mb-1">
                    {t('admin.agents.memory.builder.toolLabel', 'Tool')}
                  </label>
                  <select
                    className="w-full px-2 py-1 border border-gray-300 dark:border-gray-600 rounded bg-white dark:bg-gray-900 text-gray-900 dark:text-gray-100"
                    value={builderToolId}
                    onChange={e => setBuilderToolId(e.target.value)}
                  >
                    <option value="">
                      {t('admin.agents.memory.builder.pickToolPlaceholder', '— pick a tool —')}
                    </option>
                    {tools.map(tool => (
                      <option key={tool.id} value={tool.id}>
                        {tool.label}
                      </option>
                    ))}
                  </select>
                </div>
                <div>
                  <label className="block text-xs text-gray-600 dark:text-gray-300 mb-1">
                    {t('admin.agents.memory.builder.sectionLabel', 'Section heading')}
                  </label>
                  <input
                    type="text"
                    className="w-full px-2 py-1 border border-gray-300 dark:border-gray-600 rounded bg-white dark:bg-gray-900 text-gray-900 dark:text-gray-100"
                    value={builderSection}
                    onChange={e => setBuilderSection(e.target.value)}
                    placeholder="iFinder corpus map"
                  />
                </div>
                <div>
                  <label className="block text-xs text-gray-600 dark:text-gray-300 mb-1">
                    {t('admin.agents.memory.builder.modeLabel', 'Mode')}
                  </label>
                  <select
                    className="w-full px-2 py-1 border border-gray-300 dark:border-gray-600 rounded bg-white dark:bg-gray-900 text-gray-900 dark:text-gray-100"
                    value={builderMode}
                    onChange={e => setBuilderMode(e.target.value)}
                  >
                    <option value="replace-section">
                      {t('admin.agents.memory.builder.modeReplace', 'Replace section')}
                    </option>
                    <option value="append">
                      {t('admin.agents.memory.builder.modeAppend', 'Append')}
                    </option>
                  </select>
                </div>
              </div>
              <div>
                <label className="block text-xs text-gray-600 dark:text-gray-300 mb-1">
                  {t('admin.agents.memory.builder.paramsLabel', 'Tool params (JSON)')}
                </label>
                <textarea
                  className="w-full h-32 font-mono text-xs p-2 border border-gray-300 dark:border-gray-600 rounded bg-white dark:bg-gray-900 text-gray-900 dark:text-gray-100"
                  value={builderParams}
                  onChange={e => setBuilderParams(e.target.value)}
                />
              </div>

              <div className="border-t border-gray-200 dark:border-gray-700 pt-3">
                <label className="flex items-center gap-2 text-xs text-gray-700 dark:text-gray-200">
                  <input
                    type="checkbox"
                    checked={shape}
                    onChange={e => setShape(e.target.checked)}
                  />
                  <span>
                    {t(
                      'admin.agents.memory.builder.shapeLabel',
                      'Format result with LLM before writing (recommended)'
                    )}
                  </span>
                </label>
                <p className="mt-1 text-xs text-gray-500 dark:text-gray-400">
                  {t(
                    'admin.agents.memory.builder.shapeHelp',
                    "When on, the raw tool output is passed through an LLM call using the prompt below. The LLM's reply is written to memory instead of the raw JSON, so the agent sees a compact, filterable index rather than a verbose payload."
                  )}
                </p>
                {shape && (
                  <div className="mt-2">
                    <button
                      type="button"
                      onClick={() => setShowShapePrompt(s => !s)}
                      className="text-xs text-indigo-600 dark:text-indigo-400 hover:underline"
                    >
                      {showShapePrompt
                        ? t('admin.agents.memory.builder.hideShapePrompt', 'Hide shaper prompt')
                        : t('admin.agents.memory.builder.showShapePrompt', 'Edit shaper prompt')}
                    </button>
                    {showShapePrompt && (
                      <textarea
                        className="mt-2 w-full h-48 font-mono text-xs p-2 border border-gray-300 dark:border-gray-600 rounded bg-white dark:bg-gray-900 text-gray-900 dark:text-gray-100"
                        value={shapePrompt}
                        onChange={e => setShapePrompt(e.target.value)}
                        placeholder={t(
                          'admin.agents.memory.builder.shapePromptPlaceholder',
                          'Prompt used to format the tool result. Use {TOOL_RESULT} where the raw output should be inserted.'
                        )}
                      />
                    )}
                  </div>
                )}
              </div>

              <div className="flex justify-end items-center gap-2">
                {builderStatus && (
                  <div
                    className={`flex-1 text-xs ${
                      builderStatus.kind === 'error'
                        ? 'text-red-700 dark:text-red-300'
                        : 'text-green-700 dark:text-green-300'
                    }`}
                  >
                    {builderStatus.msg}
                  </div>
                )}
                <button
                  type="button"
                  onClick={handleBuild}
                  disabled={building}
                  className="px-3 py-1.5 bg-indigo-600 hover:bg-indigo-700 text-white rounded disabled:opacity-50 text-sm"
                >
                  {building
                    ? t('admin.agents.memory.builder.running', 'Running…')
                    : t('admin.agents.memory.builder.run', 'Run and write to memory')}
                </button>
              </div>
            </div>
          )}
        </div>

        <textarea
          className="w-full h-[500px] font-mono text-sm p-3 border border-gray-300 dark:border-gray-600 rounded bg-white dark:bg-gray-800 text-gray-900 dark:text-gray-100"
          value={body}
          onChange={e => setBody(e.target.value)}
        />
      </div>
    </div>
  );
}
