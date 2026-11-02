// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

import { useState, useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import { useAuth } from '../../auth/hooks/useAuth';
import { usePlatformConfig } from '../../../shared/contexts/PlatformConfigContext';
import Icon from '../../../shared/components/Icon';
import ConfirmDialog from '../../../shared/components/ConfirmDialog';
import AvailableIntegrations from '../components/AvailableIntegrations';
import RequestableIntegrations from '../components/RequestableIntegrations';
import PersonalApiKeysCard from '../components/PersonalApiKeysCard';
import ConnectedAppsCard from '../components/ConnectedAppsCard';
import { SECONDARY_BUTTON, PRIMARY_BUTTON } from '../components/integrationButtons';
import { getLocalizedContent } from '../../../utils/localizeContent';
import { buildApiUrl } from '../../../utils/runtimeBasePath';
import { fetchUserIntegrations } from '../../../api/userIntegrationsApi';
import { consumeConnectResult } from '../../integrations/connect/connectResult';

/**
 * Settings → Integrations (#2922).
 *
 * - **Available to you**: every integration the user's groups allow, from
 *   `GET /api/integrations`, with who iHub acts as in each (connected as you,
 *   signed in via SSO, service account, shared key, not connected, reconnect
 *   needed, unavailable) and Connect / Reconnect / Disconnect through the one
 *   connect flow.
 * - **Not available yet**: the catalog integrations the user's groups cannot
 *   use yet, read-only, with Request (#2926).
 * - **Sign-in for background tasks**: the stored sign-in iFinder calls are
 *   authorized with (OIDC token exchange only).
 * - **Access to iHub**: connected apps, personal API keys, the Outlook add-in.
 */
export default function IntegrationsPage() {
  const { t, i18n } = useTranslation();
  const lang = i18n.language;
  const { user, loginWithOidc } = useAuth();
  const { platformConfig } = usePlatformConfig();
  // The user's integrations (`GET /api/integrations`). Null until loaded.
  const [userIntegrations, setUserIntegrations] = useState(null);
  const [integrationsFailed, setIntegrationsFailed] = useState(false);
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
            t('integrations.connect.errors.oauth_failed', 'The sign-in did not succeed.', {
              name: integrationName(message.result.id)
            }),
            { name: integrationName(message.result.id) }
          )
        });

  // Derive Office Integration state from platform config
  const officeIntegration = platformConfig?.officeIntegration;
  const officeEnabled = officeIntegration?.enabled;
  const officeDisplayName =
    getLocalizedContent(officeIntegration?.displayName, lang) || 'iHub Apps for Outlook';
  const officeDescription =
    getLocalizedContent(officeIntegration?.description, lang) || 'AI-powered assistant for Outlook';
  const officeManifestUrl = buildApiUrl('integrations/office-addin/manifest.xml');

  const hasAccess = !!officeEnabled || !!apiKeyOverview?.enabled || !!connectionOverview?.enabled;

  // Load the page's data
  useEffect(() => {
    const loadIntegrations = async () => {
      if (!user?.id) return;

      setLoading(true);
      try {
        // Every integration the user may use, with how it runs for them.
        try {
          setUserIntegrations(await fetchUserIntegrations());
          setIntegrationsFailed(false);
        } catch (err) {
          console.error('Error loading integrations:', err);
          setUserIntegrations([]);
          setIntegrationsFailed(true);
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

          {/* Message banner: a live region that stays mounted, so screen readers announce results */}
          <div role="status" aria-live="polite" aria-atomic="true">
            {message && (
              <div
                className={`px-6 py-4 border-b ${
                  message.type === 'success'
                    ? 'bg-green-50 border-green-200 dark:bg-green-900/30 dark:border-green-800'
                    : 'bg-red-50 border-red-200 dark:bg-red-900/30 dark:border-red-800'
                }`}
                data-testid="integrations-message"
              >
                <div className="flex items-center justify-between gap-3">
                  <div className="flex items-center">
                    <Icon
                      name={message.type === 'success' ? 'check-circle' : 'warning'}
                      className={`w-5 h-5 mr-2 shrink-0 ${
                        message.type === 'success'
                          ? 'text-green-700 dark:text-green-300'
                          : 'text-red-700 dark:text-red-300'
                      }`}
                    />
                    <span
                      className={
                        message.type === 'success'
                          ? 'text-green-800 dark:text-green-200'
                          : 'text-red-800 dark:text-red-200'
                      }
                    >
                      {messageText}
                    </span>
                  </div>
                  <button
                    type="button"
                    onClick={dismissMessage}
                    aria-label={t('integrations.page.dismissMessage', 'Dismiss message')}
                    className={`p-1 rounded-full shrink-0 focus:outline-hidden focus-visible:ring-2 focus-visible:ring-indigo-500 ${
                      message.type === 'success'
                        ? 'hover:bg-green-600/20 text-green-700 dark:text-green-300'
                        : 'hover:bg-red-600/20 text-red-700 dark:text-red-300'
                    }`}
                  >
                    <Icon name="x" className="w-4 h-4" />
                  </button>
                </div>
              </div>
            )}
          </div>

          <div className="p-6">
            {loading ? (
              <div className="flex items-center justify-center py-8" role="status">
                <Icon name="spinner" className="w-8 h-8 animate-spin text-blue-600" />
                <span className="ml-3 text-gray-600 dark:text-gray-400">
                  {t('integrations.page.loading')}
                </span>
              </div>
            ) : (
              <div className="space-y-10">
                {/* Everything the user's groups allow, with how it runs for them */}
                {integrationsFailed ? (
                  <p
                    role="alert"
                    className="rounded-lg border border-red-200 bg-red-50 p-4 text-sm text-red-800 dark:border-red-800 dark:bg-red-900/30 dark:text-red-200"
                  >
                    {t(
                      'integrations.page.available.loadFailed',
                      'Your integrations could not be loaded. Reload the page to try again.'
                    )}
                  </p>
                ) : (
                  <AvailableIntegrations
                    entries={userIntegrations || []}
                    onEntriesChange={updater => setUserIntegrations(prev => updater(prev || []))}
                    onMessage={setMessage}
                  />
                )}

                {/* Catalog integrations the user's groups cannot use yet: Request */}
                <RequestableIntegrations onMessage={setMessage} />

                {/* iFinder: the stored sign-in its tokens are exchanged from */}
                {iFinderAuthorization?.enabled && (
                  <section aria-labelledby="integrations-section-background" className="space-y-3">
                    <div>
                      <h2
                        id="integrations-section-background"
                        className="text-lg font-semibold text-gray-900 dark:text-gray-100"
                      >
                        {t(
                          'integrations.page.iFinder.sectionTitle',
                          'Sign-in for background tasks'
                        )}
                      </h2>
                      <p className="text-sm text-gray-600 dark:text-gray-400">
                        {t('integrations.page.iFinder.description', {
                          provider: iFinderAuthorization.provider.displayName,
                          defaultValue:
                            'iHub uses your {{provider}} sign-in to search iFinder for you, also in scheduled tasks and workflows while you are signed out.'
                        })}
                      </p>
                    </div>
                    <div className="flex flex-col gap-3 rounded-lg border border-gray-200 p-4 sm:flex-row sm:items-center sm:justify-between dark:border-gray-700">
                      <p className="text-sm text-gray-800 dark:text-gray-200">
                        {iFinderAuthorization.authorized
                          ? t('integrations.page.iFinder.authorizedSince', {
                              provider: iFinderAuthorization.provider.displayName,
                              date: iFinderAuthorization.authorizedAt
                                ? new Date(iFinderAuthorization.authorizedAt).toLocaleString(lang)
                                : '',
                              defaultValue: 'Authorized via {{provider}} on {{date}}'
                            })
                          : t('integrations.page.iFinder.notAuthorized', 'Not authorized')}
                      </p>
                      {iFinderAuthorization.authorized ? (
                        <button
                          type="button"
                          className={SECONDARY_BUTTON}
                          onClick={handleIFinderRevoke}
                        >
                          {t('integrations.page.iFinder.revoke', 'Revoke')}
                        </button>
                      ) : (
                        <button
                          type="button"
                          className={PRIMARY_BUTTON}
                          onClick={() => loginWithOidc(iFinderAuthorization.provider.name)}
                        >
                          {t('integrations.page.iFinder.authorize', {
                            provider: iFinderAuthorization.provider.displayName,
                            defaultValue: 'Sign in via {{provider}}'
                          })}
                        </button>
                      )}
                    </div>
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
