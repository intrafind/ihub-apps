import { useState, useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import Icon from '../../../shared/components/Icon';
import LoadingSpinner from '../../../shared/components/LoadingSpinner';
import { makeAdminApiCall } from '../../../api/adminApi';
import { CredentialRefSelect } from '../components/OpenApiToolEditor';

/**
 * Admin → Integrations → A2A agents: the remote agents iHub calls as a client
 * over the Agent-to-Agent protocol (`contents/config/a2aAgents.json`). Each
 * skill on an agent's Agent Card becomes a tool `a2a__<agentId>__<skill>`.
 *
 * The page lists the agents with their status, and a dialog creates or edits
 * one: Agent Card URL, authentication (credential store references only),
 * allowed skills, timeout, streaming and polling. "Test connection" fetches
 * the card of the unsaved config and shows it with its skills.
 */

const BLANK_FORM = {
  id: '',
  name: '',
  description: '',
  enabled: true,
  cardUrl: '',
  auth: { type: 'none' },
  allowedSkills: ['*'],
  timeoutMs: 60000,
  streaming: 'auto',
  pollIntervalMs: 1500
};

// The project does not use @tailwindcss/forms, so inputs set their border,
// padding, colours and focus ring explicitly (same as the MCP servers page).
const INPUT_CLASS =
  'w-full rounded-md border border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-700 text-gray-900 dark:text-gray-100 shadow-xs px-3 py-2 text-sm focus:border-blue-500 focus:ring-blue-500';
const MONO_INPUT_CLASS = `${INPUT_CLASS} font-mono`;
const LABEL_CLASS = 'block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1';
const BUTTON_CLASS =
  'inline-flex items-center px-3 py-2 border border-gray-300 dark:border-gray-600 shadow-xs text-sm leading-4 font-medium rounded-md text-gray-700 dark:text-gray-200 bg-white dark:bg-gray-700 hover:bg-gray-50 dark:hover:bg-gray-600';

/** A localized-or-plain name as the English text the form edits. */
function plainText(value) {
  if (!value) return '';
  return typeof value === 'string' ? value : value.en || Object.values(value)[0] || '';
}

/**
 * `allowedSkills` as a list: the form holds an array, or the comma-separated
 * text typed while no skill catalog is loaded.
 */
function allowedSkillList(allowedSkills) {
  if (Array.isArray(allowedSkills)) return allowedSkills;
  if (typeof allowedSkills === 'string') {
    return allowedSkills
      .split(',')
      .map(s => s.trim())
      .filter(Boolean);
  }
  return ['*'];
}

/** The fields of one auth type, with credential references picked from the store. */
function AuthFields({ auth, onChange, t }) {
  const type = auth?.type || 'none';
  return (
    <div className="space-y-3">
      <div>
        <label htmlFor="a2a-auth-type" className={LABEL_CLASS}>
          {t('admin.a2a.agents.form.authType', 'Authentication type')}
        </label>
        <select
          id="a2a-auth-type"
          value={type}
          onChange={e => {
            const v = e.target.value;
            if (v === 'none') return onChange({ type: 'none' });
            if (v === 'apiKey') return onChange({ type: 'apiKey', valueRef: '' });
            if (v === 'bearer') return onChange({ type: 'bearer', tokenRef: '' });
            if (v === 'oauth')
              return onChange({ type: 'oauth', tokenUrl: '', clientId: '', clientSecretRef: '' });
          }}
          className={INPUT_CLASS}
        >
          <option value="none">{t('admin.a2a.agents.form.authNone', 'None')}</option>
          <option value="apiKey">
            {t('admin.a2a.agents.form.authApiKey', 'API key in a header')}
          </option>
          <option value="bearer">{t('admin.a2a.agents.form.authBearer', 'Bearer token')}</option>
          <option value="oauth">
            {t('admin.a2a.agents.form.authOauth', 'OAuth (client credentials)')}
          </option>
        </select>
      </div>
      {type === 'apiKey' && (
        <>
          <div>
            <label htmlFor="a2a-header-name" className={LABEL_CLASS}>
              {t('admin.a2a.agents.form.headerName', 'Header name (optional)')}
            </label>
            <input
              id="a2a-header-name"
              type="text"
              value={auth.headerName || ''}
              onChange={e => onChange({ ...auth, headerName: e.target.value || undefined })}
              className={MONO_INPUT_CLASS}
              placeholder="X-API-Key"
            />
            <p className="mt-1 text-xs text-gray-500 dark:text-gray-400">
              {t(
                'admin.a2a.agents.form.headerNameHint',
                "Leave empty to use the header the agent's card names for its API key, or X-API-Key."
              )}
            </p>
          </div>
          <CredentialRefSelect
            value={auth.valueRef || ''}
            onChange={id => onChange({ ...auth, valueRef: id })}
            types={['secret', 'apiKeyHeader', 'bearer']}
            label={t('admin.a2a.agents.form.apiKey', 'API key')}
            help={t(
              'admin.a2a.agents.form.apiKeyHint',
              'Select a stored credential profile holding the API key.'
            )}
          />
        </>
      )}
      {type === 'bearer' && (
        <CredentialRefSelect
          value={auth.tokenRef || ''}
          onChange={id => onChange({ ...auth, tokenRef: id })}
          types={['secret', 'bearer']}
          label={t('admin.a2a.agents.form.token', 'Token')}
          help={t(
            'admin.a2a.agents.form.tokenHint',
            'Select a stored credential profile holding the bearer token.'
          )}
        />
      )}
      {type === 'oauth' && (
        <>
          <div>
            <label htmlFor="a2a-token-url" className={LABEL_CLASS}>
              {t('admin.a2a.agents.form.tokenUrl', 'Token URL')}
            </label>
            <input
              id="a2a-token-url"
              type="url"
              value={auth.tokenUrl || ''}
              onChange={e => onChange({ ...auth, tokenUrl: e.target.value })}
              className={MONO_INPUT_CLASS}
              placeholder="https://auth.example.com/oauth/token"
            />
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label htmlFor="a2a-client-id" className={LABEL_CLASS}>
                {t('admin.a2a.agents.form.clientId', 'Client ID')}
              </label>
              <input
                id="a2a-client-id"
                type="text"
                value={auth.clientId || ''}
                onChange={e => onChange({ ...auth, clientId: e.target.value })}
                className={MONO_INPUT_CLASS}
              />
            </div>
            <div>
              <label htmlFor="a2a-scope" className={LABEL_CLASS}>
                {t('admin.a2a.agents.form.scope', 'Scope (optional)')}
              </label>
              <input
                id="a2a-scope"
                type="text"
                value={auth.scope || ''}
                onChange={e => onChange({ ...auth, scope: e.target.value || undefined })}
                className={INPUT_CLASS}
              />
            </div>
          </div>
          <CredentialRefSelect
            value={auth.clientSecretRef || ''}
            onChange={id => onChange({ ...auth, clientSecretRef: id })}
            types={['secret', 'oauth2']}
            label={t('admin.a2a.agents.form.clientSecret', 'Client secret')}
            help={t(
              'admin.a2a.agents.form.clientSecretHint',
              'Select a stored credential profile holding the OAuth client secret.'
            )}
          />
        </>
      )}
    </div>
  );
}

function StatusBadge({ agent, t }) {
  const base = 'inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-medium';
  const status = agent.status;
  if (agent.enabled === false) {
    return (
      <span
        className={`${base} bg-yellow-100 dark:bg-yellow-900/50 text-yellow-800 dark:text-yellow-300`}
      >
        {t('admin.a2a.agents.status.disabled', 'disabled')}
      </span>
    );
  }
  if (!status) {
    return (
      <span className={`${base} bg-gray-100 dark:bg-gray-700 text-gray-800 dark:text-gray-300`}>
        {t('admin.a2a.agents.status.unknown', 'unknown')}
      </span>
    );
  }
  if (status.unhealthy) {
    return (
      <span className={`${base} bg-red-100 dark:bg-red-900/50 text-red-800 dark:text-red-300`}>
        {t('admin.a2a.agents.status.unhealthy', 'unreachable')}
      </span>
    );
  }
  if (status.connected) {
    return (
      <span
        className={`${base} bg-green-100 dark:bg-green-900/50 text-green-800 dark:text-green-300`}
      >
        {t('admin.a2a.agents.status.connected', 'card loaded ({{count}} skills)', {
          count: status.toolCount ?? '?'
        })}
      </span>
    );
  }
  return (
    <span
      className={`${base} bg-yellow-100 dark:bg-yellow-900/50 text-yellow-800 dark:text-yellow-300`}
    >
      {t('admin.a2a.agents.status.idle', 'not contacted yet')}
    </span>
  );
}

/** The result of "Test connection": the agent's card and every skill it offers. */
function TestResult({ result, allowedSkills, onToggleSkill, t }) {
  if (!result.ok) {
    return (
      <div className="flex items-start text-sm text-red-700 dark:text-red-400">
        <Icon name="x-circle" size="sm" className="mr-1.5 mt-0.5 shrink-0" />
        <span>
          {t('admin.a2a.agents.test.failed', 'Connection failed: {{error}}', {
            error: result.error || 'unknown error'
          })}
        </span>
      </div>
    );
  }
  const { card, skills } = result;
  const allowAll = allowedSkills.includes('*');
  return (
    <div className="space-y-2">
      <div className="flex items-center text-sm font-medium text-green-700 dark:text-green-400">
        <Icon name="check" size="sm" className="mr-1.5" />
        {t('admin.a2a.agents.test.success', 'Agent Card loaded — {{count}} skills', {
          count: skills.length
        })}
      </div>
      <dl className="grid grid-cols-3 gap-x-3 gap-y-1 text-xs text-gray-700 dark:text-gray-300">
        <dt className="font-medium">{t('admin.a2a.agents.test.cardName', 'Agent')}</dt>
        <dd className="col-span-2">{card.name}</dd>
        {card.description && (
          <>
            <dt className="font-medium">
              {t('admin.a2a.agents.test.cardDescription', 'Description')}
            </dt>
            <dd className="col-span-2">{card.description}</dd>
          </>
        )}
        <dt className="font-medium">{t('admin.a2a.agents.test.cardVersion', 'Version')}</dt>
        <dd className="col-span-2">
          {card.version || '—'} · A2A {card.protocolVersion}
        </dd>
        <dt className="font-medium">{t('admin.a2a.agents.test.cardEndpoint', 'Endpoint')}</dt>
        <dd className="col-span-2 font-mono break-all">{card.url}</dd>
        <dt className="font-medium">{t('admin.a2a.agents.test.cardStreaming', 'Streaming')}</dt>
        <dd className="col-span-2">
          {card.streaming
            ? t('admin.a2a.agents.test.yes', 'yes')
            : t('admin.a2a.agents.test.no', 'no')}
        </dd>
      </dl>
      {skills.length === 0 ? (
        <p className="text-xs text-gray-500 dark:text-gray-400">
          {t('admin.a2a.agents.test.noSkills', 'The agent lists no skills on its card.')}
        </p>
      ) : (
        <ul className="max-h-72 overflow-y-auto divide-y divide-gray-200 dark:divide-gray-700 rounded-sm border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800">
          {skills.map(skill => {
            const checkboxId = `a2a-skill-${skill.toolId}`;
            const allowed = allowAll || allowedSkills.includes(skill.id);
            return (
              <li key={skill.toolId} className="flex items-start gap-2 px-3 py-2">
                <input
                  id={checkboxId}
                  type="checkbox"
                  className="mt-0.5"
                  checked={allowed}
                  disabled={allowAll}
                  onChange={() => onToggleSkill(skill.id, allowed)}
                />
                <div className="min-w-0 flex-1">
                  <label
                    htmlFor={checkboxId}
                    className="block text-sm text-gray-900 dark:text-gray-100"
                  >
                    {skill.name}
                  </label>
                  <div className="font-mono text-[11px] text-gray-400 dark:text-gray-500">
                    {skill.toolId}
                  </div>
                  {skill.description && (
                    <p className="mt-0.5 text-xs text-gray-500 dark:text-gray-400 line-clamp-2">
                      {skill.description}
                    </p>
                  )}
                </div>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}

function AdminA2aAgentsPage() {
  const { t } = useTranslation();
  const [loading, setLoading] = useState(true);
  const [agents, setAgents] = useState([]);
  const [message, setMessage] = useState(null);
  const [editing, setEditing] = useState(null); // null | 'new' | agent id
  const [form, setForm] = useState(BLANK_FORM);
  const [draftTesting, setDraftTesting] = useState(false);
  const [draftTest, setDraftTest] = useState(null); // null | { ok, card, skills } | { ok:false, error }

  const errorText = err => err.response?.data?.error || err.message;

  const load = async () => {
    setLoading(true);
    try {
      const { data } = await makeAdminApiCall('/admin/a2a/agents');
      setAgents(data.agents || []);
    } catch (err) {
      setMessage({
        type: 'error',
        text: t('admin.a2a.agents.loadError', 'Failed to load A2A agents: {{error}}', {
          error: err.message
        })
      });
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    load();
    // eslint-disable-next-line @eslint-react/exhaustive-deps
  }, []);

  const startCreate = () => {
    setForm(BLANK_FORM);
    setDraftTest(null);
    setEditing('new');
  };

  const startEdit = agent => {
    const { status: _status, ...config } = agent;
    setForm({
      ...BLANK_FORM,
      ...config,
      name: plainText(agent.name) || agent.id,
      description: plainText(agent.description)
    });
    setDraftTest(null);
    setEditing(agent.id);
  };

  const closeDialog = () => {
    setEditing(null);
    setDraftTest(null);
  };

  // The request body shared by save() and the in-dialog test probe.
  const buildBody = () => ({
    ...form,
    name: form.name ? { en: form.name } : undefined,
    description: form.description ? { en: form.description } : undefined,
    allowedSkills: allowedSkillList(form.allowedSkills)
  });

  const testDraft = async () => {
    setDraftTesting(true);
    setDraftTest(null);
    try {
      const { data } = await makeAdminApiCall('/admin/a2a/test', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: buildBody()
      });
      setDraftTest({ ok: true, card: data.card, skills: data.skills || [] });
    } catch (err) {
      setDraftTest({ ok: false, error: errorText(err) });
    } finally {
      setDraftTesting(false);
    }
  };

  const save = async () => {
    try {
      const isNew = editing === 'new';
      await makeAdminApiCall(
        isNew ? '/admin/a2a/agents' : `/admin/a2a/agents/${encodeURIComponent(editing)}`,
        {
          method: isNew ? 'POST' : 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: buildBody()
        }
      );
      setMessage({ type: 'success', text: t('admin.a2a.common.saved', 'Saved') });
      closeDialog();
      await load();
    } catch (err) {
      setMessage({
        type: 'error',
        text: t('admin.a2a.agents.saveError', 'Save failed: {{error}}', { error: errorText(err) })
      });
    }
  };

  const remove = async id => {
    if (!window.confirm(t('admin.a2a.agents.deleteConfirm', 'Delete A2A agent "{{id}}"?', { id })))
      return;
    try {
      await makeAdminApiCall(`/admin/a2a/agents/${encodeURIComponent(id)}`, { method: 'DELETE' });
      setMessage({ type: 'success', text: t('admin.a2a.common.deleted', 'Deleted') });
      await load();
    } catch (err) {
      setMessage({
        type: 'error',
        text: t('admin.a2a.agents.deleteError', 'Delete failed: {{error}}', {
          error: errorText(err)
        })
      });
    }
  };

  const test = async id => {
    setMessage({ type: 'info', text: t('admin.a2a.common.testing', 'Testing {{id}}...', { id }) });
    try {
      const { data } = await makeAdminApiCall(`/admin/a2a/agents/${encodeURIComponent(id)}/test`, {
        method: 'POST'
      });
      setMessage({
        type: 'success',
        text: t('admin.a2a.common.testOk', 'OK — {{name}} offers {{count}} skills', {
          name: data.card?.name || id,
          count: (data.skills || []).length
        })
      });
      await load();
    } catch (err) {
      setMessage({
        type: 'error',
        text: t('admin.a2a.agents.testError', 'Test failed: {{error}}', { error: errorText(err) })
      });
    }
  };

  const allowedSkills = allowedSkillList(form.allowedSkills);
  const allowAllSkills = allowedSkills.includes('*');
  const skillCatalog = draftTest?.ok ? draftTest.skills : null;

  const toggleSkill = (skillId, allowed) =>
    setForm({
      ...form,
      allowedSkills: allowed
        ? allowedSkills.filter(id => id !== skillId)
        : [...allowedSkills, skillId]
    });

  if (loading) {
    return (
      <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-8">
        <div className="flex items-center justify-center py-16">
          <LoadingSpinner size="lg" />
        </div>
      </div>
    );
  }

  return (
    <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-8">
      <div className="flex justify-between items-start mb-6">
        <div>
          <h1 className="text-3xl font-bold text-gray-900 dark:text-gray-100">
            {t('admin.a2a.agents.title', 'A2A agents (remote)')}
          </h1>
          <p className="text-gray-600 dark:text-gray-400 mt-1">
            {t(
              'admin.a2a.agents.subtitle',
              "Remote agents iHub calls over the Agent-to-Agent (A2A) protocol. Each skill on an agent's card becomes a tool that apps can use."
            )}
          </p>
        </div>
        <button
          onClick={startCreate}
          className="inline-flex shrink-0 ml-4 items-center px-4 py-2 border border-transparent text-sm font-medium rounded-md shadow-xs text-white bg-blue-600 hover:bg-blue-700"
        >
          <Icon name="plus" size="md" className="mr-2" />
          {t('admin.a2a.agents.create', 'Add A2A agent')}
        </button>
      </div>

      {message && (
        <div
          role="status"
          className={`mb-6 p-4 rounded-md border ${
            message.type === 'success'
              ? 'bg-green-50 dark:bg-green-900/30 border-green-200 dark:border-green-800 text-green-700 dark:text-green-300'
              : message.type === 'info'
                ? 'bg-blue-50 dark:bg-blue-900/30 border-blue-200 dark:border-blue-800 text-blue-700 dark:text-blue-300'
                : 'bg-red-50 dark:bg-red-900/30 border-red-200 dark:border-red-800 text-red-700 dark:text-red-300'
          }`}
        >
          {message.text}
        </div>
      )}

      {agents.length === 0 ? (
        <div className="text-center py-12 bg-white dark:bg-gray-800 rounded-lg shadow-sm">
          <Icon name="globe" className="mx-auto h-12 w-12 text-gray-400" />
          <h3 className="mt-2 text-sm font-medium text-gray-900 dark:text-gray-100">
            {t('admin.a2a.agents.empty', 'No A2A agents configured')}
          </h3>
          <p className="mt-1 text-sm text-gray-500 dark:text-gray-400">
            {t(
              'admin.a2a.agents.emptyHint',
              'Add an agent by the URL of its Agent Card, usually <agent>/.well-known/agent-card.json.'
            )}
          </p>
        </div>
      ) : (
        <div className="bg-white dark:bg-gray-800 shadow-sm overflow-hidden sm:rounded-md">
          <ul className="divide-y divide-gray-200 dark:divide-gray-700">
            {agents.map(agent => (
              <li key={agent.id} className="px-4 py-4 sm:px-6">
                <div className="flex items-center justify-between">
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center space-x-3">
                      <h3 className="text-lg font-medium text-gray-900 dark:text-gray-100 truncate">
                        {plainText(agent.name) || agent.id}
                      </h3>
                      <StatusBadge agent={agent} t={t} />
                    </div>
                    <div className="mt-1 text-sm text-gray-500 dark:text-gray-400 font-mono">
                      {agent.id} · {agent.cardUrl}
                    </div>
                    {agent.status?.lastError && (
                      <div className="mt-2 text-sm text-red-700 dark:text-red-400">
                        {agent.status.lastError}
                      </div>
                    )}
                  </div>
                  <div className="flex space-x-2 ml-4">
                    <button
                      onClick={() => test(agent.id)}
                      className={BUTTON_CLASS}
                      title={t('admin.a2a.agents.actions.test', 'Test connection')}
                      aria-label={t('admin.a2a.agents.actions.test', 'Test connection')}
                    >
                      <Icon name="play" size="sm" />
                    </button>
                    <button
                      onClick={() => startEdit(agent)}
                      className={BUTTON_CLASS}
                      title={t('admin.a2a.agents.actions.edit', 'Edit')}
                      aria-label={t('admin.a2a.agents.actions.edit', 'Edit')}
                    >
                      <Icon name="pencil" size="sm" />
                    </button>
                    <button
                      onClick={() => remove(agent.id)}
                      className="inline-flex items-center px-3 py-2 border border-red-300 dark:border-red-700 shadow-xs text-sm leading-4 font-medium rounded-md text-red-700 dark:text-red-400 bg-white dark:bg-gray-700 hover:bg-red-50 dark:hover:bg-red-900/50"
                      title={t('admin.a2a.agents.actions.delete', 'Delete')}
                      aria-label={t('admin.a2a.agents.actions.delete', 'Delete')}
                    >
                      <Icon name="trash" size="sm" />
                    </button>
                  </div>
                </div>
              </li>
            ))}
          </ul>
        </div>
      )}

      {editing !== null && (
        <div className="fixed z-10 inset-0 overflow-y-auto">
          <div className="flex items-center justify-center min-h-screen px-4">
            <div className="fixed inset-0 bg-gray-500/75 dark:bg-gray-900/75" />
            <div
              role="dialog"
              aria-modal="true"
              className="relative bg-white dark:bg-gray-800 rounded-lg p-6 max-w-2xl w-full shadow-xl space-y-4 max-h-[90vh] overflow-y-auto"
            >
              <h2 className="text-xl font-bold text-gray-900 dark:text-gray-100">
                {editing === 'new'
                  ? t('admin.a2a.agents.createTitle', 'Add A2A agent')
                  : t('admin.a2a.agents.editTitle', 'Edit {{id}}', { id: editing })}
              </h2>
              {editing === 'new' && (
                <div>
                  <label htmlFor="a2a-id" className={LABEL_CLASS}>
                    {t('admin.a2a.agents.form.id', 'ID')}
                  </label>
                  <input
                    id="a2a-id"
                    type="text"
                    required
                    value={form.id}
                    onChange={e => setForm({ ...form, id: e.target.value })}
                    className={MONO_INPUT_CLASS}
                    placeholder="langdock"
                  />
                  <p className="mt-1 text-xs text-gray-500 dark:text-gray-400">
                    {t(
                      'admin.a2a.agents.form.idHint',
                      'Tools of this agent are named a2a__<id>__<skill>; apps enable the agent by this id.'
                    )}
                  </p>
                </div>
              )}
              <div>
                <label htmlFor="a2a-name" className={LABEL_CLASS}>
                  {t('admin.a2a.agents.form.name', 'Name')}
                </label>
                <input
                  id="a2a-name"
                  type="text"
                  value={form.name || ''}
                  onChange={e => setForm({ ...form, name: e.target.value })}
                  className={INPUT_CLASS}
                />
              </div>
              <div>
                <label htmlFor="a2a-description" className={LABEL_CLASS}>
                  {t('admin.a2a.agents.form.description', 'Description')}
                </label>
                <textarea
                  id="a2a-description"
                  rows={2}
                  value={form.description || ''}
                  onChange={e => setForm({ ...form, description: e.target.value })}
                  className={INPUT_CLASS}
                />
              </div>
              <div className="flex items-center space-x-2">
                <input
                  id="a2a-enabled"
                  type="checkbox"
                  checked={form.enabled}
                  onChange={e => setForm({ ...form, enabled: e.target.checked })}
                />
                <label htmlFor="a2a-enabled" className="text-sm text-gray-700 dark:text-gray-300">
                  {t('admin.a2a.agents.form.enabled', 'Enabled')}
                </label>
              </div>
              <div>
                <label htmlFor="a2a-card-url" className={LABEL_CLASS}>
                  {t('admin.a2a.agents.form.cardUrl', 'Agent Card URL')}
                </label>
                <input
                  id="a2a-card-url"
                  type="url"
                  required
                  value={form.cardUrl || ''}
                  onChange={e => setForm({ ...form, cardUrl: e.target.value })}
                  className={MONO_INPUT_CLASS}
                  placeholder="https://agent.example.com/.well-known/agent-card.json"
                />
                <p className="mt-1 text-xs text-gray-500 dark:text-gray-400">
                  {t(
                    'admin.a2a.agents.form.cardUrlHint',
                    'HTTPS is required; plain HTTP works for localhost only. Private addresses need an entry in allowedHosts of a2aAgents.json.'
                  )}
                </p>
              </div>

              <fieldset className="border border-gray-200 dark:border-gray-700 rounded-sm p-3">
                <legend className="text-sm font-medium text-gray-700 dark:text-gray-300 px-1">
                  {t('admin.a2a.agents.form.authentication', 'Authentication')}
                </legend>
                <AuthFields auth={form.auth} onChange={a => setForm({ ...form, auth: a })} t={t} />
              </fieldset>

              <div className="grid grid-cols-3 gap-3">
                <div>
                  <label htmlFor="a2a-timeout" className={LABEL_CLASS}>
                    {t('admin.a2a.agents.form.timeout', 'Timeout (ms)')}
                  </label>
                  <input
                    id="a2a-timeout"
                    type="number"
                    min="1000"
                    max="600000"
                    value={form.timeoutMs}
                    onChange={e => setForm({ ...form, timeoutMs: Number(e.target.value) })}
                    className={INPUT_CLASS}
                  />
                </div>
                <div>
                  <label htmlFor="a2a-streaming" className={LABEL_CLASS}>
                    {t('admin.a2a.agents.form.streaming', 'Streaming')}
                  </label>
                  <select
                    id="a2a-streaming"
                    value={form.streaming}
                    onChange={e => setForm({ ...form, streaming: e.target.value })}
                    className={INPUT_CLASS}
                  >
                    <option value="auto">
                      {t('admin.a2a.agents.form.streamingAuto', 'When the agent supports it')}
                    </option>
                    <option value="never">
                      {t('admin.a2a.agents.form.streamingNever', 'Never (poll instead)')}
                    </option>
                  </select>
                </div>
                <div>
                  <label htmlFor="a2a-poll" className={LABEL_CLASS}>
                    {t('admin.a2a.agents.form.pollInterval', 'Poll interval (ms)')}
                  </label>
                  <input
                    id="a2a-poll"
                    type="number"
                    min="250"
                    max="60000"
                    value={form.pollIntervalMs}
                    onChange={e => setForm({ ...form, pollIntervalMs: Number(e.target.value) })}
                    className={INPUT_CLASS}
                  />
                </div>
              </div>
              <p className="-mt-2 text-xs text-gray-500 dark:text-gray-400">
                {t(
                  'admin.a2a.agents.form.timingHint',
                  'The timeout covers the whole call; a task still running then is cancelled. Long-running tasks are polled with tasks/get.'
                )}
              </p>

              <fieldset>
                <legend className={LABEL_CLASS}>
                  {t('admin.a2a.agents.form.allowedSkills', 'Skills offered to apps')}
                </legend>
                <div className="space-y-1">
                  <label className="flex items-center gap-2 text-sm text-gray-700 dark:text-gray-300">
                    <input
                      type="radio"
                      name="allowedSkillsMode"
                      checked={allowAllSkills}
                      onChange={() => setForm({ ...form, allowedSkills: ['*'] })}
                    />
                    {t('admin.a2a.agents.form.allowedSkillsAll', 'All skills on the card')}
                  </label>
                  <label className="flex items-center gap-2 text-sm text-gray-700 dark:text-gray-300">
                    <input
                      type="radio"
                      name="allowedSkillsMode"
                      checked={!allowAllSkills}
                      onChange={() =>
                        setForm({
                          ...form,
                          allowedSkills: skillCatalog ? skillCatalog.map(s => s.id) : []
                        })
                      }
                    />
                    {t('admin.a2a.agents.form.allowedSkillsSelected', 'Only the skills I select')}
                  </label>
                </div>
                {!allowAllSkills && !skillCatalog && (
                  <div className="mt-2">
                    <input
                      type="text"
                      aria-label={t(
                        'admin.a2a.agents.form.allowedSkills',
                        'Skills offered to apps'
                      )}
                      value={
                        Array.isArray(form.allowedSkills)
                          ? form.allowedSkills.join(', ')
                          : form.allowedSkills || ''
                      }
                      onChange={e => setForm({ ...form, allowedSkills: e.target.value })}
                      className={MONO_INPUT_CLASS}
                    />
                    <p className="mt-1 text-xs text-gray-500 dark:text-gray-400">
                      {t(
                        'admin.a2a.agents.form.allowedSkillsManual',
                        'Skill ids as the card names them, comma-separated. Test the connection to pick them from a list instead.'
                      )}
                    </p>
                  </div>
                )}
              </fieldset>

              {(draftTesting || draftTest) && (
                <div className="rounded-md border border-gray-200 dark:border-gray-700 bg-gray-50 dark:bg-gray-900/40 p-3">
                  {draftTesting ? (
                    <div className="flex items-center text-sm text-gray-600 dark:text-gray-300">
                      <LoadingSpinner size="sm" />
                      <span className="ml-2">
                        {t('admin.a2a.agents.test.running', 'Fetching the Agent Card…')}
                      </span>
                    </div>
                  ) : (
                    <TestResult
                      result={draftTest}
                      allowedSkills={allowedSkills}
                      onToggleSkill={toggleSkill}
                      t={t}
                    />
                  )}
                </div>
              )}

              <div className="flex justify-between items-center pt-2">
                <button
                  onClick={testDraft}
                  disabled={draftTesting}
                  className="inline-flex items-center px-4 py-2 border border-gray-300 dark:border-gray-600 rounded-sm text-gray-700 dark:text-gray-200 bg-white dark:bg-gray-700 hover:bg-gray-50 dark:hover:bg-gray-600 disabled:opacity-50"
                >
                  <Icon name="play" size="sm" className="mr-1.5" />
                  {t('admin.a2a.agents.test.button', 'Test connection')}
                </button>
                <div className="flex space-x-2">
                  <button
                    onClick={closeDialog}
                    className="px-4 py-2 border border-gray-300 dark:border-gray-600 rounded-sm text-gray-700 dark:text-gray-200 bg-white dark:bg-gray-700"
                  >
                    {t('common.cancel', 'Cancel')}
                  </button>
                  <button
                    onClick={save}
                    className="px-4 py-2 rounded-sm text-white bg-blue-600 hover:bg-blue-700"
                  >
                    {t('common.save', 'Save')}
                  </button>
                </div>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

export default AdminA2aAgentsPage;
