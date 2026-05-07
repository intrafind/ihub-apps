import { useState, useEffect, useCallback } from 'react';
import { useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import Icon from '../../../shared/components/Icon';
import AdminAuth from '../components/AdminAuth';
import AdminNavigation from '../components/AdminNavigation';
import { makeAdminApiCall } from '../../../api/adminApi';
import LoadingSpinner from '../../../shared/components/LoadingSpinner';
import { usePlatformConfig } from '../../../shared/contexts/PlatformConfigContext';
import { getBasePath } from '../../../utils/runtimeBasePath.js';

function AdminOAuthServerPage() {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const { refreshConfig } = usePlatformConfig();
  const [loading, setLoading] = useState(true);
  const [message, setMessage] = useState('');
  const [oauthEnabled, setOAuthEnabled] = useState(false);
  const [oauthConfig, setOauthConfig] = useState({
    issuer: '',
    defaultTokenExpirationMinutes: 60,
    maxTokenExpirationMinutes: 1440,
    authorizationCodeEnabled: false,
    authorizationCodeExpirationSeconds: 600,
    refreshTokenEnabled: false,
    refreshTokenExpirationDays: 30,
    consentRequired: true,
    consentMemoryDays: 90
  });
  const [jwtAlgorithm, setJwtAlgorithm] = useState('RS256');
  const [savingConfig, setSavingConfig] = useState(false);

  useEffect(() => {
    loadConfig();
    // eslint-disable-next-line @eslint-react/exhaustive-deps
  }, []);

  const loadConfig = async () => {
    try {
      const response = await makeAdminApiCall('/admin/configs/platform');
      const data = response.data;
      setOAuthEnabled(data?.oauth?.enabled?.authz || false);
      if (data?.oauth) {
        setOauthConfig(prev => ({
          ...prev,
          issuer: data.oauth.issuer || '',
          defaultTokenExpirationMinutes: data.oauth.defaultTokenExpirationMinutes ?? 60,
          maxTokenExpirationMinutes: data.oauth.maxTokenExpirationMinutes ?? 1440,
          authorizationCodeEnabled: data.oauth.authorizationCodeEnabled ?? false,
          authorizationCodeExpirationSeconds: data.oauth.authorizationCodeExpirationSeconds ?? 600,
          refreshTokenEnabled: data.oauth.refreshTokenEnabled ?? false,
          refreshTokenExpirationDays: data.oauth.refreshTokenExpirationDays ?? 30,
          consentRequired: data.oauth.consentRequired ?? true,
          consentMemoryDays: data.oauth.consentMemoryDays ?? 90
        }));
      }
      setJwtAlgorithm(data?.jwt?.algorithm || 'RS256');
    } catch (error) {
      console.error('Failed to load OAuth config:', error);
      setMessage({
        type: 'error',
        text: t('admin.auth.oauth.loadError', 'Failed to load configuration')
      });
    } finally {
      setLoading(false);
    }
  };

  const updateOAuthConfig = useCallback((field, value) => {
    setOauthConfig(prev => ({ ...prev, [field]: value }));
  }, []);

  const getServerBaseUrl = useCallback(() => {
    const basePath = getBasePath();
    const origin = window.location.origin;
    return basePath ? `${origin}${basePath}` : origin;
  }, []);

  const copyToClipboard = useCallback(
    text => {
      navigator.clipboard.writeText(text);
      setMessage({
        type: 'success',
        text: t('common.copiedToClipboard', 'Copied to clipboard')
      });
    },
    [t]
  );

  const handleToggleOAuth = async () => {
    const newStatus = !oauthEnabled;

    try {
      const response = await makeAdminApiCall('/admin/configs/platform');
      const platformConfig = response.data;

      const updatedConfig = {
        ...platformConfig,
        oauth: {
          ...(platformConfig.oauth || {}),
          enabled: {
            authz: newStatus,
            clients: platformConfig.oauth?.enabled?.clients ?? false
          },
          clientsFile: platformConfig.oauth?.clientsFile || 'contents/config/oauth-clients.json',
          defaultTokenExpirationMinutes: platformConfig.oauth?.defaultTokenExpirationMinutes || 60,
          maxTokenExpirationMinutes: platformConfig.oauth?.maxTokenExpirationMinutes || 1440
        }
      };

      await makeAdminApiCall('/admin/configs/platform', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(updatedConfig)
      });

      setOAuthEnabled(newStatus);
      setMessage({
        type: 'success',
        text: t(
          newStatus
            ? 'admin.auth.oauth.server.enabledSuccess'
            : 'admin.auth.oauth.server.disabledSuccess',
          `Authorization server ${newStatus ? 'enabled' : 'disabled'} successfully`
        )
      });

      await refreshConfig();
    } catch (error) {
      setMessage({
        type: 'error',
        text: `${t('admin.auth.oauth.server.toggleError', 'Failed to update authorization server')}: ${error.message}`
      });
    }
  };

  const handleSaveOAuthConfig = async () => {
    setSavingConfig(true);
    setMessage('');

    try {
      const response = await makeAdminApiCall('/admin/configs/platform');
      const currentPlatformConfig = response.data;

      const updatedConfig = {
        ...currentPlatformConfig,
        oauth: {
          ...currentPlatformConfig.oauth,
          issuer: oauthConfig.issuer,
          defaultTokenExpirationMinutes: oauthConfig.defaultTokenExpirationMinutes,
          maxTokenExpirationMinutes: oauthConfig.maxTokenExpirationMinutes,
          authorizationCodeEnabled: oauthConfig.authorizationCodeEnabled,
          authorizationCodeExpirationSeconds: oauthConfig.authorizationCodeExpirationSeconds,
          refreshTokenEnabled: oauthConfig.refreshTokenEnabled,
          refreshTokenExpirationDays: oauthConfig.refreshTokenExpirationDays,
          consentRequired: oauthConfig.consentRequired,
          consentMemoryDays: oauthConfig.consentMemoryDays
        }
      };

      await makeAdminApiCall('/admin/configs/platform', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(updatedConfig)
      });

      setMessage({
        type: 'success',
        text: t('admin.auth.oauth.configSaved', 'Authorization server settings saved successfully')
      });
      await refreshConfig();
    } catch (error) {
      setMessage({
        type: 'error',
        text: `${t('admin.auth.oauth.configSaveError', 'Failed to save authorization server settings')}: ${error.message}`
      });
    } finally {
      setSavingConfig(false);
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
        {/* Header */}
        <div className="bg-white dark:bg-gray-800 shadow-sm border-b border-gray-200 dark:border-gray-700">
          <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-6">
            <div>
              <button
                onClick={() => navigate('/admin/oauth')}
                className="inline-flex items-center text-sm text-gray-500 dark:text-gray-400 hover:text-gray-700 dark:hover:text-gray-200 mb-2"
              >
                <Icon name="chevron-left" size="sm" className="mr-1" />
                {t('admin.nav.oauth', 'OAuth')}
              </button>
              <h1 className="text-3xl font-bold text-gray-900 dark:text-gray-100">
                {t('admin.auth.oauth.server.title', 'Authorization Server')}
              </h1>
              <p className="text-gray-600 dark:text-gray-400 mt-1">
                {t(
                  'admin.auth.oauth.server.subtitle',
                  'Configure iHub as an OAuth 2.0 / OpenID Connect authorization server'
                )}
              </p>
            </div>
          </div>
        </div>

        {/* Content */}
        <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-8">
          {/* Enable/Disable Card */}
          <div className="bg-white dark:bg-gray-800 shadow rounded-lg p-6 mb-6">
            <div className="flex items-center justify-between">
              <div className="flex-1">
                <h3 className="text-lg font-medium text-gray-900 dark:text-gray-100">
                  {t('admin.auth.oauth.server.enable', 'OAuth 2.0 Authorization Server')}
                </h3>
                <p className="mt-1 text-sm text-gray-500 dark:text-gray-400">
                  {oauthEnabled
                    ? t(
                        'admin.auth.oauth.server.enabledDesc',
                        'The authorization server is active. Clients can obtain tokens and resource servers can validate them via JWKS.'
                      )
                    : t(
                        'admin.auth.oauth.server.disabledDesc',
                        'Enable the authorization server to allow external applications and resource servers to authenticate via OAuth 2.0.'
                      )}
                </p>
              </div>
              <button
                onClick={handleToggleOAuth}
                className={`relative inline-flex h-6 w-11 flex-shrink-0 cursor-pointer rounded-full border-2 border-transparent transition-colors duration-200 ease-in-out focus:outline-none focus:ring-2 focus:ring-blue-500 focus:ring-offset-2 ${
                  oauthEnabled ? 'bg-blue-600' : 'bg-gray-200 dark:bg-gray-600'
                }`}
              >
                <span className="sr-only">
                  {t('admin.auth.oauth.server.enable', 'OAuth 2.0 Authorization Server')}
                </span>
                <span
                  className={`pointer-events-none inline-block h-5 w-5 transform rounded-full bg-white shadow ring-0 transition duration-200 ease-in-out ${
                    oauthEnabled ? 'translate-x-5' : 'translate-x-0'
                  }`}
                />
              </button>
            </div>
          </div>

          {/* Message */}
          {message && (
            <div
              className={`mb-6 p-4 rounded-md ${
                message.type === 'success'
                  ? 'bg-green-50 dark:bg-green-900/30 border border-green-200 dark:border-green-800'
                  : message.type === 'warning'
                    ? 'bg-yellow-50 dark:bg-yellow-900/30 border border-yellow-200 dark:border-yellow-800'
                    : 'bg-red-50 dark:bg-red-900/30 border border-red-200 dark:border-red-800'
              }`}
            >
              <div className="flex">
                <Icon
                  name={message.type === 'success' ? 'check' : 'warning'}
                  size="md"
                  className={`mt-0.5 mr-3 ${
                    message.type === 'success'
                      ? 'text-green-500'
                      : message.type === 'warning'
                        ? 'text-yellow-500'
                        : 'text-red-500'
                  }`}
                />
                <p
                  className={`text-sm ${
                    message.type === 'success'
                      ? 'text-green-700 dark:text-green-300'
                      : message.type === 'warning'
                        ? 'text-yellow-700 dark:text-yellow-300'
                        : 'text-red-700 dark:text-red-300'
                  }`}
                >
                  {message.text}
                </p>
              </div>
            </div>
          )}

          {oauthEnabled && (
            <>
              {/* Public Key Downloads Card */}
              {jwtAlgorithm === 'RS256' && (
                <div className="bg-white dark:bg-gray-800 shadow rounded-lg p-6 mb-6">
                  <h3 className="text-lg font-medium text-gray-900 dark:text-gray-100 flex items-center">
                    <Icon name="key" size="md" className="mr-2" />
                    {t('admin.auth.oauth.publicKey', 'Public Key Downloads')}
                  </h3>
                  <p className="mt-1 text-sm text-gray-500 dark:text-gray-400">
                    {t(
                      'admin.auth.oauth.publicKeyDesc',
                      'Download the RSA public key for JWT verification in external services that cannot access the JWKS endpoint.'
                    )}
                  </p>
                  <div className="mt-4 space-y-3">
                    <div className="flex items-center justify-between bg-gray-50 dark:bg-gray-700/50 rounded-md px-4 py-3">
                      <div className="min-w-0 flex-1">
                        <p className="text-xs font-medium text-gray-500 dark:text-gray-400">
                          {t('admin.auth.oauth.pemFormat', 'PEM Format')}
                        </p>
                        <p className="text-sm text-gray-900 dark:text-gray-100 mt-1">
                          {t(
                            'admin.auth.oauth.pemFormatDesc',
                            'Standard PEM format for most applications'
                          )}
                        </p>
                      </div>
                      <a
                        href={`${getServerBaseUrl()}/api/admin/oauth/public-key/pem`}
                        download="jwt-public-key.pem"
                        className="ml-3 flex-shrink-0 inline-flex items-center px-3 py-2 border border-gray-300 dark:border-gray-600 text-sm font-medium rounded text-gray-700 dark:text-gray-200 bg-white dark:bg-gray-700 hover:bg-gray-50 dark:hover:bg-gray-600 focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-blue-500"
                      >
                        <Icon name="download" size="sm" className="mr-2" />
                        {t('admin.auth.oauth.downloadPem', 'Download PEM')}
                      </a>
                    </div>
                    <div className="flex items-center justify-between bg-gray-50 dark:bg-gray-700/50 rounded-md px-4 py-3">
                      <div className="min-w-0 flex-1">
                        <p className="text-xs font-medium text-gray-500 dark:text-gray-400">
                          {t('admin.auth.oauth.base64Format', 'Base64 Format')}
                        </p>
                        <p className="text-sm text-gray-900 dark:text-gray-100 mt-1">
                          {t(
                            'admin.auth.oauth.base64FormatDesc',
                            'Base64-encoded format for Spring Boot and similar configs'
                          )}
                        </p>
                      </div>
                      <a
                        href={`${getServerBaseUrl()}/api/admin/oauth/public-key/base64`}
                        download="jwt-public-key-base64.txt"
                        className="ml-3 flex-shrink-0 inline-flex items-center px-3 py-2 border border-gray-300 dark:border-gray-600 text-sm font-medium rounded text-gray-700 dark:text-gray-200 bg-white dark:bg-gray-700 hover:bg-gray-50 dark:hover:bg-gray-600 focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-blue-500"
                      >
                        <Icon name="download" size="sm" className="mr-2" />
                        {t('admin.auth.oauth.downloadBase64', 'Download Base64')}
                      </a>
                    </div>
                  </div>
                </div>
              )}

              {/* Endpoints & Discovery Card */}
              <div className="bg-white dark:bg-gray-800 shadow rounded-lg p-6 mb-6">
                <h3 className="text-lg font-medium text-gray-900 dark:text-gray-100 flex items-center">
                  <Icon name="link" size="md" className="mr-2" />
                  {t('admin.auth.oauth.endpoints', 'Endpoints & Discovery')}
                </h3>
                <p className="mt-1 text-sm text-gray-500 dark:text-gray-400">
                  {t(
                    'admin.auth.oauth.endpointsDesc',
                    'Public OAuth 2.0 and OpenID Connect endpoints for this server. Share these with resource servers and clients.'
                  )}
                </p>
                <div className="mt-4 space-y-3">
                  {[
                    {
                      label: t('admin.auth.oauth.openidConfig', 'OpenID Configuration'),
                      path: '/.well-known/openid-configuration'
                    },
                    {
                      label: t('admin.auth.oauth.jwksUrl', 'JWKS URL'),
                      path: '/.well-known/jwks.json'
                    },
                    {
                      label: t('admin.auth.oauth.tokenEndpoint', 'Token Endpoint'),
                      path: '/api/oauth/token'
                    },
                    {
                      label: t('admin.auth.oauth.authorizeEndpoint', 'Authorization Endpoint'),
                      path: '/api/oauth/authorize'
                    },
                    {
                      label: t('admin.auth.oauth.userinfoEndpoint', 'UserInfo Endpoint'),
                      path: '/api/oauth/userinfo'
                    }
                  ].map(endpoint => {
                    const url = `${getServerBaseUrl()}${endpoint.path}`;
                    return (
                      <div
                        key={endpoint.path}
                        className="flex items-center justify-between bg-gray-50 dark:bg-gray-700/50 rounded-md px-4 py-3"
                      >
                        <div className="min-w-0 flex-1">
                          <p className="text-xs font-medium text-gray-500 dark:text-gray-400">
                            {endpoint.label}
                          </p>
                          <code className="text-sm text-gray-900 dark:text-gray-100 break-all">
                            {url}
                          </code>
                        </div>
                        <button
                          onClick={() => copyToClipboard(url)}
                          className="ml-3 flex-shrink-0 inline-flex items-center px-2 py-1.5 border border-gray-300 dark:border-gray-600 text-xs font-medium rounded text-gray-700 dark:text-gray-200 bg-white dark:bg-gray-700 hover:bg-gray-50 dark:hover:bg-gray-600 focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-blue-500"
                          title={t('common.copyToClipboard', 'Copy to Clipboard')}
                        >
                          <Icon name="clipboard" size="sm" />
                        </button>
                      </div>
                    );
                  })}
                </div>
              </div>

              {/* Authorization Server Settings Card */}
              <div className="bg-white dark:bg-gray-800 shadow rounded-lg p-6 mb-6">
                <h3 className="text-lg font-medium text-gray-900 dark:text-gray-100 flex items-center">
                  <Icon name="settings" size="md" className="mr-2" />
                  {t('admin.auth.oauth.serverSettings', 'Authorization Server Settings')}
                </h3>

                <div className="space-y-6 mt-4">
                  {/* Issuer URL */}
                  <div>
                    <label className="block text-sm font-medium text-gray-700 dark:text-gray-300">
                      {t('admin.auth.oauth.issuer', 'Issuer URL')}
                    </label>
                    <input
                      type="text"
                      value={oauthConfig.issuer}
                      onChange={e => updateOAuthConfig('issuer', e.target.value)}
                      placeholder={t(
                        'admin.auth.oauth.issuerHint',
                        'Leave blank for auto-detection from server origin'
                      )}
                      className="mt-1 w-full rounded-md border-gray-300 dark:border-gray-600 shadow-sm bg-white dark:bg-gray-700 text-gray-900 dark:text-gray-100 focus:border-blue-500 focus:ring-blue-500 sm:text-sm"
                    />
                    <p className="mt-1 text-xs text-gray-500 dark:text-gray-400">
                      {t(
                        'admin.auth.oauth.issuerHint',
                        'Leave blank for auto-detection from server origin'
                      )}
                    </p>
                  </div>

                  {/* Token Expiration */}
                  <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                    <div>
                      <label className="block text-sm font-medium text-gray-700 dark:text-gray-300">
                        {t(
                          'admin.auth.oauth.defaultTokenExp',
                          'Default Token Expiration (minutes)'
                        )}
                      </label>
                      <input
                        type="number"
                        min={1}
                        max={oauthConfig.maxTokenExpirationMinutes}
                        value={oauthConfig.defaultTokenExpirationMinutes}
                        onChange={e =>
                          updateOAuthConfig('defaultTokenExpirationMinutes', Number(e.target.value))
                        }
                        className="mt-1 w-full rounded-md border-gray-300 dark:border-gray-600 shadow-sm bg-white dark:bg-gray-700 text-gray-900 dark:text-gray-100 focus:border-blue-500 focus:ring-blue-500 sm:text-sm"
                      />
                    </div>
                    <div>
                      <label className="block text-sm font-medium text-gray-700 dark:text-gray-300">
                        {t('admin.auth.oauth.maxTokenExp', 'Max Token Expiration (minutes)')}
                      </label>
                      <input
                        type="number"
                        min={1}
                        value={oauthConfig.maxTokenExpirationMinutes}
                        onChange={e =>
                          updateOAuthConfig('maxTokenExpirationMinutes', Number(e.target.value))
                        }
                        className="mt-1 w-full rounded-md border-gray-300 dark:border-gray-600 shadow-sm bg-white dark:bg-gray-700 text-gray-900 dark:text-gray-100 focus:border-blue-500 focus:ring-blue-500 sm:text-sm"
                      />
                    </div>
                  </div>

                  {/* Authorization Code Flow */}
                  <div className="flex items-center justify-between">
                    <div>
                      <label className="text-sm font-medium text-gray-700 dark:text-gray-300">
                        {t('admin.auth.oauth.authCodeFlow', 'Authorization Code Flow')}
                      </label>
                      <p className="text-sm text-gray-500 dark:text-gray-400">
                        {t(
                          'admin.auth.oauth.authCodeFlowDesc',
                          'Enable OAuth 2.0 authorization code grant type for user delegation'
                        )}
                      </p>
                    </div>
                    <button
                      onClick={() =>
                        updateOAuthConfig(
                          'authorizationCodeEnabled',
                          !oauthConfig.authorizationCodeEnabled
                        )
                      }
                      className={`relative inline-flex h-6 w-11 flex-shrink-0 cursor-pointer rounded-full border-2 border-transparent transition-colors duration-200 ease-in-out focus:outline-none focus:ring-2 focus:ring-blue-500 focus:ring-offset-2 ${
                        oauthConfig.authorizationCodeEnabled
                          ? 'bg-blue-600'
                          : 'bg-gray-200 dark:bg-gray-600'
                      }`}
                    >
                      <span className="sr-only">
                        {t('admin.auth.oauth.authCodeFlow', 'Authorization Code Flow')}
                      </span>
                      <span
                        className={`pointer-events-none inline-block h-5 w-5 transform rounded-full bg-white shadow ring-0 transition duration-200 ease-in-out ${
                          oauthConfig.authorizationCodeEnabled ? 'translate-x-5' : 'translate-x-0'
                        }`}
                      />
                    </button>
                  </div>

                  {/* Auth Code sub-settings */}
                  {oauthConfig.authorizationCodeEnabled && (
                    <div className="ml-4 pl-4 border-l-2 border-gray-200 dark:border-gray-600 space-y-4">
                      <div>
                        <label className="block text-sm font-medium text-gray-700 dark:text-gray-300">
                          {t(
                            'admin.auth.oauth.authCodeExp',
                            'Authorization Code Expiration (seconds)'
                          )}
                        </label>
                        <input
                          type="number"
                          min={30}
                          max={3600}
                          value={oauthConfig.authorizationCodeExpirationSeconds}
                          onChange={e =>
                            updateOAuthConfig(
                              'authorizationCodeExpirationSeconds',
                              Number(e.target.value)
                            )
                          }
                          className="mt-1 w-full sm:w-48 rounded-md border-gray-300 dark:border-gray-600 shadow-sm bg-white dark:bg-gray-700 text-gray-900 dark:text-gray-100 focus:border-blue-500 focus:ring-blue-500 sm:text-sm"
                        />
                      </div>

                      {/* Consent Required */}
                      <div className="flex items-center justify-between">
                        <div>
                          <label className="text-sm font-medium text-gray-700 dark:text-gray-300">
                            {t('admin.auth.oauth.consentRequired', 'Consent Required')}
                          </label>
                          <p className="text-sm text-gray-500 dark:text-gray-400">
                            {t(
                              'admin.auth.oauth.consentRequiredDesc',
                              'Require user consent before granting access to clients'
                            )}
                          </p>
                        </div>
                        <button
                          onClick={() =>
                            updateOAuthConfig('consentRequired', !oauthConfig.consentRequired)
                          }
                          className={`relative inline-flex h-6 w-11 flex-shrink-0 cursor-pointer rounded-full border-2 border-transparent transition-colors duration-200 ease-in-out focus:outline-none focus:ring-2 focus:ring-blue-500 focus:ring-offset-2 ${
                            oauthConfig.consentRequired
                              ? 'bg-blue-600'
                              : 'bg-gray-200 dark:bg-gray-600'
                          }`}
                        >
                          <span className="sr-only">
                            {t('admin.auth.oauth.consentRequired', 'Consent Required')}
                          </span>
                          <span
                            className={`pointer-events-none inline-block h-5 w-5 transform rounded-full bg-white shadow ring-0 transition duration-200 ease-in-out ${
                              oauthConfig.consentRequired ? 'translate-x-5' : 'translate-x-0'
                            }`}
                          />
                        </button>
                      </div>

                      {/* Consent Memory */}
                      {oauthConfig.consentRequired && (
                        <div>
                          <label className="block text-sm font-medium text-gray-700 dark:text-gray-300">
                            {t('admin.auth.oauth.consentMemory', 'Consent Memory (days)')}
                          </label>
                          <input
                            type="number"
                            min={1}
                            max={365}
                            value={oauthConfig.consentMemoryDays}
                            onChange={e =>
                              updateOAuthConfig('consentMemoryDays', Number(e.target.value))
                            }
                            className="mt-1 w-full sm:w-48 rounded-md border-gray-300 dark:border-gray-600 shadow-sm bg-white dark:bg-gray-700 text-gray-900 dark:text-gray-100 focus:border-blue-500 focus:ring-blue-500 sm:text-sm"
                          />
                          <p className="mt-1 text-xs text-gray-500 dark:text-gray-400">
                            {t(
                              'admin.auth.oauth.consentMemoryHint',
                              'How long to remember user consent before asking again'
                            )}
                          </p>
                        </div>
                      )}
                    </div>
                  )}

                  {/* Refresh Tokens */}
                  <div className="flex items-center justify-between">
                    <div>
                      <label className="text-sm font-medium text-gray-700 dark:text-gray-300">
                        {t('admin.auth.oauth.refreshToken', 'Refresh Tokens')}
                      </label>
                      <p className="text-sm text-gray-500 dark:text-gray-400">
                        {t(
                          'admin.auth.oauth.refreshTokenDesc',
                          'Enable refresh token issuance for token rotation'
                        )}
                      </p>
                    </div>
                    <button
                      onClick={() =>
                        updateOAuthConfig('refreshTokenEnabled', !oauthConfig.refreshTokenEnabled)
                      }
                      className={`relative inline-flex h-6 w-11 flex-shrink-0 cursor-pointer rounded-full border-2 border-transparent transition-colors duration-200 ease-in-out focus:outline-none focus:ring-2 focus:ring-blue-500 focus:ring-offset-2 ${
                        oauthConfig.refreshTokenEnabled
                          ? 'bg-blue-600'
                          : 'bg-gray-200 dark:bg-gray-600'
                      }`}
                    >
                      <span className="sr-only">
                        {t('admin.auth.oauth.refreshToken', 'Refresh Tokens')}
                      </span>
                      <span
                        className={`pointer-events-none inline-block h-5 w-5 transform rounded-full bg-white shadow ring-0 transition duration-200 ease-in-out ${
                          oauthConfig.refreshTokenEnabled ? 'translate-x-5' : 'translate-x-0'
                        }`}
                      />
                    </button>
                  </div>

                  {/* Refresh Token sub-settings */}
                  {oauthConfig.refreshTokenEnabled && (
                    <div className="ml-4 pl-4 border-l-2 border-gray-200 dark:border-gray-600">
                      <label className="block text-sm font-medium text-gray-700 dark:text-gray-300">
                        {t('admin.auth.oauth.refreshTokenExp', 'Refresh Token Expiration (days)')}
                      </label>
                      <input
                        type="number"
                        min={1}
                        max={365}
                        value={oauthConfig.refreshTokenExpirationDays}
                        onChange={e =>
                          updateOAuthConfig('refreshTokenExpirationDays', Number(e.target.value))
                        }
                        className="mt-1 w-full sm:w-48 rounded-md border-gray-300 dark:border-gray-600 shadow-sm bg-white dark:bg-gray-700 text-gray-900 dark:text-gray-100 focus:border-blue-500 focus:ring-blue-500 sm:text-sm"
                      />
                    </div>
                  )}

                  {/* JWT Algorithm (read-only) */}
                  <div className="flex items-center justify-between py-3 border-t border-gray-200 dark:border-gray-700">
                    <div>
                      <label className="text-sm font-medium text-gray-700 dark:text-gray-300">
                        {t('admin.auth.oauth.jwtAlgorithm', 'JWT Signing Algorithm')}
                      </label>
                      <p className="text-xs text-gray-500 dark:text-gray-400">
                        {t(
                          'admin.auth.oauth.jwtAlgorithmHint',
                          'Configured in server JWT settings. RS256 enables JWKS public key sharing.'
                        )}
                      </p>
                    </div>
                    <span className="inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-medium bg-gray-100 dark:bg-gray-700 text-gray-800 dark:text-gray-200">
                      {jwtAlgorithm}
                    </span>
                  </div>

                  {/* Save Button */}
                  <div className="flex justify-end pt-4 border-t border-gray-200 dark:border-gray-700">
                    <button
                      onClick={handleSaveOAuthConfig}
                      disabled={savingConfig}
                      className="inline-flex items-center px-4 py-2 border border-transparent text-sm font-medium rounded-md shadow-sm text-white bg-blue-600 hover:bg-blue-700 focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-blue-500 disabled:opacity-50 disabled:cursor-not-allowed"
                    >
                      {savingConfig ? (
                        <>
                          <LoadingSpinner size="sm" className="mr-2" />
                          {t('admin.auth.oauth.savingSettings', 'Saving...')}
                        </>
                      ) : (
                        t('admin.auth.oauth.saveSettings', 'Save Settings')
                      )}
                    </button>
                  </div>
                </div>
              </div>
            </>
          )}
        </div>
      </div>
    </AdminAuth>
  );
}

export default AdminOAuthServerPage;
