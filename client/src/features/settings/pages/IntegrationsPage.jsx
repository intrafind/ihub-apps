import { useState, useEffect, useMemo } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { useAuth } from '../../auth/hooks/useAuth';
import { usePlatformConfig } from '../../../shared/contexts/PlatformConfigContext';
import Icon from '../../../shared/components/Icon';
import IntegrationCard from '../components/IntegrationCard';
import { getLocalizedContent } from '../../../utils/localizeContent';
import { buildApiUrl } from '../../../utils/runtimeBasePath';

export default function IntegrationsPage() {
  const { t, i18n } = useTranslation();
  const lang = i18n.language;
  const { user } = useAuth();
  const { platformConfig } = usePlatformConfig();
  const location = useLocation();
  const navigate = useNavigate();
  const [integrations, setIntegrations] = useState({});
  const [loading, setLoading] = useState(false);
  const [message, setMessage] = useState(null);

  // Derive cloud storage providers from platform config
  const cloudStorage = platformConfig?.cloudStorage || { enabled: false, providers: [] };
  const cloudProviders = useMemo(
    () => (cloudStorage.enabled ? cloudStorage.providers.filter(p => p.enabled !== false) : []),
    [cloudStorage.enabled, cloudStorage.providers]
  );

  // Handle OAuth callback query parameters
  useEffect(() => {
    const params = new URLSearchParams(location.search);
    const jiraConnected = params.get('jira_connected');
    const jiraError = params.get('jira_error');

    // Handle JIRA callbacks
    if (jiraConnected === 'true') {
      // eslint-disable-next-line @eslint-react/set-state-in-effect
      setMessage({
        type: 'success',
        text: t('integrations.page.jira.connected')
      });
      navigate('/settings/integrations', { replace: true });
    } else if (jiraError) {
      // eslint-disable-next-line @eslint-react/set-state-in-effect
      setMessage({
        type: 'error',
        text: t('integrations.page.jira.connectionFailed', {
          message: decodeURIComponent(jiraError)
        })
      });
      navigate('/settings/integrations', { replace: true });
    }

    // Handle cloud storage provider callbacks dynamically
    cloudProviders.forEach(provider => {
      const connected = params.get(`${provider.type}_connected`);
      const error = params.get(`${provider.type}_error`);

      if (connected === 'true') {
        setMessage({
          type: 'success',
          text: t('integrations.page.cloud.connected', { name: provider.displayName })
        });
        navigate('/settings/integrations', { replace: true });
      } else if (error) {
        setMessage({
          type: 'error',
          text: t('integrations.page.cloud.connectionFailed', {
            name: provider.displayName,
            message: decodeURIComponent(error)
          })
        });
        navigate('/settings/integrations', { replace: true });
      }
    });
  }, [location.search, navigate, cloudProviders, t]);

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

  // Load integration status
  useEffect(() => {
    const loadIntegrations = async () => {
      if (!user?.id) return;

      setLoading(true);
      try {
        // Check JIRA status only if configured on the server
        if (jiraEnabled) {
          const jiraResponse = await fetch(buildApiUrl('integrations/jira/status'), {
            credentials: 'include'
          });
          const jiraData = await jiraResponse.json();

          setIntegrations(prev => ({
            ...prev,
            jira: jiraData
          }));
        }

        // Check cloud storage provider status dynamically
        for (const provider of cloudProviders) {
          try {
            const response = await fetch(buildApiUrl(`integrations/${provider.type}/status`), {
              credentials: 'include'
            });
            const data = await response.json();

            setIntegrations(prev => ({
              ...prev,
              [provider.id]: data
            }));
          } catch (err) {
            console.error(`Error loading ${provider.type} status:`, err);
          }
        }
      } catch (error) {
        console.error('Error loading integrations:', error);
      } finally {
        setLoading(false);
      }
    };

    loadIntegrations();
  }, [user?.id, cloudProviders, jiraEnabled]);

  // Connect flow — JIRA pre-checks the auth response before redirecting so
  // config errors surface inline instead of after a failed round trip.
  const handleConnect = async ({ type, id }) => {
    const returnUrl = window.location.origin + window.location.pathname;
    const authUrl =
      type === 'jira'
        ? `${buildApiUrl('integrations/jira/auth')}?returnUrl=${encodeURIComponent(returnUrl)}`
        : `${buildApiUrl(`integrations/${type}/auth`)}?providerId=${encodeURIComponent(id)}&returnUrl=${encodeURIComponent(returnUrl)}`;

    if (type !== 'jira') {
      window.location.href = authUrl;
      return;
    }

    try {
      const response = await fetch(authUrl, {
        credentials: 'include',
        redirect: 'manual' // Don't automatically follow redirects
      });

      if (
        response.type === 'opaqueredirect' ||
        response.status === 302 ||
        response.status === 301
      ) {
        // The server is redirecting to JIRA OAuth, follow the redirect manually
        window.location.href = authUrl;
      } else if (!response.ok) {
        const errorData = await response.json().catch(() => ({ message: 'Unknown error' }));
        setMessage({
          type: 'error',
          text: t('integrations.page.jira.connectionFailed', {
            message: errorData.message || 'Unknown error'
          })
        });
      }
    } catch (error) {
      setMessage({
        type: 'error',
        text: t('integrations.page.jira.connectionFailed', { message: error.message })
      });
    }
  };

  const handleDisconnect = async ({ type, id, displayName }) => {
    try {
      const response = await fetch(buildApiUrl(`integrations/${type}/disconnect`), {
        method: 'POST',
        credentials: 'include',
        headers: {
          'Content-Type': 'application/json'
        }
      });

      if (response.ok) {
        setIntegrations(prev => ({
          ...prev,
          [id]: { connected: false }
        }));
        setMessage({
          type: 'success',
          text:
            type === 'jira'
              ? t('integrations.page.jira.disconnected')
              : t('integrations.page.cloud.disconnected', { name: displayName })
        });
      }
    } catch (error) {
      setMessage({
        type: 'error',
        text:
          type === 'jira'
            ? t('integrations.page.jira.disconnectFailed', { message: error.message })
            : t('integrations.page.cloud.disconnectFailed', {
                name: displayName,
                message: error.message
              })
      });
    }
  };

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

  if (!user) {
    return (
      <div className="min-h-screen bg-gray-50 dark:bg-gray-900 flex items-center justify-center">
        <div className="text-center">
          <Icon name="lock" className="w-12 h-12 text-gray-400 mx-auto mb-4" />
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
        <div className="bg-white dark:bg-gray-800 shadow rounded-lg">
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
                      message.type === 'success' ? 'text-green-600' : 'text-red-600'
                    }`}
                  />
                  <span className={message.type === 'success' ? 'text-green-800' : 'text-red-800'}>
                    {message.text}
                  </span>
                </div>
                <button
                  onClick={dismissMessage}
                  className={`p-1 rounded-full hover:bg-opacity-20 ${
                    message.type === 'success'
                      ? 'hover:bg-green-600 text-green-600'
                      : 'hover:bg-red-600 text-red-600'
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
              <div className="space-y-6">
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
                    iconBgClassName="bg-gradient-to-br from-purple-600 to-teal-500"
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

                {/* Office Integration — shown when enabled by admin */}
                {officeEnabled && (
                  <div className="border border-gray-200 dark:border-gray-700 rounded-lg p-6">
                    <div className="flex items-start space-x-4">
                      <div className="flex-shrink-0">
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
                              className="flex-1 rounded-md border border-gray-300 dark:border-gray-600 bg-gray-50 dark:bg-gray-700 px-3 py-1.5 text-xs font-mono text-gray-600 dark:text-gray-300 focus:outline-none min-w-0"
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

                {/* Empty state when no integrations are configured */}
                {!jiraEnabled && cloudProviders.length === 0 && !officeEnabled && (
                  <div className="border border-dashed border-gray-300 dark:border-gray-600 rounded-lg p-6 text-center">
                    <Icon name="link" className="w-8 h-8 text-gray-400 mx-auto mb-2" />
                    <h3 className="text-lg font-medium text-gray-500 dark:text-gray-400 mb-1">
                      {t('integrations.page.empty.title')}
                    </h3>
                    <p className="text-gray-400 dark:text-gray-500 text-sm">
                      {t('integrations.page.empty.body')}
                    </p>
                  </div>
                )}

                {/* Placeholder for future integrations */}
                {(jiraEnabled || cloudProviders.length > 0 || officeEnabled) && (
                  <div className="border border-dashed border-gray-300 dark:border-gray-600 rounded-lg p-6 text-center">
                    <Icon name="plus" className="w-8 h-8 text-gray-400 mx-auto mb-2" />
                    <h3 className="text-lg font-medium text-gray-500 dark:text-gray-400 mb-1">
                      {t('integrations.page.comingSoon.title')}
                    </h3>
                    <p className="text-gray-400 dark:text-gray-500 text-sm">
                      {t('integrations.page.comingSoon.body')}
                    </p>
                  </div>
                )}
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
