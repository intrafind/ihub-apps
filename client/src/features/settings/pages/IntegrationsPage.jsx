// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

import { useState, useEffect, useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import { useAuth } from '../../auth/hooks/useAuth';
import { usePlatformConfig } from '../../../shared/contexts/PlatformConfigContext';
import Icon from '../../../shared/components/Icon';
import ConfirmDialog from '../../../shared/components/ConfirmDialog';
import IntegrationCard from '../components/IntegrationCard';
import PersonalApiKeysCard from '../components/PersonalApiKeysCard';
import ConnectedAppsCard from '../components/ConnectedAppsCard';
import { getLocalizedContent } from '../../../utils/localizeContent';
import { buildApiUrl } from '../../../utils/runtimeBasePath';
import { disconnectUserIntegration, fetchUserIntegrations } from '../../../api/userIntegrationsApi';
import { consumeConnectResult } from '../../integrations/connect/connectResult';
import { startIntegrationConnect } from '../../integrations/connect/integrationInfo';

export default function IntegrationsPage() {
  const { t, i18n } = useTranslation();
  const lang = i18n.language;
  const { user, loginWithOidc } = useAuth();
  const { platformConfig } = usePlatformConfig();
  // The user's integrations (`GET /api/integrations`). Null until loaded.
  const [userIntegrations, setUserIntegrations] = useState(null);
  const [loading, setLoading] = useState(false);
  const [message, setMessage] = useState(null);
  // Personal API keys are offered only when an admin enabled them, so the
  // overview stays null until the server confirms the feature is available.
  const [apiKeyOverview, setApiKeyOverview] = useState(null);
  const [apiKeySecrets, setApiKeySecrets] = useState(null);
  const [apiKeyBusy, setApiKeyBusy] = useState(false);
  const [keyPendingRevoke, setKeyPendingRevoke] = useState(null);
  // Connected apps. Null until the server confirms the OAuth authorization
  // server is on — without it there is nothing a user could have connected.
  const [connectionOverview, setConnectionOverview] = useState(null);
  const [connectionBusy, setConnectionBusy] = useState(false);
  const [connectionPendingRevoke, setConnectionPendingRevoke] = useState(null);
  // Stored sign-in iFinder calls are authorized with (OIDC token exchange mode).
  const [iFinderAuthorization, setIFinderAuthorization] = useState(null);

  // Derive cloud storage providers from platform config
  const cloudStorage = platformConfig?.cloudStorage || { enabled: false, providers: [] };
  const cloudProviders = useMemo(
    () => (cloudStorage.enabled ? cloudStorage.providers.filter(p => p.enabled !== false) : []),
    [cloudStorage.enabled, cloudStorage.providers]
  );

  // The result of a sign-in that came back to this page
  // (`integration_connected=<id>` / `integration_error=<code>&integration=<id>`),
  // read once; the text names the integration once the list has loaded.
  const [connectResult] = useState(() => consumeConnectResult());
  useEffect(() => {
    if (connectResult.connected) {
      // eslint-disable-next-line @eslint-react/set-state-in-effect
      setMessage({ type: 'success', result: { kind: 'connected', id: connectResult.connected } });
    } else if (connectResult.error) {
      // eslint-disable-next-line @eslint-react/set-state-in-effect
      setMessage({
        type: 'error',
        result: {
          kind: 'error',
          id: connectResult.errorIntegration || '',
          code: connectResult.error
        }
      });
    }
  }, [connectResult]);

  /** Display name of an integration, falling back to its id. */
  const integrationName = id => userIntegrations?.find(entry => entry.id === id)?.name || id || '';

  /** The text of the current message; sign-in results name the integration. */
  const messageText = !message?.result
    ? message?.text
    : message.result.kind === 'connected'
      ? t('integrations.connect.connectedMessage', '{{name}} connected successfully.', {
          name: integrationName(message.result.id)
        })
      : t('integrations.connect.failedMessage', 'Connecting {{name}} failed: {{message}}', {
          name: integrationName(message.result.id),
          message: t(
            `integrations.connect.errors.${message.result.code}`,
            t('integrations.connect.errors.oauth_failed', 'The sign-in did not succeed.')
          )
        });

  /** Connection state per installation id, in the shape the cards read. */
  const integrations = useMemo(() => {
    const byId = {};
    for (const entry of userIntegrations || []) {
      const connection = entry.connection || {};
      byId[entry.id] = {
        connected: connection.status === 'connected',
        userInfo: connection.account ? { displayName: connection.account } : null
      };
    }
    return byId;
  }, [userIntegrations]);

  // MCP servers with per-user sign-in the user may connect.
  const mcpServers = useMemo(
    () =>
      (userIntegrations || [])
        .filter(entry => entry.protocol === 'mcp' && entry.connection?.mode === 'personal')
        .map(entry => ({
          serverId: entry.id,
          name: entry.name,
          description: entry.description,
          connected: entry.connection.status === 'connected'
        })),
    [userIntegrations]
  );

  // Derive Jira enabled state from platform config
  const jiraEnabled = platformConfig?.jira?.enabled;

  // Derive Office Integration state from platform config
  const officeIntegration = platformConfig?.officeIntegration;
  const officeEnabled = officeIntegration?.enabled;
  const officeDisplayName =
    getLocalizedContent(officeIntegration?.displayName, lang) || 'iHub Apps for Outlook';
  const officeDescription =
    getLocalizedContent(officeIntegration?.description, lang) || 'AI-powered assistant for Outlook';
  const officeManifestUrl = buildApiUrl('integrations/office-addin/manifest.xml');

  // Two kinds of integration share this page: accounts iHub signs in to on the
  // user's behalf, and tools that sign in to iHub as the user. Each section is
  // shown only when it has something in it.
  const hasAccounts =
    !!jiraEnabled ||
    cloudProviders.length > 0 ||
    mcpServers?.length > 0 ||
    !!iFinderAuthorization?.enabled;
  const hasAccess = !!officeEnabled || !!apiKeyOverview?.enabled || !!connectionOverview?.enabled;

  // Load integration status
  useEffect(() => {
    const loadIntegrations = async () => {
      if (!user?.id) return;

      setLoading(true);
      try {
        // Every integration the user may use, with its connection status.
        try {
          setUserIntegrations(await fetchUserIntegrations());
        } catch (err) {
          console.error('Error loading integrations:', err);
          setUserIntegrations([]);
        }

        // Personal API keys. A 404 means the admin has not enabled them, which
        // is the normal case — the card simply stays hidden.
        try {
          const apiKeyResponse = await fetch(buildApiUrl('integrations/api-keys'), {
            credentials: 'include'
          });
          if (apiKeyResponse.ok) {
            setApiKeyOverview(await apiKeyResponse.json());
          }
        } catch (err) {
          console.error('Error loading API keys:', err);
        }

        // Connected apps. A 404 means the OAuth authorization server is off,
        // which is the normal case — the card simply stays hidden.
        try {
          const connectionResponse = await fetch(buildApiUrl('integrations/connections'), {
            credentials: 'include'
          });
          if (connectionResponse.ok) {
            setConnectionOverview(await connectionResponse.json());
          }
        } catch (err) {
          console.error('Error loading connections:', err);
        }

        // iFinder background authorization. `enabled` is false unless iFinder
        // gets its tokens from a shared OIDC provider.
        try {
          const iFinderResponse = await fetch(buildApiUrl('integrations/ifinder/authorization'), {
            credentials: 'include'
          });
          if (iFinderResponse.ok) {
            setIFinderAuthorization(await iFinderResponse.json());
          }
        } catch (err) {
          console.error('Error loading iFinder authorization:', err);
        }
      } catch (error) {
        console.error('Error loading integrations:', error);
      } finally {
        setLoading(false);
      }
    };

    void loadIntegrations();
  }, [user?.id]);

  // Connect: the one connect flow of every integration. The browser leaves for
  // the vendor's consent and comes back to this page.
  const handleConnect = async ({ id, displayName }) => {
    try {
      await startIntegrationConnect(id, {
        returnUrl: window.location.origin + window.location.pathname
      });
    } catch (error) {
      setMessage({
        type: 'error',
        text: t(
          'integrations.connect.startFailed',
          'The sign-in to {{name}} could not be started.',
          {
            name: displayName || id
          }
        ),
        detail: error.message
      });
    }
  };

  const handleIFinderRevoke = async () => {
    try {
      const response = await fetch(buildApiUrl('integrations/ifinder/authorization'), {
        method: 'DELETE',
        credentials: 'include'
      });
      if (!response.ok) throw new Error(response.statusText);
      setIFinderAuthorization(prev => ({ ...prev, authorized: false, authorizedAt: undefined }));
      setMessage({
        type: 'success',
        text: t('integrations.page.iFinder.revoked', 'iFinder authorization revoked')
      });
    } catch (error) {
      setMessage({
        type: 'error',
        text: t('integrations.page.iFinder.revokeFailed', {
          message: error.message,
          defaultValue: 'Could not revoke the iFinder authorization: {{message}}'
        })
      });
    }
  };

  const handleDisconnect = async ({ type, id, displayName }) => {
    const name = displayName || integrationName(id);
    try {
      await disconnectUserIntegration(id);
      setUserIntegrations(prev =>
        (prev || []).map(entry =>
          entry.id === id
            ? {
                ...entry,
                connection: { ...entry.connection, status: 'not_connected', account: null }
              }
            : entry
        )
      );
      setMessage({
        type: 'success',
        text:
          type === 'jira'
            ? t('integrations.page.jira.disconnected')
            : t('integrations.page.cloud.disconnected', { name })
      });
    } catch (error) {
      setMessage({
        type: 'error',
        text:
          type === 'jira'
            ? t('integrations.page.jira.disconnectFailed', { message: error.message })
            : t('integrations.page.cloud.disconnectFailed', { name, message: error.message })
      });
    }
  };

  // MCP servers: the same connect flow as every other integration.
  const handleMcpConnect = server =>
    handleConnect({ id: server.serverId, displayName: server.name });

  const handleMcpDisconnect = server =>
    handleDisconnect({ type: 'mcp', id: server.serverId, displayName: server.name });

  const handleTest = async () => {
    try {
      const response = await fetch(buildApiUrl('integrations/jira/test'), {
        credentials: 'include'
      });
      const data = await response.json();

      if (data.success) {
        setMessage({
          type: 'success',
          text: t('integrations.page.jira.testSuccess', {
            count: data.testResults?.accessibleTickets || 0
          })
        });
      } else {
        setMessage({
          type: 'error',
          text: t('integrations.page.jira.testFailed', { message: data.message })
        });
      }
    } catch (error) {
      setMessage({
        type: 'error',
        text: t('integrations.page.jira.testFailed', { message: error.message })
      });
    }
  };

  const dismissMessage = () => {
    setMessage(null);
  };

  const refreshConnections = async () => {
    const response = await fetch(buildApiUrl('integrations/connections'), {
      credentials: 'include'
    });
    if (response.ok) {
      setConnectionOverview(await response.json());
    }
  };

  const handleDisconnectApp = async connection => {
    setConnectionPendingRevoke(null);
    if (!connection) return;

    setConnectionBusy(true);
    try {
      const response = await fetch(
        buildApiUrl(`integrations/connections/${encodeURIComponent(connection.clientId)}`),
        { method: 'DELETE', credentials: 'include' }
      );
      const data = await response.json().catch(() => ({}));

      if (!response.ok) {
        setMessage({
          type: 'error',
          text: t('integrations.page.connections.disconnectFailed', {
            message: data.error || response.statusText
          })
        });
        return;
      }

      setMessage({
        type: 'success',
        text: t('integrations.page.connections.disconnected', 'Disconnected {{name}}', {
          name: connection.clientName
        })
      });
      await refreshConnections().catch(() => {});
    } catch (error) {
      setMessage({
        type: 'error',
        text: t('integrations.page.connections.disconnectFailed', { message: error.message })
      });
    } finally {
      setConnectionBusy(false);
    }
  };

  // Personal API keys. Create and rotate return the credentials once; everything
  // afterwards works from the key list, which never carries a secret.
  const refreshApiKeys = async () => {
    const response = await fetch(buildApiUrl('integrations/api-keys'), {
      credentials: 'include'
    });
    if (response.ok) {
      setApiKeyOverview(await response.json());
    }
  };

  const callApiKeyEndpoint = async (path, options, errorKey) => {
    setApiKeyBusy(true);
    try {
      const response = await fetch(buildApiUrl(`integrations/api-keys${path}`), {
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        ...options
      });

      const data = await response.json().catch(() => ({}));
      if (!response.ok) {
        setMessage({
          type: 'error',
          text: t(errorKey, { message: data.error || response.statusText })
        });
        return null;
      }

      // The key already exists on the server and `data` may carry secrets shown
      // exactly once, so a failed list refresh must not turn a success into an
      // error and discard them.
      await refreshApiKeys().catch(() => {});

      return data;
    } catch (error) {
      setMessage({ type: 'error', text: t(errorKey, { message: error.message }) });
      return null;
    } finally {
      setApiKeyBusy(false);
    }
  };

  const handleCreateApiKey = async ({ name, expirationDays }) => {
    const data = await callApiKeyEndpoint(
      '',
      { method: 'POST', body: JSON.stringify({ name, expirationDays }) },
      'integrations.page.apiKeys.createFailed'
    );

    if (data?.secrets) {
      setApiKeySecrets(data.secrets);
      setMessage({ type: 'success', text: t('integrations.page.apiKeys.created') });
    }
  };

  const handleRotateApiKey = async key => {
    const data = await callApiKeyEndpoint(
      `/${encodeURIComponent(key.id)}/rotate`,
      { method: 'POST', body: JSON.stringify({}) },
      'integrations.page.apiKeys.rotateFailed'
    );

    if (data?.secrets) {
      setApiKeySecrets(data.secrets);
      setMessage({ type: 'success', text: t('integrations.page.apiKeys.rotated') });
    }
  };

  const handleRevokeApiKey = async key => {
    setKeyPendingRevoke(null);
    const data = await callApiKeyEndpoint(
      `/${encodeURIComponent(key.id)}`,
      { method: 'DELETE' },
      'integrations.page.apiKeys.revokeFailed'
    );

    if (data?.success) {
      setApiKeySecrets(null);
      setMessage({ type: 'success', text: t('integrations.page.apiKeys.revoked') });
    }
  };

  if (!user) {
    return (
      <div className="min-h-screen bg-gray-50 dark:bg-gray-900 flex items-center justify-center">
        <div className="text-center">
          <Icon name="lock" className="w-12 h-12 text-gray-500 mx-auto mb-4" />
          <h2 className="text-xl font-semibold text-gray-900 dark:text-gray-100 mb-2">
            {t('integrations.page.authRequiredTitle')}
          </h2>
          <p className="text-gray-600 dark:text-gray-400">
            {t('integrations.page.authRequiredBody')}
          </p>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-gray-50 dark:bg-gray-900 py-6">
      <div className="max-w-4xl mx-auto px-4 sm:px-6 lg:px-8">
        <div className="bg-white dark:bg-gray-800 shadow-sm rounded-lg">
          {/* Header */}
          <div className="px-6 py-4 border-b border-gray-200 dark:border-gray-700">
            <div className="flex items-center justify-between">
              <div>
                <h1 className="text-2xl font-bold text-gray-900 dark:text-gray-100">
                  {t('integrations.page.title')}
                </h1>
                <p className="text-gray-600 dark:text-gray-400 mt-1">
                  {t('integrations.page.subtitle')}
                </p>
              </div>
              <Icon name="link" className="w-8 h-8 text-blue-600" />
            </div>
          </div>

          {/* Message Banner */}
          {message && (
            <div
              className={`px-6 py-4 border-b border-gray-200 ${
                message.type === 'success'
                  ? 'bg-green-50 border-green-200'
                  : 'bg-red-50 border-red-200'
              }`}
            >
              <div className="flex items-center justify-between">
                <div className="flex items-center">
                  <Icon
                    name={message.type === 'success' ? 'check-circle' : 'warning'}
                    className={`w-5 h-5 mr-2 ${
                      message.type === 'success' ? 'text-green-700' : 'text-red-700'
                    }`}
                  />
                  <span className={message.type === 'success' ? 'text-green-800' : 'text-red-800'}>
                    {messageText}
                  </span>
                </div>
                <button
                  onClick={dismissMessage}
                  className={`p-1 rounded-full ${
                    message.type === 'success'
                      ? 'hover:bg-green-600/20 text-green-700'
                      : 'hover:bg-red-600/20 text-red-600'
                  }`}
                >
                  <Icon name="x" className="w-4 h-4" />
                </button>
              </div>
            </div>
          )}

          {/* Integrations List */}
          <div className="p-6">
            {loading ? (
              <div className="flex items-center justify-center py-8">
                <Icon name="spinner" className="w-8 h-8 animate-spin text-blue-600" />
                <span className="ml-3 text-gray-600 dark:text-gray-400">
                  {t('integrations.page.loading')}
                </span>
              </div>
            ) : (
              <div className="space-y-10">
                {/* Services iHub signs in to on the user's behalf */}
                {hasAccounts && (
                  <section aria-labelledby="integrations-section-accounts" className="space-y-4">
                    <div>
                      <h2
                        id="integrations-section-accounts"
                        className="text-lg font-semibold text-gray-900 dark:text-gray-100"
                      >
                        {t('integrations.page.sections.accounts.title', 'Your accounts')}
                      </h2>
                      <p className="text-sm text-gray-600 dark:text-gray-400">
                        {t(
                          'integrations.page.sections.accounts.description',
                          'Sign in to services so iHub can work with them on your behalf.'
                        )}
                      </p>
                    </div>

                    {/* JIRA Integration — only shown when Jira is configured server-side */}
                    {jiraEnabled && (
                      <IntegrationCard
                        icon="ticket"
                        iconBgClassName="bg-blue-600"
                        title={t('integrations.jira.title')}
                        description={t('integrations.page.jira.description')}
                        connected={!!integrations.jira?.connected}
                        userInfo={
                          integrations.jira?.userInfo
                            ? {
                                displayName: integrations.jira.userInfo.displayName,
                                email: integrations.jira.userInfo.emailAddress
                              }
                            : null
                        }
                        features={[
                          t('integrations.page.jira.features.search'),
                          t('integrations.page.jira.features.create'),
                          t('integrations.page.jira.features.update'),
                          t('integrations.page.jira.features.info')
                        ]}
                        connectLabel={t('integrations.page.card.connectAccount', { name: 'JIRA' })}
                        onConnect={() =>
                          handleConnect({ type: 'jira', id: 'jira', displayName: 'JIRA' })
                        }
                        onDisconnect={() =>
                          handleDisconnect({ type: 'jira', id: 'jira', displayName: 'JIRA' })
                        }
                        extraActions={
                          <button
                            onClick={handleTest}
                            className="bg-blue-600 hover:bg-blue-700 text-white px-4 py-2 rounded-md font-medium transition-colors flex items-center"
                          >
                            <Icon name="check-circle" className="w-4 h-4 mr-2" />
                            {t('integrations.jira.test')}
                          </button>
                        }
                      />
                    )}

                    {/* Cloud Storage Integrations */}
                    {cloudProviders.map(provider => (
                      <IntegrationCard
                        key={provider.id}
                        icon="cloud"
                        iconBgClassName="bg-linear-to-br from-purple-600 to-teal-500"
                        connectButtonClassName="bg-purple-600 hover:bg-purple-700"
                        title={provider.displayName}
                        description={
                          provider.type === 'office365'
                            ? t('integrations.page.cloud.description.office365')
                            : t('integrations.page.cloud.description.googleDrive')
                        }
                        connected={!!integrations[provider.id]?.connected}
                        userInfo={
                          integrations[provider.id]?.userInfo
                            ? {
                                displayName: integrations[provider.id].userInfo.displayName,
                                email:
                                  integrations[provider.id].userInfo.mail ||
                                  integrations[provider.id].userInfo.emailAddress
                              }
                            : null
                        }
                        tokenExpiring={!!integrations[provider.id]?.tokenInfo?.isExpiring}
                        features={[
                          provider.type === 'office365'
                            ? t('integrations.page.cloud.features.browseOffice365')
                            : t('integrations.page.cloud.features.browseGoogleDrive'),
                          t('integrations.page.cloud.features.upload'),
                          t('integrations.page.cloud.features.oauth')
                        ]}
                        connectLabel={t('integrations.page.card.connectAccount', {
                          name: provider.displayName
                        })}
                        onConnect={() =>
                          handleConnect({
                            type: provider.type,
                            id: provider.id,
                            displayName: provider.displayName
                          })
                        }
                        onDisconnect={() =>
                          handleDisconnect({
                            type: provider.type,
                            id: provider.id,
                            displayName: provider.displayName
                          })
                        }
                      />
                    ))}

                    {/* iFinder: the stored sign-in its tokens are exchanged from */}
                    {iFinderAuthorization?.enabled && (
                      <IntegrationCard
                        icon="search"
                        iconBgClassName="bg-indigo-600"
                        connectButtonClassName="bg-indigo-600 hover:bg-indigo-700"
                        title={t('integrations.page.iFinder.title', 'iFinder')}
                        description={t('integrations.page.iFinder.description', {
                          provider: iFinderAuthorization.provider.displayName,
                          defaultValue:
                            'iHub uses your {{provider}} sign-in to search iFinder for you, also in scheduled tasks and workflows while you are signed out.'
                        })}
                        connected={!!iFinderAuthorization.authorized}
                        userInfo={
                          iFinderAuthorization.authorized
                            ? {
                                displayName: t('integrations.page.iFinder.authorizedSince', {
                                  provider: iFinderAuthorization.provider.displayName,
                                  date: iFinderAuthorization.authorizedAt
                                    ? new Date(iFinderAuthorization.authorizedAt).toLocaleString(
                                        lang
                                      )
                                    : '',
                                  defaultValue: 'Authorized via {{provider}} on {{date}}'
                                })
                              }
                            : null
                        }
                        connectLabel={t('integrations.page.iFinder.authorize', {
                          provider: iFinderAuthorization.provider.displayName,
                          defaultValue: 'Sign in via {{provider}}'
                        })}
                        onConnect={() => loginWithOidc(iFinderAuthorization.provider.name)}
                        onDisconnect={handleIFinderRevoke}
                      />
                    )}

                    {/* MCP servers with per-user sign-in */}
                    {mcpServers?.length > 0 && (
                      <div className="space-y-4">
                        <div>
                          <h3 className="text-base font-semibold text-gray-900 dark:text-gray-100">
                            {t('integrations.page.mcp.title', 'MCP servers')}
                          </h3>
                          <p className="text-sm text-gray-600 dark:text-gray-400">
                            {t(
                              'integrations.page.mcp.description',
                              'Tools of these servers act with your own account. Connect a server to use its tools in chats.'
                            )}
                          </p>
                        </div>
                        {mcpServers.map(server => {
                          const name = getLocalizedContent(server.name, lang) || server.serverId;
                          return (
                            <IntegrationCard
                              key={server.serverId}
                              icon="cube"
                              iconBgClassName="bg-indigo-600"
                              connectButtonClassName="bg-indigo-600 hover:bg-indigo-700"
                              title={name}
                              description={
                                getLocalizedContent(server.description, lang) ||
                                t('integrations.page.mcp.serverDescription', 'MCP server')
                              }
                              connected={!!server.connected}
                              connectLabel={t('integrations.page.mcp.connect', 'Connect {{name}}', {
                                name
                              })}
                              onConnect={() => handleMcpConnect(server)}
                              onDisconnect={() => handleMcpDisconnect(server)}
                            />
                          );
                        })}
                      </div>
                    )}
                  </section>
                )}

                {/* Tools and applications that use iHub as the user */}
                {hasAccess && (
                  <section aria-labelledby="integrations-section-access" className="space-y-4">
                    <div>
                      <h2
                        id="integrations-section-access"
                        className="text-lg font-semibold text-gray-900 dark:text-gray-100"
                      >
                        {t('integrations.page.sections.access.title', 'Access to iHub')}
                      </h2>
                      <p className="text-sm text-gray-600 dark:text-gray-400">
                        {t(
                          'integrations.page.sections.access.description',
                          'Tools and applications that use iHub Apps as you.'
                        )}
                      </p>
                    </div>

                    {/* Connected apps — shown when the OAuth authorization server is on */}
                    {connectionOverview?.enabled && (
                      <ConnectedAppsCard
                        connections={connectionOverview.connections}
                        busy={connectionBusy}
                        onDisconnect={setConnectionPendingRevoke}
                      />
                    )}

                    {/* Personal API keys — shown when enabled by admin */}
                    {apiKeyOverview?.enabled && (
                      <PersonalApiKeysCard
                        limits={apiKeyOverview.limits}
                        endpoints={apiKeyOverview.endpoints}
                        keys={apiKeyOverview.keys}
                        busy={apiKeyBusy}
                        secrets={apiKeySecrets}
                        onDismissSecrets={() => setApiKeySecrets(null)}
                        onCreate={handleCreateApiKey}
                        onRotate={handleRotateApiKey}
                        onRevoke={setKeyPendingRevoke}
                      />
                    )}

                    {/* Office Integration — shown when enabled by admin */}
                    {officeEnabled && (
                      <div className="border border-gray-200 dark:border-gray-700 rounded-lg p-6">
                        <div className="flex items-start space-x-4">
                          <div className="shrink-0">
                            <div className="w-12 h-12 bg-blue-600 rounded-lg flex items-center justify-center">
                              <Icon name="envelope" className="w-7 h-7 text-white" />
                            </div>
                          </div>

                          <div className="flex-1 min-w-0">
                            <div className="flex items-center justify-between">
                              <div>
                                <h3 className="text-lg font-semibold text-gray-900 dark:text-gray-100">
                                  {officeDisplayName}
                                </h3>
                                <p className="text-gray-600 dark:text-gray-400 text-sm">
                                  {officeDescription}
                                </p>
                              </div>
                              <span className="px-3 py-1 text-xs font-medium rounded-full bg-green-100 dark:bg-green-900/50 text-green-800 dark:text-green-300">
                                {t('integrations.page.office.available')}
                              </span>
                            </div>

                            <div className="mt-4">
                              <p className="text-sm text-gray-600 dark:text-gray-400 mb-3">
                                {t('integrations.page.office.deployHint')}
                              </p>
                              <div className="flex items-center gap-2">
                                <input
                                  type="text"
                                  readOnly
                                  value={officeManifestUrl}
                                  className="flex-1 rounded-md border border-gray-300 dark:border-gray-600 bg-gray-50 dark:bg-gray-700 px-3 py-1.5 text-xs font-mono text-gray-600 dark:text-gray-300 focus:outline-hidden min-w-0"
                                  onClick={e => e.target.select()}
                                />
                                <button
                                  type="button"
                                  onClick={() => navigator.clipboard?.writeText(officeManifestUrl)}
                                  className="shrink-0 rounded-md border border-gray-300 dark:border-gray-600 px-3 py-1.5 text-sm text-gray-600 dark:text-gray-300 hover:bg-gray-50 dark:hover:bg-gray-700"
                                >
                                  {t('integrations.page.office.copy')}
                                </button>
                                <a
                                  href={officeManifestUrl}
                                  download="manifest.xml"
                                  className="shrink-0 rounded-md bg-blue-600 text-white px-3 py-1.5 text-sm font-medium hover:bg-blue-700"
                                >
                                  {t('integrations.page.office.download')}
                                </a>
                              </div>
                            </div>
                          </div>
                        </div>
                      </div>
                    )}
                  </section>
                )}

                {/* Empty state when no integrations are configured */}
                {!hasAccounts && !hasAccess && (
                  <div className="border border-dashed border-gray-300 dark:border-gray-600 rounded-lg p-6 text-center">
                    <Icon name="link" className="w-8 h-8 text-gray-500 mx-auto mb-2" />
                    <h3 className="text-lg font-medium text-gray-500 dark:text-gray-400 mb-1">
                      {t('integrations.page.empty.title')}
                    </h3>
                    <p className="text-gray-500 dark:text-gray-400 text-sm">
                      {t('integrations.page.empty.body')}
                    </p>
                  </div>
                )}
              </div>
            )}
          </div>
        </div>
      </div>

      <ConfirmDialog
        isOpen={!!connectionPendingRevoke}
        title={t('integrations.page.connections.disconnectTitle', 'Disconnect application')}
        message={
          <>
            <p>
              {t('integrations.page.connections.disconnectConfirm', {
                name: connectionPendingRevoke?.clientName || ''
              })}
            </p>
            <p className="mt-2 text-xs text-gray-500 dark:text-gray-400">
              {t(
                'integrations.page.connections.tokenNote',
                'An access token the app already holds keeps working for up to {{minutes}} minutes after you disconnect. It cannot obtain a new one.',
                { minutes: connectionOverview?.tokenExpirationMinutes ?? 60 }
              )}
            </p>
          </>
        }
        confirmLabel={t('integrations.page.connections.disconnect', 'Disconnect')}
        danger
        onConfirm={() => handleDisconnectApp(connectionPendingRevoke)}
        onDeny={() => setConnectionPendingRevoke(null)}
      />

      <ConfirmDialog
        isOpen={!!keyPendingRevoke}
        title={t('integrations.page.apiKeys.revokeTitle', 'Revoke API key')}
        message={t('integrations.page.apiKeys.revokeConfirm', {
          name: keyPendingRevoke?.name || ''
        })}
        confirmLabel={t('integrations.page.apiKeys.revoke', 'Revoke')}
        danger
        onConfirm={() => handleRevokeApiKey(keyPendingRevoke)}
        onDeny={() => setKeyPendingRevoke(null)}
      />
    </div>
  );
}
