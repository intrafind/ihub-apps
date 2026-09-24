import { useState, useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import Icon from '../../../shared/components/Icon';
import LoadingSpinner from '../../../shared/components/LoadingSpinner';
import { makeAdminApiCall } from '../../../api/adminApi';
import { CredentialRefSelect } from '../components/OpenApiToolEditor';
import McpServerCatalogDialog from '../components/McpServerCatalogDialog';
import { getLocalizedContent } from '../../../utils/localizeContent';

const BLANK_FORM = {
  id: '',
  name: '',
  description: '',
  enabled: true,
  transport: { type: 'streamableHttp', url: '' },
  auth: { type: 'none' },
  toolPrefix: '',
  allowedTools: ['*'],
  timeoutMs: 30000
};

// Shared input styling. The project does not use @tailwindcss/forms, so a bare
// `border-gray-300` sets only the colour and leaves the element with no border
// width — invisible against the white modal background. These classes set an
// explicit border, padding, text colour, and focus ring so inputs are legible
// in both light and dark mode.
const INPUT_CLASS =
  'w-full rounded-md border border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-700 text-gray-900 dark:text-gray-100 shadow-xs px-3 py-2 text-sm focus:border-blue-500 focus:ring-blue-500';
const MONO_INPUT_CLASS = `${INPUT_CLASS} font-mono`;

// Static headers are edited as "Name: value" lines on the transport.
function headersToText(headers) {
  return Object.entries(headers || {})
    .map(([name, value]) => `${name}: ${value}`)
    .join('\n');
}

function textToHeaders(text) {
  const headers = {};
  for (const line of (text || '').split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    const colon = trimmed.indexOf(':');
    const name = (colon === -1 ? trimmed : trimmed.slice(0, colon)).trim();
    headers[name] = colon === -1 ? '' : trimmed.slice(colon + 1).trim();
  }
  return Object.keys(headers).length ? headers : undefined;
}

function isHttpTransport(transport) {
  return transport?.type === 'streamableHttp' || transport?.type === 'sse';
}

function transportToForm(transport) {
  const { headers, ...rest } = transport || {};
  return isHttpTransport(rest) ? { ...rest, headersText: headersToText(headers) } : rest;
}

function transportFromForm(transport) {
  const { headersText, ...rest } = transport;
  const headers = isHttpTransport(rest) ? textToHeaders(headersText) : undefined;
  return headers ? { ...rest, headers } : rest;
}

function transportFields(transport, onChange, t) {
  if (
    transport.type === 'streamableHttp' ||
    transport.type === 'sse' ||
    transport.type === 'websocket'
  ) {
    return (
      <div>
        <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">
          {t('admin.mcp.servers.form.url', 'URL')}
        </label>
        <input
          type="url"
          required
          value={transport.url || ''}
          onChange={e => onChange({ ...transport, url: e.target.value })}
          className={INPUT_CLASS}
          placeholder="https://mcp.example.com/mcp"
        />
        {isHttpTransport(transport) && (
          <div className="mt-3">
            <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">
              {t('admin.mcp.servers.form.headers', 'Additional headers (optional)')}
            </label>
            <textarea
              rows={2}
              value={transport.headersText || ''}
              onChange={e => onChange({ ...transport, headersText: e.target.value })}
              className={MONO_INPUT_CLASS}
              placeholder="X-Scope: read"
            />
            <p className="mt-1 text-xs text-gray-500 dark:text-gray-400">
              {t(
                'admin.mcp.servers.form.headersHint',
                'One "Name: value" per line, sent with every request. Stored in plain text — put keys and tokens under Authentication instead.'
              )}
            </p>
          </div>
        )}
      </div>
    );
  }
  if (transport.type === 'stdio') {
    return (
      <div className="space-y-3">
        <div>
          <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">
            {t('admin.mcp.servers.form.command', 'Command')}
          </label>
          <input
            type="text"
            required
            value={transport.command || ''}
            onChange={e => onChange({ ...transport, command: e.target.value })}
            className={INPUT_CLASS}
            placeholder="/usr/local/bin/my-mcp-server"
          />
        </div>
        <div>
          <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">
            {t('admin.mcp.servers.form.args', 'Args (one per line)')}
          </label>
          <textarea
            rows={3}
            value={(transport.args || []).join('\n')}
            onChange={e =>
              onChange({
                ...transport,
                args: e.target.value
                  .split('\n')
                  .map(s => s.trim())
                  .filter(Boolean)
              })
            }
            className={MONO_INPUT_CLASS}
          />
        </div>
      </div>
    );
  }
  return null;
}

function authFields(auth, onChange, t) {
  return (
    <div className="space-y-3">
      <div>
        <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">
          {t('admin.mcp.servers.form.authType', 'Authentication type')}
        </label>
        <select
          value={auth?.type || 'none'}
          onChange={e => {
            const v = e.target.value;
            if (v === 'none') return onChange({ type: 'none' });
            if (v === 'bearer') return onChange({ type: 'bearer', tokenRef: '' });
            if (v === 'basic') return onChange({ type: 'basic', username: '', passwordRef: '' });
            if (v === 'header') return onChange({ type: 'header', headerName: '', valueRef: '' });
            if (v === 'oauth')
              return onChange({ type: 'oauth', tokenUrl: '', clientId: '', clientSecretRef: '' });
          }}
          className={INPUT_CLASS}
        >
          <option value="none">{t('admin.mcp.servers.form.authNone', 'None')}</option>
          <option value="bearer">{t('admin.mcp.servers.form.authBearer', 'Bearer token')}</option>
          <option value="header">
            {t('admin.mcp.servers.form.authHeader', 'API key in custom header')}
          </option>
          <option value="basic">{t('admin.mcp.servers.form.authBasic', 'Basic')}</option>
          <option value="oauth">
            {t('admin.mcp.servers.form.authOauth', 'OAuth (client credentials)')}
          </option>
        </select>
      </div>
      {auth?.type === 'bearer' && (
        <CredentialRefSelect
          value={auth.tokenRef || ''}
          onChange={id => onChange({ ...auth, tokenRef: id })}
          types={['secret', 'bearer']}
          label={t('admin.mcp.servers.form.token', 'Token')}
          help={t(
            'admin.mcp.servers.form.tokenRefHint',
            'Select a stored credential profile holding the bearer token.'
          )}
        />
      )}
      {auth?.type === 'header' && (
        <>
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">
                {t('admin.mcp.servers.form.headerName', 'Header name')}
              </label>
              <input
                type="text"
                required
                value={auth.headerName || ''}
                onChange={e => onChange({ ...auth, headerName: e.target.value })}
                className={MONO_INPUT_CLASS}
                placeholder="X-Api-Key"
              />
            </div>
            <div>
              <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">
                {t('admin.mcp.servers.form.valuePrefix', 'Value prefix (optional)')}
              </label>
              <input
                type="text"
                value={auth.valuePrefix || ''}
                onChange={e => onChange({ ...auth, valuePrefix: e.target.value || undefined })}
                className={MONO_INPUT_CLASS}
              />
            </div>
          </div>
          <CredentialRefSelect
            value={auth.valueRef || ''}
            onChange={id => onChange({ ...auth, valueRef: id })}
            types={['secret', 'apiKeyHeader', 'bearer']}
            label={t('admin.mcp.servers.form.apiKey', 'API key')}
            help={t(
              'admin.mcp.servers.form.valueRefHint',
              'Select a stored credential profile holding the API key.'
            )}
          />
        </>
      )}
      {auth?.type === 'basic' && (
        <>
          <div>
            <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">
              {t('admin.mcp.servers.form.username', 'Username')}
            </label>
            <input
              type="text"
              value={auth.username || ''}
              onChange={e => onChange({ ...auth, username: e.target.value })}
              className={INPUT_CLASS}
            />
          </div>
          <CredentialRefSelect
            value={auth.passwordRef || ''}
            onChange={id => onChange({ ...auth, passwordRef: id })}
            types={['secret', 'basic']}
            label={t('admin.mcp.servers.form.password', 'Password')}
            help={t(
              'admin.mcp.servers.form.passwordRefHint',
              'Select a stored credential profile holding the password.'
            )}
          />
        </>
      )}
      {auth?.type === 'oauth' && (
        <>
          <div>
            <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">
              {t('admin.mcp.servers.form.tokenUrl', 'Token URL')}
            </label>
            <input
              type="url"
              value={auth.tokenUrl || ''}
              onChange={e => onChange({ ...auth, tokenUrl: e.target.value })}
              className={MONO_INPUT_CLASS}
              placeholder="https://auth.example.com/oauth/token"
            />
          </div>
          <div>
            <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">
              {t('admin.mcp.servers.form.clientId', 'Client ID')}
            </label>
            <input
              type="text"
              value={auth.clientId || ''}
              onChange={e => onChange({ ...auth, clientId: e.target.value })}
              className={MONO_INPUT_CLASS}
            />
          </div>
          <div>
            <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">
              {t('admin.mcp.servers.form.scope', 'Scope (optional)')}
            </label>
            <input
              type="text"
              value={auth.scope || ''}
              onChange={e => onChange({ ...auth, scope: e.target.value })}
              className={INPUT_CLASS}
            />
          </div>
          <CredentialRefSelect
            value={auth.clientSecretRef || ''}
            onChange={id => onChange({ ...auth, clientSecretRef: id })}
            types={['secret', 'oauth2']}
            label={t('admin.mcp.servers.form.clientSecret', 'Client secret')}
            help={t(
              'admin.mcp.servers.form.clientSecretRefHint',
              'Select a stored credential profile holding the OAuth client secret.'
            )}
          />
        </>
      )}
    </div>
  );
}

function StatusBadge({ status, t }) {
  if (!status) {
    return (
      <span className="inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-medium bg-gray-100 dark:bg-gray-700 text-gray-800 dark:text-gray-300">
        {t('admin.mcp.servers.status.unknown', 'unknown')}
      </span>
    );
  }
  if (status.unhealthy) {
    return (
      <span className="inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-medium bg-red-100 dark:bg-red-900/50 text-red-800 dark:text-red-300">
        {t('admin.mcp.servers.status.unhealthy', 'unhealthy')}
      </span>
    );
  }
  if (status.connected) {
    return (
      <span className="inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-medium bg-green-100 dark:bg-green-900/50 text-green-800 dark:text-green-300">
        {t('admin.mcp.servers.status.connected', 'connected ({{count}} tools)', {
          count: status.toolCount ?? '?'
        })}
      </span>
    );
  }
  return (
    <span className="inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-medium bg-yellow-100 dark:bg-yellow-900/50 text-yellow-800 dark:text-yellow-300">
      {t('admin.mcp.servers.status.idle', 'idle')}
    </span>
  );
}

// Auth block for a catalog entry, with the credential reference left for the
// admin to pick.
function catalogAuthTemplate(auth) {
  if (auth?.type === 'bearer') return { type: 'bearer', tokenRef: '' };
  if (auth?.type === 'basic') return { type: 'basic', username: '', passwordRef: '' };
  if (auth?.type === 'header') {
    return {
      type: 'header',
      headerName: auth.headerName,
      ...(auth.valuePrefix ? { valuePrefix: auth.valuePrefix } : {}),
      valueRef: ''
    };
  }
  return { type: 'none' };
}

function AdminMcpServersPage() {
  const { t, i18n } = useTranslation();
  const [loading, setLoading] = useState(true);
  const [servers, setServers] = useState([]);
  const [message, setMessage] = useState(null);
  const [editing, setEditing] = useState(null); // null | server | 'new'
  const [form, setForm] = useState(BLANK_FORM);
  const [draftTesting, setDraftTesting] = useState(false);
  const [draftTest, setDraftTest] = useState(null); // null | { ok, status, tools } | { ok:false, error }
  const [catalogOpen, setCatalogOpen] = useState(false);
  const [catalogEntry, setCatalogEntry] = useState(null); // catalog entry the create form came from

  const load = async () => {
    setLoading(true);
    try {
      const { data } = await makeAdminApiCall('/admin/mcp/servers');
      setServers(data.servers || []);
    } catch (err) {
      setMessage({
        type: 'error',
        text: t('admin.mcp.servers.loadError', 'Failed to load MCP servers: {{error}}', {
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
    setCatalogEntry(null);
    setEditing('new');
  };

  const startFromCatalog = entry => {
    const taken = new Set(servers.map(s => s.id));
    let id = entry.id;
    for (let n = 2; taken.has(id); n++) id = `${entry.id}-${n}`;
    setForm({
      ...BLANK_FORM,
      id,
      name: entry.name,
      // The form stores English text only, so start from the English copy.
      description: getLocalizedContent(entry.description, 'en'),
      transport: transportToForm(entry.transport),
      auth: catalogAuthTemplate(entry.auth),
      toolPrefix: entry.toolPrefix || '',
      timeoutMs: entry.timeoutMs || BLANK_FORM.timeoutMs
    });
    setDraftTest(null);
    setCatalogEntry(entry);
    setCatalogOpen(false);
    setEditing('new');
  };

  const startEdit = server => {
    setForm({
      ...BLANK_FORM,
      ...server,
      transport: transportToForm(server.transport),
      name: typeof server.name === 'string' ? server.name : server.name?.en || server.id,
      description:
        typeof server.description === 'string' ? server.description : server.description?.en || ''
    });
    setDraftTest(null);
    setEditing(server.id);
  };

  const closeDialog = () => {
    setEditing(null);
    setDraftTest(null);
    setCatalogEntry(null);
  };

  // Build the request body shared by save() and the in-dialog test probe.
  const buildBody = () => ({
    ...form,
    transport: transportFromForm(form.transport),
    name: form.name ? { en: form.name } : undefined,
    description: form.description ? { en: form.description } : undefined,
    allowedTools:
      typeof form.allowedTools === 'string'
        ? form.allowedTools
            .split(',')
            .map(s => s.trim())
            .filter(Boolean)
        : form.allowedTools || ['*']
  });

  // Probe the connection for the config currently in the dialog, without
  // persisting it. Lets the admin validate credentials and preview the tool
  // catalog before saving.
  const testDraft = async () => {
    setDraftTesting(true);
    setDraftTest(null);
    try {
      const { data } = await makeAdminApiCall('/admin/mcp/test', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: buildBody()
      });
      setDraftTest({ ok: true, status: data.status, tools: data.tools || [] });
    } catch (err) {
      setDraftTest({
        ok: false,
        error: err.response?.data?.error || err.message
      });
    } finally {
      setDraftTesting(false);
    }
  };

  const save = async () => {
    try {
      const body = buildBody();
      const path =
        editing === 'new'
          ? '/admin/mcp/servers'
          : `/admin/mcp/servers/${encodeURIComponent(editing)}`;
      const method = editing === 'new' ? 'POST' : 'PUT';
      await makeAdminApiCall(path, {
        method,
        headers: { 'Content-Type': 'application/json' },
        body
      });
      setMessage({ type: 'success', text: t('admin.mcp.common.saved', 'Saved') });
      closeDialog();
      await load();
    } catch (err) {
      setMessage({
        type: 'error',
        text: t('admin.mcp.servers.saveError', 'Save failed: {{error}}', {
          error: err.response?.data?.error || err.message
        })
      });
    }
  };

  const remove = async id => {
    if (
      !window.confirm(t('admin.mcp.servers.deleteConfirm', 'Delete MCP server "{{id}}"?', { id }))
    )
      return;
    try {
      await makeAdminApiCall(`/admin/mcp/servers/${encodeURIComponent(id)}`, { method: 'DELETE' });
      setMessage({ type: 'success', text: t('admin.mcp.common.deleted', 'Deleted') });
      await load();
    } catch (err) {
      setMessage({
        type: 'error',
        text: t('admin.mcp.servers.deleteError', 'Delete failed: {{error}}', { error: err.message })
      });
    }
  };

  const test = async id => {
    setMessage({ type: 'info', text: t('admin.mcp.common.testing', 'Testing {{id}}...', { id }) });
    try {
      const { data } = await makeAdminApiCall(`/admin/mcp/servers/${encodeURIComponent(id)}/test`, {
        method: 'POST'
      });
      setMessage({
        type: 'success',
        text: t('admin.mcp.common.testOk', 'OK — {{count}} tools discovered', {
          count: data.status.toolCount ?? 0
        })
      });
      await load();
    } catch (err) {
      setMessage({
        type: 'error',
        text: t('admin.mcp.servers.testError', 'Test failed: {{error}}', {
          error: err.response?.data?.error || err.message
        })
      });
    }
  };

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
            {t('admin.mcp.servers.title', 'MCP servers (outbound)')}
          </h1>
          <p className="text-gray-600 dark:text-gray-400 mt-1">
            {t(
              'admin.mcp.servers.subtitle',
              'External MCP servers iHub connects to. Their tools are merged into the tool catalog with per-server prefixing.'
            )}
          </p>
        </div>
        <div className="flex shrink-0 space-x-2 ml-4">
          <button
            onClick={() => setCatalogOpen(true)}
            className="inline-flex items-center px-4 py-2 border border-gray-300 dark:border-gray-600 text-sm font-medium rounded-md shadow-xs text-gray-700 dark:text-gray-200 bg-white dark:bg-gray-700 hover:bg-gray-50 dark:hover:bg-gray-600"
          >
            <Icon name="cube" size="md" className="mr-2" />
            {t('admin.mcp.catalog.open', 'Browse catalog')}
          </button>
          <button
            onClick={startCreate}
            className="inline-flex items-center px-4 py-2 border border-transparent text-sm font-medium rounded-md shadow-xs text-white bg-blue-600 hover:bg-blue-700"
          >
            <Icon name="plus" size="md" className="mr-2" />
            {t('admin.mcp.servers.create', 'Add MCP server')}
          </button>
        </div>
      </div>

      <div>
        {message && (
          <div
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

        {servers.length === 0 ? (
          <div className="text-center py-12 bg-white dark:bg-gray-800 rounded-lg shadow-sm">
            <Icon name="globe" className="mx-auto h-12 w-12 text-gray-400" />
            <h3 className="mt-2 text-sm font-medium text-gray-900 dark:text-gray-100">
              {t('admin.mcp.servers.empty', 'No MCP servers configured')}
            </h3>
            <p className="mt-1 text-sm text-gray-500 dark:text-gray-400">
              {t(
                'admin.mcp.catalog.emptyHint',
                'Start from the catalog of preconfigured servers, or add your own.'
              )}
            </p>
            <button
              onClick={() => setCatalogOpen(true)}
              className="mt-4 inline-flex items-center px-4 py-2 border border-gray-300 dark:border-gray-600 text-sm font-medium rounded-md shadow-xs text-gray-700 dark:text-gray-200 bg-white dark:bg-gray-700 hover:bg-gray-50 dark:hover:bg-gray-600"
            >
              <Icon name="cube" size="md" className="mr-2" />
              {t('admin.mcp.catalog.open', 'Browse catalog')}
            </button>
          </div>
        ) : (
          <div className="bg-white dark:bg-gray-800 shadow-sm overflow-hidden sm:rounded-md">
            <ul className="divide-y divide-gray-200 dark:divide-gray-700">
              {servers.map(s => (
                <li key={s.id} className="px-4 py-4 sm:px-6">
                  <div className="flex items-center justify-between">
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center space-x-3">
                        <h3 className="text-lg font-medium text-gray-900 dark:text-gray-100 truncate">
                          {typeof s.name === 'string' ? s.name : s.name?.en || s.id}
                        </h3>
                        <StatusBadge status={s.status} t={t} />
                        <span className="inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-medium bg-gray-100 dark:bg-gray-700 text-gray-800 dark:text-gray-300">
                          {s.transport?.type}
                        </span>
                        {!s.enabled && (
                          <span className="inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-medium bg-yellow-100 dark:bg-yellow-900/50 text-yellow-800 dark:text-yellow-300">
                            {t('admin.mcp.servers.status.disabled', 'disabled')}
                          </span>
                        )}
                      </div>
                      <div className="mt-2 text-sm text-gray-500 dark:text-gray-400 font-mono">
                        {s.id}
                      </div>
                      {s.status?.lastError && (
                        <div className="mt-2 text-sm text-red-700 dark:text-red-400">
                          {s.status.lastError}
                        </div>
                      )}
                    </div>
                    <div className="flex space-x-2 ml-4">
                      <button
                        onClick={() => test(s.id)}
                        className="inline-flex items-center px-3 py-2 border border-gray-300 dark:border-gray-600 shadow-xs text-sm leading-4 font-medium rounded-md text-gray-700 dark:text-gray-200 bg-white dark:bg-gray-700 hover:bg-gray-50 dark:hover:bg-gray-600"
                        title={t('admin.mcp.servers.actions.test', 'Test connection')}
                      >
                        <Icon name="play" size="sm" />
                      </button>
                      <button
                        onClick={() => startEdit(s)}
                        className="inline-flex items-center px-3 py-2 border border-gray-300 dark:border-gray-600 shadow-xs text-sm leading-4 font-medium rounded-md text-gray-700 dark:text-gray-200 bg-white dark:bg-gray-700 hover:bg-gray-50 dark:hover:bg-gray-600"
                      >
                        <Icon name="pencil" size="sm" />
                      </button>
                      <button
                        onClick={() => remove(s.id)}
                        className="inline-flex items-center px-3 py-2 border border-red-300 dark:border-red-700 shadow-xs text-sm leading-4 font-medium rounded-md text-red-700 dark:text-red-400 bg-white dark:bg-gray-700 hover:bg-red-50 dark:hover:bg-red-900/50"
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
      </div>

      {catalogOpen && (
        <McpServerCatalogDialog onClose={() => setCatalogOpen(false)} onSelect={startFromCatalog} />
      )}

      {editing !== null && (
        <div className="fixed z-10 inset-0 overflow-y-auto">
          <div className="flex items-center justify-center min-h-screen px-4">
            <div className="fixed inset-0 bg-gray-500/75 dark:bg-gray-900/75" />
            <div className="relative bg-white dark:bg-gray-800 rounded-lg p-6 max-w-2xl w-full shadow-xl space-y-4 max-h-[90vh] overflow-y-auto">
              <h2 className="text-xl font-bold text-gray-900 dark:text-gray-100">
                {editing === 'new'
                  ? t('admin.mcp.servers.createTitle', 'Create MCP server')
                  : t('admin.mcp.servers.editTitle', 'Edit {{id}}', { id: editing })}
              </h2>
              {editing === 'new' && catalogEntry && (
                <div className="rounded-md border border-blue-200 dark:border-blue-800 bg-blue-50 dark:bg-blue-900/30 p-3 text-sm text-blue-800 dark:text-blue-200 space-y-1.5">
                  <div className="flex items-start">
                    <Icon name="information-circle" size="sm" className="mr-1.5 mt-0.5 shrink-0" />
                    <div className="space-y-1.5">
                      <p>
                        {catalogEntry.auth?.type === 'none'
                          ? t(
                              'admin.mcp.catalog.prefilledNoKey',
                              'Pre-filled from the catalog. {{name}} needs no API key — test the connection and save.',
                              { name: catalogEntry.name }
                            )
                          : t(
                              'admin.mcp.catalog.prefilledKey',
                              'Pre-filled from the catalog. Store the {{name}} API key as a credential, select it below, then test and save.',
                              { name: catalogEntry.name }
                            )}
                      </p>
                      {catalogEntry.credentialHint && (
                        <p>{getLocalizedContent(catalogEntry.credentialHint, i18n.language)}</p>
                      )}
                      {catalogEntry.notes && (
                        <p>{getLocalizedContent(catalogEntry.notes, i18n.language)}</p>
                      )}
                      {catalogEntry.docsUrl && (
                        <a
                          href={catalogEntry.docsUrl}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="inline-flex items-center font-medium underline"
                        >
                          {t('admin.mcp.catalog.docs', 'Documentation')}
                          <Icon name="external-link" size="xs" className="ml-1" />
                        </a>
                      )}
                    </div>
                  </div>
                </div>
              )}
              {editing === 'new' && (
                <div>
                  <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">
                    {t('admin.mcp.servers.form.id', 'ID')}
                  </label>
                  <input
                    type="text"
                    required
                    value={form.id}
                    onChange={e => setForm({ ...form, id: e.target.value })}
                    className={INPUT_CLASS}
                    placeholder="github-mcp"
                  />
                </div>
              )}
              <div>
                <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">
                  {t('admin.mcp.servers.form.name', 'Name')}
                </label>
                <input
                  type="text"
                  value={form.name || ''}
                  onChange={e => setForm({ ...form, name: e.target.value })}
                  className={INPUT_CLASS}
                />
              </div>
              <div>
                <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">
                  {t('admin.mcp.servers.form.description', 'Description')}
                </label>
                <textarea
                  rows={2}
                  value={form.description || ''}
                  onChange={e => setForm({ ...form, description: e.target.value })}
                  className={INPUT_CLASS}
                />
              </div>
              <div className="flex items-center space-x-2">
                <input
                  id="enabled"
                  type="checkbox"
                  checked={form.enabled}
                  onChange={e => setForm({ ...form, enabled: e.target.checked })}
                />
                <label htmlFor="enabled" className="text-sm text-gray-700 dark:text-gray-300">
                  {t('admin.mcp.servers.form.enabled', 'Enabled')}
                </label>
              </div>

              <fieldset className="border border-gray-200 dark:border-gray-700 rounded-sm p-3">
                <legend className="text-sm font-medium text-gray-700 dark:text-gray-300 px-1">
                  {t('admin.mcp.servers.form.transport', 'Transport')}
                </legend>
                <div className="space-y-3">
                  <select
                    value={form.transport.type}
                    onChange={e => {
                      const type = e.target.value;
                      const next =
                        type === 'stdio' ? { type, command: '', args: [] } : { type, url: '' };
                      setForm({ ...form, transport: next });
                    }}
                    className={INPUT_CLASS}
                  >
                    <option value="streamableHttp">
                      {t(
                        'admin.mcp.servers.form.transportStreamableHttp',
                        'Streamable HTTP (recommended)'
                      )}
                    </option>
                    <option value="sse">
                      {t('admin.mcp.servers.form.transportSse', 'SSE (legacy)')}
                    </option>
                    <option value="stdio">
                      {t('admin.mcp.servers.form.transportStdio', 'stdio')}
                    </option>
                    <option value="websocket">
                      {t('admin.mcp.servers.form.transportWebsocket', 'WebSocket')}
                    </option>
                  </select>
                  {transportFields(
                    form.transport,
                    next => setForm({ ...form, transport: next }),
                    t
                  )}
                </div>
              </fieldset>

              <fieldset className="border border-gray-200 dark:border-gray-700 rounded-sm p-3">
                <legend className="text-sm font-medium text-gray-700 dark:text-gray-300 px-1">
                  {t('admin.mcp.servers.form.authType', 'Authentication')}
                </legend>
                {authFields(form.auth, a => setForm({ ...form, auth: a }), t)}
              </fieldset>

              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">
                    {t('admin.mcp.servers.form.toolPrefix', 'Tool prefix')}
                  </label>
                  <input
                    type="text"
                    value={form.toolPrefix || ''}
                    onChange={e => setForm({ ...form, toolPrefix: e.target.value })}
                    placeholder={`${form.id || 'server'}__`}
                    className={MONO_INPUT_CLASS}
                  />
                </div>
                <div>
                  <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">
                    {t('admin.mcp.servers.form.timeout', 'Timeout (ms)')}
                  </label>
                  <input
                    type="number"
                    min="1000"
                    max="600000"
                    value={form.timeoutMs}
                    onChange={e => setForm({ ...form, timeoutMs: Number(e.target.value) })}
                    className={INPUT_CLASS}
                  />
                </div>
              </div>

              <div>
                <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">
                  {t(
                    'admin.mcp.servers.form.allowedTools',
                    'Allowed tools (comma-separated, or *)'
                  )}
                </label>
                <input
                  type="text"
                  value={
                    Array.isArray(form.allowedTools)
                      ? form.allowedTools.join(', ')
                      : form.allowedTools || '*'
                  }
                  onChange={e => setForm({ ...form, allowedTools: e.target.value })}
                  className={MONO_INPUT_CLASS}
                />
              </div>

              {(draftTesting || draftTest) && (
                <div className="rounded-md border border-gray-200 dark:border-gray-700 bg-gray-50 dark:bg-gray-900/40 p-3">
                  {draftTesting ? (
                    <div className="flex items-center text-sm text-gray-600 dark:text-gray-300">
                      <LoadingSpinner size="sm" />
                      <span className="ml-2">
                        {t('admin.mcp.servers.test.running', 'Testing connection…')}
                      </span>
                    </div>
                  ) : draftTest?.ok ? (
                    <div>
                      <div className="flex items-center text-sm font-medium text-green-700 dark:text-green-400">
                        <Icon name="check" size="sm" className="mr-1.5" />
                        {t(
                          'admin.mcp.servers.test.success',
                          'Connected — {{count}} tools discovered',
                          { count: draftTest.tools.length }
                        )}
                      </div>
                      {draftTest.tools.length > 0 ? (
                        <ul className="mt-3 max-h-56 overflow-y-auto divide-y divide-gray-200 dark:divide-gray-700 rounded-sm border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800">
                          {draftTest.tools.map(tool => (
                            <li key={tool.name} className="px-3 py-2">
                              <div className="font-mono text-xs text-gray-900 dark:text-gray-100">
                                {tool.name}
                              </div>
                              {tool.description && (
                                <div className="mt-0.5 text-xs text-gray-500 dark:text-gray-400">
                                  {tool.description}
                                </div>
                              )}
                            </li>
                          ))}
                        </ul>
                      ) : (
                        <p className="mt-2 text-xs text-gray-500 dark:text-gray-400">
                          {t(
                            'admin.mcp.servers.test.noTools',
                            'The server connected but exposed no tools (or all were filtered by the allowlist).'
                          )}
                        </p>
                      )}
                    </div>
                  ) : (
                    <div className="flex items-start text-sm text-red-700 dark:text-red-400">
                      <Icon name="x-circle" size="sm" className="mr-1.5 mt-0.5 shrink-0" />
                      <span>
                        {t('admin.mcp.servers.test.failed', 'Connection failed: {{error}}', {
                          error: draftTest?.error || 'unknown error'
                        })}
                      </span>
                    </div>
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
                  {t('admin.mcp.servers.test.button', 'Test connection')}
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

export default AdminMcpServersPage;
