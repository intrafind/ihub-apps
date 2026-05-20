import { useState, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import Icon from '../../../shared/components/Icon';
import AdminAuth from '../components/AdminAuth';
import AdminNavigation from '../components/AdminNavigation';
import LoadingSpinner from '../../../shared/components/LoadingSpinner';
import { makeAdminApiCall } from '../../../api/adminApi';

function Toggle({ checked, onChange, label, description }) {
  return (
    <div className="flex items-center justify-between py-3">
      <div className="flex-1 pr-4">
        <div className="text-sm font-medium text-gray-900 dark:text-gray-100">{label}</div>
        {description && (
          <div className="text-xs text-gray-500 dark:text-gray-400 mt-0.5">{description}</div>
        )}
      </div>
      <button
        type="button"
        onClick={() => onChange(!checked)}
        className={`relative inline-flex h-6 w-11 flex-shrink-0 cursor-pointer rounded-full border-2 border-transparent transition-colors duration-200 ease-in-out focus:outline-none focus:ring-2 focus:ring-blue-500 focus:ring-offset-2 ${
          checked ? 'bg-blue-600' : 'bg-gray-200 dark:bg-gray-600'
        }`}
      >
        <span
          className={`pointer-events-none inline-block h-5 w-5 transform rounded-full bg-white shadow ring-0 transition duration-200 ease-in-out ${
            checked ? 'translate-x-5' : 'translate-x-0'
          }`}
        />
      </button>
    </div>
  );
}

function AdminMcpGatewayPage() {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const [loading, setLoading] = useState(true);
  const [platform, setPlatform] = useState(null);
  const [message, setMessage] = useState(null);
  const [saving, setSaving] = useState(false);

  const load = async () => {
    setLoading(true);
    try {
      const { data } = await makeAdminApiCall('/admin/configs/platform');
      setPlatform(data || {});
    } catch (err) {
      setMessage({ type: 'error', text: `Failed to load platform config: ${err.message}` });
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    load();
  }, []);

  const gateway = platform?.mcpServer || {};
  const expose = gateway.expose || {};
  const transports = gateway.transports || {};

  const update = patch => {
    setPlatform(prev => ({
      ...prev,
      mcpServer: {
        ...(prev?.mcpServer || {}),
        ...patch,
        expose: patch.expose
          ? { ...(prev?.mcpServer?.expose || {}), ...patch.expose }
          : prev?.mcpServer?.expose,
        transports: patch.transports
          ? { ...(prev?.mcpServer?.transports || {}), ...patch.transports }
          : prev?.mcpServer?.transports
      }
    }));
  };

  const save = async () => {
    setSaving(true);
    try {
      await makeAdminApiCall('/admin/configs/platform', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(platform)
      });
      setMessage({ type: 'success', text: 'Saved' });
    } catch (err) {
      setMessage({
        type: 'error',
        text: `Save failed: ${err.response?.data?.error || err.message}`
      });
    } finally {
      setSaving(false);
    }
  };

  if (loading) {
    return (
      <AdminAuth>
        <AdminNavigation />
        <div className="min-h-screen bg-gray-50 dark:bg-gray-900 flex items-center justify-center">
          <LoadingSpinner size="lg" />
        </div>
      </AdminAuth>
    );
  }

  return (
    <AdminAuth>
      <AdminNavigation />
      <div className="min-h-screen bg-gray-50 dark:bg-gray-900">
        <div className="bg-white dark:bg-gray-800 shadow-sm border-b border-gray-200 dark:border-gray-700">
          <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-6">
            <button
              onClick={() => navigate('/admin')}
              className="inline-flex items-center text-sm text-gray-500 dark:text-gray-400 hover:text-gray-700 dark:hover:text-gray-200 mb-2"
            >
              <Icon name="chevron-left" size="sm" className="mr-1" />
              {t('admin.nav.home', 'Admin')}
            </button>
            <h1 className="text-3xl font-bold text-gray-900 dark:text-gray-100">
              {t('admin.mcp.gateway.title', 'MCP gateway (inbound)')}
            </h1>
            <p className="text-gray-600 dark:text-gray-400 mt-1">
              {t(
                'admin.mcp.gateway.subtitle',
                'Expose iHub tools, apps, and workflows over the Model Context Protocol so MCP-aware clients (Claude Desktop, Cursor, agents) can use them as tools.'
              )}
            </p>
          </div>
        </div>

        <div className="max-w-3xl mx-auto px-4 sm:px-6 lg:px-8 py-8 space-y-6">
          {message && (
            <div
              className={`p-4 rounded-md border ${
                message.type === 'success'
                  ? 'bg-green-50 dark:bg-green-900/30 border-green-200 dark:border-green-800 text-green-700 dark:text-green-300'
                  : 'bg-red-50 dark:bg-red-900/30 border-red-200 dark:border-red-800 text-red-700 dark:text-red-300'
              }`}
            >
              {message.text}
            </div>
          )}

          <section className="bg-white dark:bg-gray-800 shadow rounded-lg p-6 divide-y divide-gray-200 dark:divide-gray-700">
            <Toggle
              checked={!!gateway.enabled}
              onChange={v => update({ enabled: v })}
              label={t('admin.mcp.gateway.enable', 'Enable MCP gateway')}
              description={t(
                'admin.mcp.gateway.enableDesc',
                'When enabled, /mcp accepts OAuth-authenticated requests from external MCP clients. The endpoint is always 404 when disabled.'
              )}
            />
            <Toggle
              checked={!!gateway.requireConsent}
              onChange={v => update({ requireConsent: v })}
              label={t('admin.mcp.gateway.consent', 'Require user consent')}
              description={t(
                'admin.mcp.gateway.consentDesc',
                'Show the OAuth consent screen on authorization_code flow before issuing an MCP-scoped access token.'
              )}
            />
          </section>

          <section className="bg-white dark:bg-gray-800 shadow rounded-lg p-6 space-y-4">
            <h2 className="text-lg font-medium text-gray-900 dark:text-gray-100">
              {t('admin.mcp.gateway.publicUrl', 'Public URL')}
            </h2>
            <p className="text-sm text-gray-500 dark:text-gray-400">
              {t(
                'admin.mcp.gateway.publicUrlDesc',
                'Announced in .well-known metadata so MCP-aware clients can auto-discover the endpoint. Leave empty to derive it from the request origin.'
              )}
            </p>
            <input
              type="url"
              placeholder="https://ihub.example.com"
              value={gateway.publicUrl || ''}
              onChange={e => update({ publicUrl: e.target.value })}
              className="w-full rounded-md border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-700 text-gray-900 dark:text-gray-100"
            />
          </section>

          <section className="bg-white dark:bg-gray-800 shadow rounded-lg p-6">
            <h2 className="text-lg font-medium text-gray-900 dark:text-gray-100 mb-3">
              {t('admin.mcp.gateway.transports', 'Transports')}
            </h2>
            <div className="divide-y divide-gray-200 dark:divide-gray-700">
              <Toggle
                checked={transports.streamableHttp?.enabled !== false}
                onChange={v =>
                  update({
                    transports: { streamableHttp: { enabled: v } }
                  })
                }
                label="Streamable HTTP (recommended)"
                description="Canonical MCP HTTP transport per spec 2025-03-26+. Supports session resumption via Mcp-Session-Id + Last-Event-ID."
              />
              <Toggle
                checked={transports.sse?.enabled !== false}
                onChange={v =>
                  update({
                    transports: { sse: { enabled: v, deprecated: true } }
                  })
                }
                label="SSE (legacy)"
                description="Older transport kept for back-compat with MCP clients that have not migrated to Streamable HTTP. Replays in-flight requests rather than resuming on reconnect — disable if you care about idempotency."
              />
              <Toggle
                checked={!!gateway.a2a?.enabled}
                onChange={v =>
                  setPlatform(prev => ({
                    ...prev,
                    mcpServer: {
                      ...(prev?.mcpServer || {}),
                      a2a: { ...(prev?.mcpServer?.a2a || {}), enabled: v }
                    }
                  }))
                }
                label="A2A (experimental)"
                description="Mount /a2a alongside /mcp using the same OAuth + mcp:* scope gate. Implements the well-defined subset of the A2A draft (agent/info, agent/skills, tasks/send). Stateful tasks return method-not-found until the spec stabilises."
              />
            </div>
          </section>

          <section className="bg-white dark:bg-gray-800 shadow rounded-lg p-6">
            <h2 className="text-lg font-medium text-gray-900 dark:text-gray-100 mb-3">
              {t('admin.mcp.gateway.expose', 'Exposed resources')}
            </h2>
            <p className="text-sm text-gray-500 dark:text-gray-400 mb-3">
              {t(
                'admin.mcp.gateway.exposeDesc',
                'Resource families surfaced via MCP. Per-OAuth-client allowlists further restrict what an individual caller sees.'
              )}
            </p>
            <div className="divide-y divide-gray-200 dark:divide-gray-700">
              <Toggle
                checked={expose.tools !== false}
                onChange={v => update({ expose: { tools: v } })}
                label="iHub tools"
                description="Requires scope mcp:tools:read + mcp:tools:call"
              />
              <Toggle
                checked={expose.apps !== false}
                onChange={v => update({ expose: { apps: v } })}
                label="iHub apps"
                description="Requires scope mcp:apps:invoke"
              />
              <Toggle
                checked={expose.workflows !== false}
                onChange={v => update({ expose: { workflows: v } })}
                label="Workflows"
                description="Requires scope mcp:workflows:run"
              />
              <Toggle
                checked={!!expose.resources}
                onChange={v => update({ expose: { resources: v } })}
                label="Resources"
                description="Sources / skills surfaced as MCP resources (resources/list + resources/read). Requires scope mcp:resources:read."
              />
            </div>
          </section>

          {gateway.enabled && (
            <section className="bg-blue-50 dark:bg-blue-900/30 border border-blue-200 dark:border-blue-800 rounded-lg p-4">
              <h3 className="text-sm font-medium text-blue-800 dark:text-blue-300 mb-2">
                {t('admin.mcp.gateway.connection', 'Connection examples')}
              </h3>
              <p className="text-xs text-blue-700 dark:text-blue-300 mb-2">
                Endpoint:{' '}
                <code className="font-mono">
                  {(gateway.publicUrl || window.location.origin).replace(/\/$/, '')}/mcp
                </code>
              </p>
              <p className="text-xs text-blue-700 dark:text-blue-300 mb-2">
                Discovery:{' '}
                <code className="font-mono">
                  {(gateway.publicUrl || window.location.origin).replace(/\/$/, '')}/mcp/.well-known
                </code>
              </p>
              <p className="text-xs text-blue-700 dark:text-blue-300">
                Authenticate with an OAuth client (see /admin/oauth/clients) that grants the
                relevant mcp:* scopes.
              </p>
            </section>
          )}

          <div className="flex justify-end">
            <button
              onClick={save}
              disabled={saving}
              className="inline-flex items-center px-4 py-2 rounded-md text-white bg-blue-600 hover:bg-blue-700 disabled:opacity-50"
            >
              {saving ? (
                <>
                  <LoadingSpinner size="sm" className="mr-2" />
                  Saving...
                </>
              ) : (
                t('common.save', 'Save')
              )}
            </button>
          </div>
        </div>
      </div>
    </AdminAuth>
  );
}

export default AdminMcpGatewayPage;
