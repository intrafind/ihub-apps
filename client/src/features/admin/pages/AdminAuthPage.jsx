import React, { useState, useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import Icon from '../../../shared/components/Icon';
import AdminAuth from '../components/AdminAuth';
import AdminNavigation from '../components/AdminNavigation';
import { makeAdminApiCall } from '../../../api/adminApi';
import LoadingSpinner from '../../../shared/components/LoadingSpinner';
import { usePlatformConfig } from '../../../shared/contexts/PlatformConfigContext';

const AdminAuthPage = () => {
  const { t } = useTranslation();
  const { refreshConfig } = usePlatformConfig();
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState('');
  const [config, setConfig] = useState({
    auth: {
      mode: 'proxy',
      allowAnonymous: true,
      anonymousGroup: 'anonymous',
      authenticatedGroup: 'authenticated'
    },
    proxyAuth: {
      enabled: false,
      userHeader: 'X-Forwarded-User',
      groupsHeader: 'X-Forwarded-Groups',
      anonymousGroup: 'anonymous',
      jwtProviders: []
    },
    localAuth: {
      enabled: false,
      usersFile: 'contents/config/users.json',
      sessionTimeoutMinutes: 480,
      jwtSecret: '$' + '{JWT_SECRET}',
      showDemoAccounts: true
    },
    oidcAuth: {
      enabled: false,
      providers: []
    },
    authorization: {
      adminGroups: ['admin', 'IT-Admin', 'Platform-Admin'],
      userGroups: ['user', 'users'],
      anonymousAccess: true,
      defaultGroup: 'anonymous'
    }
  });

  useEffect(() => {
    loadConfiguration();
  }, []);

  const loadConfiguration = async () => {
    try {
      const response = await makeAdminApiCall('/api/admin/configs/platform');
      const data = await response.json();
      
      setConfig(prevConfig => ({
        ...prevConfig,
        ...data
      }));
    } catch (error) {
      setMessage({
        type: 'error',
        text: `Failed to load configuration: ${error.message}`
      });
    } finally {
      setLoading(false);
    }
  };

  const handleSave = async () => {
    setSaving(true);
    setMessage('');

    try {
      const response = await makeAdminApiCall('/api/admin/configs/platform', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json'
        },
        body: JSON.stringify(config)
      });

      if (response.ok) {
        setMessage({
          type: 'success',
          text: 'Authentication configuration saved successfully!'
        });
        // Refresh the platform config context to update navigation
        refreshConfig();
      } else {
        throw new Error('Failed to save configuration');
      }
    } catch (error) {
      setMessage({
        type: 'error',
        text: `Failed to save configuration: ${error.message}`
      });
    } finally {
      setSaving(false);
    }
  };

  const updateAuthMode = (mode) => {
    setConfig(prev => ({
      ...prev,
      auth: {
        ...prev.auth,
        mode
      },
      proxyAuth: {
        ...prev.proxyAuth,
        enabled: mode === 'proxy'
      },
      localAuth: {
        ...prev.localAuth,
        enabled: mode === 'local'
      },
      oidcAuth: {
        ...prev.oidcAuth,
        enabled: mode === 'oidc'
      }
    }));
  };

  const updateNestedConfig = (section, field, value) => {
    setConfig(prev => ({
      ...prev,
      [section]: {
        ...prev[section],
        [field]: value
      }
    }));
  };

  const addOidcProvider = () => {
    const newProvider = {
      name: '',
      displayName: '',
      clientId: '',
      clientSecret: '',
      authorizationURL: '',
      tokenURL: '',
      userInfoURL: '',
      scope: ['openid', 'profile', 'email'],
      callbackURL: '',
      groupsAttribute: 'groups',
      defaultGroups: [],
      pkce: true
    };

    setConfig(prev => ({
      ...prev,
      oidcAuth: {
        ...prev.oidcAuth,
        providers: [...prev.oidcAuth.providers, newProvider]
      }
    }));
  };

  const updateOidcProvider = (index, field, value) => {
    setConfig(prev => ({
      ...prev,
      oidcAuth: {
        ...prev.oidcAuth,
        providers: prev.oidcAuth.providers.map((provider, i) =>
          i === index ? { ...provider, [field]: value } : provider
        )
      }
    }));
  };

  const removeOidcProvider = (index) => {
    setConfig(prev => ({
      ...prev,
      oidcAuth: {
        ...prev.oidcAuth,
        providers: prev.oidcAuth.providers.filter((_, i) => i !== index)
      }
    }));
  };

  const addJwtProvider = () => {
    const newProvider = {
      name: '',
      header: 'Authorization',
      issuer: '',
      audience: '',
      jwkUrl: ''
    };

    setConfig(prev => ({
      ...prev,
      proxyAuth: {
        ...prev.proxyAuth,
        jwtProviders: [...prev.proxyAuth.jwtProviders, newProvider]
      }
    }));
  };

  const updateJwtProvider = (index, field, value) => {
    setConfig(prev => ({
      ...prev,
      proxyAuth: {
        ...prev.proxyAuth,
        jwtProviders: prev.proxyAuth.jwtProviders.map((provider, i) =>
          i === index ? { ...provider, [field]: value } : provider
        )
      }
    }));
  };

  const removeJwtProvider = (index) => {
    setConfig(prev => ({
      ...prev,
      proxyAuth: {
        ...prev.proxyAuth,
        jwtProviders: prev.proxyAuth.jwtProviders.filter((_, i) => i !== index)
      }
    }));
  };

  if (loading) {
    return (
      <AdminAuth>
        <AdminNavigation />
        <div className="min-h-screen bg-gray-50 flex items-center justify-center">
          <LoadingSpinner size="lg" />
        </div>
      </AdminAuth>
    );
  }

  return (
    <AdminAuth>
      <AdminNavigation />
      <div className="min-h-screen bg-gray-50">
        {/* Header */}
        <div className="bg-white shadow-sm border-b border-gray-200">
          <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-6">
            <div className="flex justify-between items-center">
              <div>
                <h1 className="text-3xl font-bold text-gray-900">
                  Authentication Configuration
                </h1>
                <p className="text-gray-600 mt-1">
                  Configure authentication modes and user access settings
                </p>
              </div>
              <button
                onClick={handleSave}
                disabled={saving}
                className="inline-flex items-center px-4 py-2 border border-transparent text-sm font-medium rounded-md shadow-sm text-white bg-blue-600 hover:bg-blue-700 focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-blue-500 disabled:bg-gray-400 disabled:cursor-not-allowed"
              >
                {saving ? (
                  <>
                    <LoadingSpinner size="sm" className="mr-2" />
                    Saving...
                  </>
                ) : (
                  <>
                    <Icon name="save" size="md" className="mr-2" />
                    Save Configuration
                  </>
                )}
              </button>
            </div>
          </div>
        </div>

        {/* Content */}
        <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-8">
          {message && (
            <div
              className={`mb-6 p-4 rounded-md ${
                message.type === 'success'
                  ? 'bg-green-50 border border-green-200'
                  : 'bg-red-50 border border-red-200'
              }`}
            >
              <div className="flex">
                <Icon
                  name={message.type === 'success' ? 'check' : 'warning'}
                  size="md"
                  className={`mt-0.5 mr-3 ${
                    message.type === 'success' ? 'text-green-500' : 'text-red-500'
                  }`}
                />
                <p
                  className={`text-sm ${
                    message.type === 'success' ? 'text-green-700' : 'text-red-700'
                  }`}
                >
                  {message.text}
                </p>
              </div>
            </div>
          )}

          <div className="space-y-8">
            {/* Authentication Mode Selection */}
            <div className="bg-white rounded-lg shadow-sm border border-gray-200 p-6">
              <h3 className="text-lg font-semibold text-gray-900 mb-4">
                Authentication Mode
              </h3>
              <div className="space-y-4">
                <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-4">
                  {[
                    { mode: 'proxy', title: 'Proxy Mode', desc: 'Authentication via reverse proxy or external service' },
                    { mode: 'local', title: 'Local Mode', desc: 'Built-in username/password authentication' },
                    { mode: 'oidc', title: 'OIDC Mode', desc: 'OpenID Connect with external providers' },
                    { mode: 'anonymous', title: 'Anonymous Mode', desc: 'No authentication required (default)' }
                  ].map((modeOption) => (
                    <div
                      key={modeOption.mode}
                      className={`p-4 border-2 rounded-lg cursor-pointer transition-colors ${
                        config.auth.mode === modeOption.mode
                          ? 'border-blue-500 bg-blue-50'
                          : 'border-gray-200 hover:border-gray-300'
                      }`}
                      onClick={() => updateAuthMode(modeOption.mode)}
                    >
                      <div className="flex items-center mb-2">
                        <input
                          type="radio"
                          checked={config.auth.mode === modeOption.mode}
                          onChange={() => updateAuthMode(modeOption.mode)}
                          className="mr-2"
                        />
                        <h4 className="font-medium text-gray-900">{modeOption.title}</h4>
                      </div>
                      <p className="text-sm text-gray-600">{modeOption.desc}</p>
                    </div>
                  ))}
                </div>
              </div>
            </div>

            {/* General Authentication Settings */}
            <div className="bg-white rounded-lg shadow-sm border border-gray-200 p-6">
              <h3 className="text-lg font-semibold text-gray-900 mb-4">
                General Settings
              </h3>
              <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
                <div>
                  <label className="flex items-center">
                    <input
                      type="checkbox"
                      checked={config.auth.allowAnonymous}
                      onChange={(e) => updateNestedConfig('auth', 'allowAnonymous', e.target.checked)}
                      className="mr-2"
                    />
                    <span className="text-sm font-medium text-gray-700">Allow Anonymous Access</span>
                  </label>
                  <p className="text-xs text-gray-500 mt-1">Allow users to access the application without authentication</p>
                </div>
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1">
                    Anonymous Group
                  </label>
                  <input
                    type="text"
                    value={config.auth.anonymousGroup}
                    onChange={(e) => updateNestedConfig('auth', 'anonymousGroup', e.target.value)}
                    className="w-full px-3 py-2 border border-gray-300 rounded-md shadow-sm focus:ring-blue-500 focus:border-blue-500 sm:text-sm"
                    placeholder="anonymous"
                  />
                </div>
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1">
                    Authenticated Group
                  </label>
                  <input
                    type="text"
                    value={config.auth.authenticatedGroup}
                    onChange={(e) => updateNestedConfig('auth', 'authenticatedGroup', e.target.value)}
                    className="w-full px-3 py-2 border border-gray-300 rounded-md shadow-sm focus:ring-blue-500 focus:border-blue-500 sm:text-sm"
                    placeholder="authenticated"
                  />
                </div>
              </div>
            </div>

            {/* Proxy Auth Configuration */}
            {config.auth.mode === 'proxy' && (
              <div className="bg-white rounded-lg shadow-sm border border-gray-200 p-6">
                <h3 className="text-lg font-semibold text-gray-900 mb-4">
                  Proxy Authentication Settings
                </h3>
                <div className="space-y-4">
                  <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                    <div>
                      <label className="block text-sm font-medium text-gray-700 mb-1">
                        User Header
                      </label>
                      <input
                        type="text"
                        value={config.proxyAuth.userHeader}
                        onChange={(e) => updateNestedConfig('proxyAuth', 'userHeader', e.target.value)}
                        className="w-full px-3 py-2 border border-gray-300 rounded-md shadow-sm focus:ring-blue-500 focus:border-blue-500 sm:text-sm"
                        placeholder="X-Forwarded-User"
                      />
                    </div>
                    <div>
                      <label className="block text-sm font-medium text-gray-700 mb-1">
                        Groups Header
                      </label>
                      <input
                        type="text"
                        value={config.proxyAuth.groupsHeader}
                        onChange={(e) => updateNestedConfig('proxyAuth', 'groupsHeader', e.target.value)}
                        className="w-full px-3 py-2 border border-gray-300 rounded-md shadow-sm focus:ring-blue-500 focus:border-blue-500 sm:text-sm"
                        placeholder="X-Forwarded-Groups"
                      />
                    </div>
                  </div>

                  {/* JWT Providers */}
                  <div>
                    <div className="flex justify-between items-center mb-4">
                      <h4 className="text-md font-medium text-gray-900">JWT Providers</h4>
                      <button
                        onClick={addJwtProvider}
                        className="inline-flex items-center px-3 py-1 border border-transparent text-sm font-medium rounded-md text-blue-700 bg-blue-100 hover:bg-blue-200"
                      >
                        <Icon name="plus" size="sm" className="mr-1" />
                        Add Provider
                      </button>
                    </div>
                    {config.proxyAuth.jwtProviders.map((provider, index) => (
                      <div key={index} className="p-4 border border-gray-200 rounded-md mb-4">
                        <div className="flex justify-between items-start mb-3">
                          <h5 className="font-medium text-gray-900">JWT Provider {index + 1}</h5>
                          <button
                            onClick={() => removeJwtProvider(index)}
                            className="text-red-600 hover:text-red-800"
                          >
                            <Icon name="trash" size="sm" />
                          </button>
                        </div>
                        <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                          <input
                            type="text"
                            placeholder="Provider name"
                            value={provider.name}
                            onChange={(e) => updateJwtProvider(index, 'name', e.target.value)}
                            className="px-3 py-2 border border-gray-300 rounded-md shadow-sm focus:ring-blue-500 focus:border-blue-500 sm:text-sm"
                          />
                          <input
                            type="text"
                            placeholder="Header name"
                            value={provider.header}
                            onChange={(e) => updateJwtProvider(index, 'header', e.target.value)}
                            className="px-3 py-2 border border-gray-300 rounded-md shadow-sm focus:ring-blue-500 focus:border-blue-500 sm:text-sm"
                          />
                          <input
                            type="text"
                            placeholder="Issuer URL"
                            value={provider.issuer}
                            onChange={(e) => updateJwtProvider(index, 'issuer', e.target.value)}
                            className="px-3 py-2 border border-gray-300 rounded-md shadow-sm focus:ring-blue-500 focus:border-blue-500 sm:text-sm"
                          />
                          <input
                            type="text"
                            placeholder="Audience"
                            value={provider.audience}
                            onChange={(e) => updateJwtProvider(index, 'audience', e.target.value)}
                            className="px-3 py-2 border border-gray-300 rounded-md shadow-sm focus:ring-blue-500 focus:border-blue-500 sm:text-sm"
                          />
                          <input
                            type="text"
                            placeholder="JWK URL"
                            value={provider.jwkUrl}
                            onChange={(e) => updateJwtProvider(index, 'jwkUrl', e.target.value)}
                            className="px-3 py-2 border border-gray-300 rounded-md shadow-sm focus:ring-blue-500 focus:border-blue-500 sm:text-sm md:col-span-2"
                          />
                        </div>
                      </div>
                    ))}
                  </div>
                </div>
              </div>
            )}

            {/* Local Auth Configuration */}
            {config.auth.mode === 'local' && (
              <div className="bg-white rounded-lg shadow-sm border border-gray-200 p-6">
                <h3 className="text-lg font-semibold text-gray-900 mb-4">
                  Local Authentication Settings
                </h3>
                <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                  <div>
                    <label className="block text-sm font-medium text-gray-700 mb-1">
                      Users File Path
                    </label>
                    <input
                      type="text"
                      value={config.localAuth.usersFile}
                      onChange={(e) => updateNestedConfig('localAuth', 'usersFile', e.target.value)}
                      className="w-full px-3 py-2 border border-gray-300 rounded-md shadow-sm focus:ring-blue-500 focus:border-blue-500 sm:text-sm"
                      placeholder="contents/config/users.json"
                    />
                  </div>
                  <div>
                    <label className="block text-sm font-medium text-gray-700 mb-1">
                      Session Timeout (minutes)
                    </label>
                    <input
                      type="number"
                      value={config.localAuth.sessionTimeoutMinutes}
                      onChange={(e) => updateNestedConfig('localAuth', 'sessionTimeoutMinutes', parseInt(e.target.value))}
                      className="w-full px-3 py-2 border border-gray-300 rounded-md shadow-sm focus:ring-blue-500 focus:border-blue-500 sm:text-sm"
                      placeholder="480"
                    />
                  </div>
                  <div className="md:col-span-2">
                    <label className="block text-sm font-medium text-gray-700 mb-1">
                      JWT Secret
                    </label>
                    <input
                      type="text"
                      value={config.localAuth.jwtSecret}
                      onChange={(e) => updateNestedConfig('localAuth', 'jwtSecret', e.target.value)}
                      className="w-full px-3 py-2 border border-gray-300 rounded-md shadow-sm focus:ring-blue-500 focus:border-blue-500 sm:text-sm"
                      placeholder="$&#123;JWT_SECRET&#125;"
                    />
                    <p className="text-xs text-gray-500 mt-1">Use environment variable $&#123;JWT_SECRET&#125; for security</p>
                  </div>
                  <div className="md:col-span-2">
                    <label className="flex items-center">
                      <input
                        type="checkbox"
                        checked={config.localAuth.showDemoAccounts}
                        onChange={(e) => updateNestedConfig('localAuth', 'showDemoAccounts', e.target.checked)}
                        className="mr-2"
                      />
                      <span className="text-sm font-medium text-gray-700">Show Demo Accounts in Login Form</span>
                    </label>
                    <p className="text-xs text-gray-500 mt-1">Display demo account credentials on the login form for development/testing</p>
                  </div>
                </div>
              </div>
            )}

            {/* OIDC Configuration */}
            {config.auth.mode === 'oidc' && (
              <div className="bg-white rounded-lg shadow-sm border border-gray-200 p-6">
                <div className="flex justify-between items-center mb-4">
                  <h3 className="text-lg font-semibold text-gray-900">
                    OIDC Authentication Settings
                  </h3>
                  <button
                    onClick={addOidcProvider}
                    className="inline-flex items-center px-4 py-2 border border-transparent text-sm font-medium rounded-md text-blue-700 bg-blue-100 hover:bg-blue-200"
                  >
                    <Icon name="plus" size="sm" className="mr-2" />
                    Add OIDC Provider
                  </button>
                </div>

                {config.oidcAuth.providers.length === 0 ? (
                  <div className="text-center py-8 text-gray-500">
                    <Icon name="key" size="lg" className="mx-auto mb-4 text-gray-400" />
                    <p>No OIDC providers configured</p>
                    <p className="text-sm">Add a provider to enable OIDC authentication</p>
                  </div>
                ) : (
                  <div className="space-y-6">
                    {config.oidcAuth.providers.map((provider, index) => (
                      <div key={index} className="p-6 border border-gray-200 rounded-md">
                        <div className="flex justify-between items-start mb-4">
                          <h4 className="text-md font-medium text-gray-900">
                            {provider.displayName || provider.name || `Provider ${index + 1}`}
                          </h4>
                          <button
                            onClick={() => removeOidcProvider(index)}
                            className="text-red-600 hover:text-red-800"
                          >
                            <Icon name="trash" size="sm" />
                          </button>
                        </div>
                        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                          <div>
                            <label className="block text-sm font-medium text-gray-700 mb-1">
                              Provider Name
                            </label>
                            <input
                              type="text"
                              placeholder="google"
                              value={provider.name}
                              onChange={(e) => updateOidcProvider(index, 'name', e.target.value)}
                              className="w-full px-3 py-2 border border-gray-300 rounded-md shadow-sm focus:ring-blue-500 focus:border-blue-500 sm:text-sm"
                            />
                          </div>
                          <div>
                            <label className="block text-sm font-medium text-gray-700 mb-1">
                              Display Name
                            </label>
                            <input
                              type="text"
                              placeholder="Google"
                              value={provider.displayName}
                              onChange={(e) => updateOidcProvider(index, 'displayName', e.target.value)}
                              className="w-full px-3 py-2 border border-gray-300 rounded-md shadow-sm focus:ring-blue-500 focus:border-blue-500 sm:text-sm"
                            />
                          </div>
                          <div>
                            <label className="block text-sm font-medium text-gray-700 mb-1">
                              Client ID
                            </label>
                            <input
                              type="text"
                              placeholder="$&#123;GOOGLE_CLIENT_ID&#125;"
                              value={provider.clientId}
                              onChange={(e) => updateOidcProvider(index, 'clientId', e.target.value)}
                              className="w-full px-3 py-2 border border-gray-300 rounded-md shadow-sm focus:ring-blue-500 focus:border-blue-500 sm:text-sm"
                            />
                          </div>
                          <div>
                            <label className="block text-sm font-medium text-gray-700 mb-1">
                              Client Secret
                            </label>
                            <input
                              type="password"
                              placeholder="$&#123;GOOGLE_CLIENT_SECRET&#125;"
                              value={provider.clientSecret}
                              onChange={(e) => updateOidcProvider(index, 'clientSecret', e.target.value)}
                              className="w-full px-3 py-2 border border-gray-300 rounded-md shadow-sm focus:ring-blue-500 focus:border-blue-500 sm:text-sm"
                            />
                          </div>
                          <div>
                            <label className="block text-sm font-medium text-gray-700 mb-1">
                              Authorization URL
                            </label>
                            <input
                              type="url"
                              placeholder="https://accounts.google.com/o/oauth2/v2/auth"
                              value={provider.authorizationURL}
                              onChange={(e) => updateOidcProvider(index, 'authorizationURL', e.target.value)}
                              className="w-full px-3 py-2 border border-gray-300 rounded-md shadow-sm focus:ring-blue-500 focus:border-blue-500 sm:text-sm"
                            />
                          </div>
                          <div>
                            <label className="block text-sm font-medium text-gray-700 mb-1">
                              Token URL
                            </label>
                            <input
                              type="url"
                              placeholder="https://www.googleapis.com/oauth2/v4/token"
                              value={provider.tokenURL}
                              onChange={(e) => updateOidcProvider(index, 'tokenURL', e.target.value)}
                              className="w-full px-3 py-2 border border-gray-300 rounded-md shadow-sm focus:ring-blue-500 focus:border-blue-500 sm:text-sm"
                            />
                          </div>
                          <div>
                            <label className="block text-sm font-medium text-gray-700 mb-1">
                              User Info URL
                            </label>
                            <input
                              type="url"
                              placeholder="https://www.googleapis.com/oauth2/v2/userinfo"
                              value={provider.userInfoURL}
                              onChange={(e) => updateOidcProvider(index, 'userInfoURL', e.target.value)}
                              className="w-full px-3 py-2 border border-gray-300 rounded-md shadow-sm focus:ring-blue-500 focus:border-blue-500 sm:text-sm"
                            />
                          </div>
                          <div>
                            <label className="block text-sm font-medium text-gray-700 mb-1">
                              Groups Attribute
                            </label>
                            <input
                              type="text"
                              placeholder="groups"
                              value={provider.groupsAttribute}
                              onChange={(e) => updateOidcProvider(index, 'groupsAttribute', e.target.value)}
                              className="w-full px-3 py-2 border border-gray-300 rounded-md shadow-sm focus:ring-blue-500 focus:border-blue-500 sm:text-sm"
                            />
                          </div>
                          <div className="md:col-span-2">
                            <label className="block text-sm font-medium text-gray-700 mb-1">
                              Scope (comma-separated)
                            </label>
                            <input
                              type="text"
                              placeholder="openid, profile, email"
                              value={provider.scope ? provider.scope.join(', ') : ''}
                              onChange={(e) => updateOidcProvider(index, 'scope', e.target.value.split(',').map(s => s.trim()))}
                              className="w-full px-3 py-2 border border-gray-300 rounded-md shadow-sm focus:ring-blue-500 focus:border-blue-500 sm:text-sm"
                            />
                          </div>
                          <div className="md:col-span-2">
                            <label className="block text-sm font-medium text-gray-700 mb-1">
                              Default Groups (comma-separated)
                            </label>
                            <input
                              type="text"
                              placeholder="google-users, external-users"
                              value={provider.defaultGroups ? provider.defaultGroups.join(', ') : ''}
                              onChange={(e) => updateOidcProvider(index, 'defaultGroups', e.target.value.split(',').map(s => s.trim()).filter(s => s))}
                              className="w-full px-3 py-2 border border-gray-300 rounded-md shadow-sm focus:ring-blue-500 focus:border-blue-500 sm:text-sm"
                            />
                          </div>
                          <div>
                            <label className="flex items-center">
                              <input
                                type="checkbox"
                                checked={provider.pkce}
                                onChange={(e) => updateOidcProvider(index, 'pkce', e.target.checked)}
                                className="mr-2"
                              />
                              <span className="text-sm font-medium text-gray-700">Enable PKCE</span>
                            </label>
                          </div>
                        </div>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            )}

            {/* Authorization Settings */}
            <div className="bg-white rounded-lg shadow-sm border border-gray-200 p-6">
              <h3 className="text-lg font-semibold text-gray-900 mb-4">
                Authorization Settings
              </h3>
              <div className="space-y-4">
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1">
                    Admin Groups (comma-separated)
                  </label>
                  <input
                    type="text"
                    value={config.authorization.adminGroups.join(', ')}
                    onChange={(e) => updateNestedConfig('authorization', 'adminGroups', e.target.value.split(',').map(s => s.trim()))}
                    className="w-full px-3 py-2 border border-gray-300 rounded-md shadow-sm focus:ring-blue-500 focus:border-blue-500 sm:text-sm"
                    placeholder="admin, IT-Admin, Platform-Admin"
                  />
                </div>
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1">
                    User Groups (comma-separated)
                  </label>
                  <input
                    type="text"
                    value={config.authorization.userGroups.join(', ')}
                    onChange={(e) => updateNestedConfig('authorization', 'userGroups', e.target.value.split(',').map(s => s.trim()))}
                    className="w-full px-3 py-2 border border-gray-300 rounded-md shadow-sm focus:ring-blue-500 focus:border-blue-500 sm:text-sm"
                    placeholder="user, users"
                  />
                </div>
                <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                  <div>
                    <label className="flex items-center">
                      <input
                        type="checkbox"
                        checked={config.authorization.anonymousAccess}
                        onChange={(e) => updateNestedConfig('authorization', 'anonymousAccess', e.target.checked)}
                        className="mr-2"
                      />
                      <span className="text-sm font-medium text-gray-700">Allow Anonymous Access</span>
                    </label>
                  </div>
                  <div>
                    <label className="block text-sm font-medium text-gray-700 mb-1">
                      Default Group
                    </label>
                    <input
                      type="text"
                      value={config.authorization.defaultGroup}
                      onChange={(e) => updateNestedConfig('authorization', 'defaultGroup', e.target.value)}
                      className="w-full px-3 py-2 border border-gray-300 rounded-md shadow-sm focus:ring-blue-500 focus:border-blue-500 sm:text-sm"
                      placeholder="anonymous"
                    />
                  </div>
                </div>
              </div>
            </div>
          </div>
        </div>
      </div>
    </AdminAuth>
  );
};

export default AdminAuthPage;