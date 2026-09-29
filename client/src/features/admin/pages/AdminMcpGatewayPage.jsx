import { useState, useEffect } from 'react';
import { useTranslation } from 'react-i18next';
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
        role="switch"
        aria-checked={checked}
        aria-label={typeof label === 'string' ? label : undefined}
        onClick={() => onChange(!checked)}
        className={`relative inline-flex h-6 w-11 shrink-0 cursor-pointer rounded-full border-2 border-transparent transition-colors duration-200 ease-in-out focus:outline-hidden focus:ring-2 focus:ring-blue-500 focus:ring-offset-2 ${
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
      setMessage({
        type: 'error',
        text: t('admin.mcp.gateway.loadError', 'Failed to load platform config: {{error}}', {
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

  const gateway = platform?.mcpServer || {};
  const expose = gateway.expose || {};
  const transports = gateway.transports || {};
  const oauth = platform?.oauth || {};
  const oauthAuthzEnabled = !!oauth.enabled?.authz;
  const dcrEnabled = !!oauth.dcr?.enabled;
  const cimdEnabled = !!oauth.cimd?.enabled;
  const cimdHosts = Array.isArray(oauth.cimd?.allowedClientHosts)
    ? oauth.cimd.allowedClientHosts
    : [];
  const cimdBlockedHosts = Array.isArray(oauth.cimd?.blockedClientHosts)
    ? oauth.cimd.blockedClientHosts
    : [];
  const cimdApprovalMode = oauth.cimd?.approvalMode === 'auto' ? 'auto' : 'approval';

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

  const setOauthAuthz = enabled => {
    setPlatform(prev => {
      const prevOauth = prev?.oauth || {};
      return {
        ...prev,
        oauth: {
          ...prevOauth,
          enabled: {
            ...(prevOauth.enabled || {}),
            authz: enabled,
            // Enabling the authorization server for MCP also needs the client
            // store and the authorization_code + refresh_token grants.
            ...(enabled ? { clients: true } : {})
          },
          ...(enabled ? { authorizationCodeEnabled: true, refreshTokenEnabled: true } : {})
        }
      };
    });
  };

  const setDcr = enabled => {
    setPlatform(prev => {
      const prevOauth = prev?.oauth || {};
      return {
        ...prev,
        oauth: {
          ...prevOauth,
          dcr: { ...(prevOauth.dcr || {}), enabled }
        }
      };
    });
  };

  const setCimd = patch => {
    setPlatform(prev => {
      const prevOauth = prev?.oauth || {};
      return {
        ...prev,
        oauth: {
          ...prevOauth,
          cimd: { ...(prevOauth.cimd || {}), ...patch }
        }
      };
    });
  };

  const save = async () => {
    setSaving(true);
    try {
      await makeAdminApiCall('/admin/configs/platform', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: platform
      });
      setMessage({ type: 'success', text: t('admin.mcp.common.saved', 'Saved') });
    } catch (err) {
      setMessage({
        type: 'error',
        text: t('admin.mcp.gateway.saveError', 'Save failed: {{error}}', {
          error: err.response?.data?.error || err.message
        })
      });
    } finally {
      setSaving(false);
    }
  };

  if (loading) {
    return (
      <div className="max-w-3xl mx-auto px-4 sm:px-6 lg:px-8 py-8">
        <div className="flex items-center justify-center py-16">
          <LoadingSpinner size="lg" />
        </div>
      </div>
    );
  }

  return (
    <div className="max-w-3xl mx-auto px-4 sm:px-6 lg:px-8 py-8">
      <div className="mb-6">
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

      <div className="space-y-6">
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

        <section className="bg-white dark:bg-gray-800 shadow-sm rounded-lg p-6 divide-y divide-gray-200 dark:divide-gray-700">
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

        <section className="bg-white dark:bg-gray-800 shadow-sm rounded-lg p-6">
          <h2 className="text-lg font-medium text-gray-900 dark:text-gray-100 mb-1">
            {t('admin.mcp.gateway.authSection', 'Authentication')}
          </h2>
          <p className="text-sm text-gray-500 dark:text-gray-400 mb-3">
            {t(
              'admin.mcp.gateway.authSectionDesc',
              'The MCP gateway only accepts OAuth bearer tokens issued by the built-in authorization server. It must be enabled for any MCP client to connect.'
            )}
          </p>
          {gateway.enabled && !oauthAuthzEnabled && (
            <div className="mb-3 p-3 rounded-md border bg-amber-50 dark:bg-amber-900/30 border-amber-200 dark:border-amber-800 text-amber-800 dark:text-amber-300 text-sm">
              {t(
                'admin.mcp.gateway.oauthWarning',
                'The gateway is enabled but the OAuth authorization server is off — MCP clients cannot obtain a token. Enable it below.'
              )}
            </div>
          )}
          <div className="divide-y divide-gray-200 dark:divide-gray-700">
            <Toggle
              checked={oauthAuthzEnabled}
              onChange={setOauthAuthz}
              label={t('admin.mcp.gateway.oauthToggle', 'OAuth authorization server')}
              description={t(
                'admin.mcp.gateway.oauthToggleDesc',
                'Serves /api/oauth/authorize and /api/oauth/token. Enabling this also switches on OAuth client management and the authorization_code + refresh_token grants. A server restart is required after enabling it for the first time.'
              )}
            />
          </div>
        </section>

        <section className="bg-white dark:bg-gray-800 shadow-sm rounded-lg p-6">
          <h2 className="text-lg font-medium text-gray-900 dark:text-gray-100 mb-1">
            {t('admin.mcp.gateway.clientIdSection', 'Client identification')}
          </h2>
          <p className="text-sm text-gray-500 dark:text-gray-400 mb-3">
            {t(
              'admin.mcp.gateway.clientIdSectionDesc',
              'How an MCP client tells iHub who it is. A client picks the first option it can use, so leaving both on gives clients that support metadata documents the stable identity and everything else the legacy path.'
            )}
          </p>
          <div className="divide-y divide-gray-200 dark:divide-gray-700">
            <Toggle
              checked={cimdEnabled}
              onChange={enabled => setCimd({ enabled })}
              label={t(
                'admin.mcp.gateway.cimdToggle',
                'Client ID Metadata Documents (recommended)'
              )}
              description={t(
                'admin.mcp.gateway.cimdToggleDesc',
                "The client's ID is an HTTPS URL pointing at a metadata document it publishes, so nothing is stored here — one stable identity for every user instead of a new client record per connection. Only the trusted hosts below are accepted, and users always sign in and consent."
              )}
            />
            {cimdEnabled && (
              <div className="py-3">
                <label
                  htmlFor="cimd-hosts"
                  className="block text-sm font-medium text-gray-900 dark:text-gray-100"
                >
                  {t('admin.mcp.gateway.cimdHosts', 'Trusted client hosts')}
                </label>
                <p className="text-xs text-gray-500 dark:text-gray-400 mt-0.5 mb-2">
                  {t(
                    'admin.mcp.gateway.cimdHostsDesc',
                    'Comma-separated hostnames whose metadata documents are accepted. Supports *.example.com for subdomains. An empty list accepts nobody; "*" accepts any HTTPS client and is not recommended.'
                  )}
                </p>
                <input
                  id="cimd-hosts"
                  type="text"
                  placeholder="claude.ai"
                  value={cimdHosts.join(', ')}
                  onChange={e =>
                    setCimd({
                      allowedClientHosts: e.target.value
                        .split(',')
                        .map(host => host.trim())
                        .filter(Boolean)
                    })
                  }
                  className="w-full rounded-md border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-700 text-gray-900 dark:text-gray-100"
                />
              </div>
            )}
            {cimdEnabled && (
              <div className="py-3">
                <label
                  htmlFor="cimd-blocked-hosts"
                  className="block text-sm font-medium text-gray-900 dark:text-gray-100"
                >
                  {t('admin.mcp.gateway.cimdBlockedHosts', 'Blocked client hosts')}
                </label>
                <p className="text-xs text-gray-500 dark:text-gray-400 mt-0.5 mb-2">
                  {t(
                    'admin.mcp.gateway.cimdBlockedHostsDesc',
                    'Comma-separated hostnames that are refused even while they are trusted above, checked before any request leaves this server. Use it to cut off a vendor without editing the trusted list you want to keep. Blocking an individual client is done per client under OAuth → Clients.'
                  )}
                </p>
                <input
                  id="cimd-blocked-hosts"
                  type="text"
                  placeholder="example.com"
                  value={cimdBlockedHosts.join(', ')}
                  onChange={e =>
                    setCimd({
                      blockedClientHosts: e.target.value
                        .split(',')
                        .map(host => host.trim())
                        .filter(Boolean)
                    })
                  }
                  className="w-full rounded-md border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-700 text-gray-900 dark:text-gray-100"
                />
              </div>
            )}
            {cimdEnabled && (
              <div className="py-3">
                <label
                  htmlFor="cimd-approval-mode"
                  className="block text-sm font-medium text-gray-900 dark:text-gray-100"
                >
                  {t('admin.mcp.gateway.cimdApprovalMode', 'New clients')}
                </label>
                <p className="text-xs text-gray-500 dark:text-gray-400 mt-0.5 mb-2">
                  {t(
                    'admin.mcp.gateway.cimdApprovalModeDesc',
                    'A trusted host publishes several different clients — Claude web, Claude Desktop, Claude Code — under one hostname. Requiring approval means each one waits for you: the user is told to ask an administrator, and the client appears here as pending. Clients people are already connected through are unaffected.'
                  )}
                </p>
                <select
                  id="cimd-approval-mode"
                  value={cimdApprovalMode}
                  onChange={e => setCimd({ approvalMode: e.target.value })}
                  className="w-full rounded-md border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-700 text-gray-900 dark:text-gray-100"
                >
                  <option value="approval">
                    {t('admin.mcp.gateway.cimdApprovalRequired', 'Require approval (recommended)')}
                  </option>
                  <option value="auto">
                    {t('admin.mcp.gateway.cimdApprovalAuto', 'Connect automatically')}
                  </option>
                </select>
              </div>
            )}
            <Toggle
              checked={dcrEnabled}
              onChange={setDcr}
              label={t(
                'admin.mcp.gateway.dcrToggle',
                'Dynamic client registration (legacy fallback)'
              )}
              description={t(
                'admin.mcp.gateway.dcrToggleDesc',
                'Lets MCP clients register their OAuth client at /api/oauth/register (RFC 7591). Identical public registrations are de-duplicated onto one record, and registered clients always go through user sign-in and consent with identity + mcp:* scopes only.'
              )}
            />
          </div>
        </section>

        <section className="bg-white dark:bg-gray-800 shadow-sm rounded-lg p-6 space-y-4">
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

        <section className="bg-white dark:bg-gray-800 shadow-sm rounded-lg p-6">
          <h2 className="text-lg font-medium text-gray-900 dark:text-gray-100 mb-3">
            {t('admin.mcp.gateway.transports', 'Transports')}
          </h2>
          <div className="divide-y divide-gray-200 dark:divide-gray-700">
            <Toggle
              checked={transports.streamableHttp?.enabled !== false}
              onChange={v =>
                update({
                  transports: {
                    streamableHttp: { ...(transports.streamableHttp || {}), enabled: v }
                  }
                })
              }
              label={t(
                'admin.mcp.gateway.transportStreamableHttp',
                'Streamable HTTP (recommended)'
              )}
              description={t(
                'admin.mcp.gateway.transportStreamableHttpDesc',
                'Canonical MCP HTTP transport per spec 2025-03-26+. Supports session resumption via Mcp-Session-Id + Last-Event-ID.'
              )}
            />
            <Toggle
              checked={transports.streamableHttp?.stateless === true}
              onChange={v =>
                update({
                  transports: {
                    streamableHttp: { ...(transports.streamableHttp || {}), stateless: v }
                  }
                })
              }
              label={t('admin.mcp.gateway.transportStateless', 'Stateless mode')}
              description={t(
                'admin.mcp.gateway.transportStatelessDesc',
                'Handle every Streamable HTTP request independently instead of keeping MCP sessions in memory. Enable when iHub runs behind a load balancer that spreads requests across several pods, where a session opened on one pod is unknown to the next. Trade-off: no server-initiated SSE stream.'
              )}
            />
            <Toggle
              checked={transports.sse?.enabled !== false}
              onChange={v =>
                update({
                  transports: { sse: { enabled: v, deprecated: true } }
                })
              }
              label={t('admin.mcp.gateway.transportSse', 'SSE (legacy)')}
              description={t(
                'admin.mcp.gateway.transportSseDesc',
                'Older transport kept for back-compat with MCP clients that have not migrated to Streamable HTTP. Replays in-flight requests rather than resuming on reconnect — disable if you care about idempotency.'
              )}
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
              label={t('admin.mcp.gateway.transportA2a', 'A2A (Agent-to-Agent) 0.3')}
              description={t(
                'admin.mcp.gateway.transportA2aDesc',
                "Serve an Agent Card at /.well-known/agent-card.json and mount /a2a alongside /mcp, behind the same OAuth + mcp:* scope gate (personal API keys work too). Apps and workflows become the agent's skills; supports message/send, message/stream, tasks/get and tasks/cancel."
              )}
            />
            {gateway.a2a?.enabled && (
              <div className="py-3">
                <label
                  htmlFor="a2a-default-skill"
                  className="block text-sm font-medium text-gray-900 dark:text-gray-100"
                >
                  {t('admin.mcp.gateway.a2aDefaultSkill', 'A2A default skill')}
                </label>
                <p className="text-xs text-gray-500 dark:text-gray-400 mt-0.5 mb-2">
                  {t(
                    'admin.mcp.gateway.a2aDefaultSkillDesc',
                    'The app or workflow a message runs when the A2A client names none, as app__<appId> or workflow__<workflowId>. Clients can always choose a skill with metadata.skillId or by using the per-skill endpoint /a2a/skills/<skillId>. Leave empty to require a choice (a caller with exactly one skill needs none).'
                  )}
                </p>
                <input
                  id="a2a-default-skill"
                  type="text"
                  placeholder="app__chat"
                  value={gateway.a2a?.defaultSkill || ''}
                  onChange={e =>
                    setPlatform(prev => ({
                      ...prev,
                      mcpServer: {
                        ...(prev?.mcpServer || {}),
                        a2a: { ...(prev?.mcpServer?.a2a || {}), defaultSkill: e.target.value }
                      }
                    }))
                  }
                  className="w-full rounded-md border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-700 text-gray-900 dark:text-gray-100"
                />
              </div>
            )}
          </div>
        </section>

        <section className="bg-white dark:bg-gray-800 shadow-sm rounded-lg p-6">
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
              label={t('admin.mcp.gateway.exposeTools', 'iHub tools')}
              description={t(
                'admin.mcp.gateway.exposeToolsDesc',
                'Requires scope mcp:tools:read + mcp:tools:call'
              )}
            />
            <Toggle
              checked={expose.apps !== false}
              onChange={v => update({ expose: { apps: v } })}
              label={t('admin.mcp.gateway.exposeApps', 'iHub apps')}
              description={t('admin.mcp.gateway.exposeAppsDesc', 'Requires scope mcp:apps:invoke')}
            />
            <Toggle
              checked={expose.workflows !== false}
              onChange={v => update({ expose: { workflows: v } })}
              label={t('admin.mcp.gateway.exposeWorkflows', 'Workflows')}
              description={t(
                'admin.mcp.gateway.exposeWorkflowsDesc',
                'Requires scope mcp:workflows:run'
              )}
            />
            <Toggle
              checked={!!expose.resources}
              onChange={v => update({ expose: { resources: v } })}
              label={t('admin.mcp.gateway.exposeResources', 'Resources')}
              description={t(
                'admin.mcp.gateway.exposeResourcesDesc',
                'Sources / skills surfaced as MCP resources (resources/list + resources/read). Requires scope mcp:resources:read.'
              )}
            />
          </div>
        </section>

        {gateway.enabled && (
          <section className="bg-blue-50 dark:bg-blue-900/30 border border-blue-200 dark:border-blue-800 rounded-lg p-4">
            <h3 className="text-sm font-medium text-blue-800 dark:text-blue-300 mb-2">
              {t('admin.mcp.gateway.connection', 'Connection examples')}
            </h3>
            <p className="text-xs text-blue-700 dark:text-blue-300 mb-2">
              {t('admin.mcp.gateway.endpointLabel', 'Endpoint:')}{' '}
              <code className="font-mono">
                {(gateway.publicUrl || window.location.origin).replace(/\/$/, '')}/mcp
              </code>
            </p>
            <p className="text-xs text-blue-700 dark:text-blue-300 mb-2">
              {t('admin.mcp.gateway.discoveryLabel', 'Discovery:')}{' '}
              <code className="font-mono">
                {(gateway.publicUrl || window.location.origin).replace(/\/$/, '')}/mcp/.well-known
              </code>
            </p>
            <p className="text-xs text-blue-700 dark:text-blue-300 mb-2">
              {t(
                'admin.mcp.gateway.connectionHint',
                'Authenticate with an OAuth client (see /admin/oauth/clients) that grants the relevant mcp:* scopes.'
              )}
            </p>
            <p className="text-xs text-blue-700 dark:text-blue-300 mb-2">
              {cimdEnabled
                ? t(
                    'admin.mcp.gateway.claudeHintCimd',
                    'Claude: Settings → Connectors → Add custom connector, then paste the endpoint URL above. Claude identifies itself with its metadata document at claude.ai — no client record is created here — and users sign in to iHub and consent to the requested mcp:* scopes.'
                  )
                : dcrEnabled
                  ? t(
                      'admin.mcp.gateway.claudeHintDcr',
                      'Claude: Settings → Connectors → Add custom connector, then paste the endpoint URL above. Claude registers its OAuth client automatically; users sign in to iHub and consent to the requested mcp:* scopes. Turn on Client ID Metadata Documents above to stop it registering at all.'
                    )
                  : t(
                      'admin.mcp.gateway.claudeHintManual',
                      'Claude: Settings → Connectors → Add custom connector, then paste the endpoint URL above and enter the client ID of an OAuth client you created under /admin/oauth/clients (public client, grant types authorization_code + refresh_token, redirect URI https://claude.ai/api/mcp/auth_callback, plus the desired mcp:* scopes). Turn on Client ID Metadata Documents above to skip the manual client setup.'
                    )}
            </p>
            <p className="text-xs text-blue-700 dark:text-blue-300">
              {t(
                'admin.mcp.gateway.claudeHintEnterprise',
                'Claude Team/Enterprise: an organisation admin can instead pin one pre-registered client for everyone — create a public OAuth client with the callback URL above and have them enter its client ID under the connector’s advanced settings.'
              )}
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
                {t('admin.mcp.common.saving', 'Saving...')}
              </>
            ) : (
              t('common.save', 'Save')
            )}
          </button>
        </div>
      </div>
    </div>
  );
}

export default AdminMcpGatewayPage;
