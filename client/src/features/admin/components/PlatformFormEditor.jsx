import { useState, useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import Icon from '../../../shared/components/Icon';

/**
 * PlatformFormEditor - Form-based editor for platform configuration
 */
const PlatformFormEditor = ({ value: config, onChange, onValidationChange }) => {
  const { t } = useTranslation();
  const [validationErrors, setValidationErrors] = useState({});

  // Validation function
  const validateConfig = configData => {
    const errors = {};

    // Basic validation
    if (!configData.auth?.mode) {
      errors['auth.mode'] = 'Authentication mode is required';
    }

    setValidationErrors(errors);

    const isValid = Object.keys(errors).length === 0;
    if (onValidationChange) {
      onValidationChange({
        isValid,
        errors: Object.entries(errors).map(([field, message]) => ({
          field,
          message,
          severity: 'error'
        }))
      });
    }

    return isValid;
  };

  // Validate on config changes
  useEffect(() => {
    if (config) {
      validateConfig(config);
    }
  }, [config]);

  const updateAuthMode = mode => {
    onChange({
      ...config,
      auth: {
        ...config.auth,
        mode
      }
    });
  };

  const toggleAuthMethod = (method, enabled) => {
    onChange({
      ...config,
      [method]: {
        ...config[method],
        enabled
      }
    });
  };

  const updateNestedConfig = (section, field, value) => {
    onChange({
      ...config,
      [section]: {
        ...config[section],
        [field]: value
      }
    });
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
      pkce: true,
      enabled: true
    };

    onChange({
      ...config,
      oidcAuth: {
        ...config.oidcAuth,
        providers: [...(config.oidcAuth?.providers || []), newProvider]
      }
    });
  };

  const updateOidcProvider = (index, field, value) => {
    const providers = [...(config.oidcAuth?.providers || [])];
    providers[index] = { ...providers[index], [field]: value };

    onChange({
      ...config,
      oidcAuth: {
        ...config.oidcAuth,
        providers
      }
    });
  };

  const removeOidcProvider = index => {
    const providers = [...(config.oidcAuth?.providers || [])];
    providers.splice(index, 1);

    onChange({
      ...config,
      oidcAuth: {
        ...config.oidcAuth,
        providers
      }
    });
  };

  const addJwtProvider = () => {
    const newProvider = {
      name: '',
      header: 'Authorization',
      issuer: '',
      audience: '',
      jwkUrl: ''
    };

    onChange({
      ...config,
      proxyAuth: {
        ...config.proxyAuth,
        jwtProviders: [...(config.proxyAuth?.jwtProviders || []), newProvider]
      }
    });
  };

  const updateJwtProvider = (index, field, value) => {
    const providers = [...(config.proxyAuth?.jwtProviders || [])];
    providers[index] = { ...providers[index], [field]: value };

    onChange({
      ...config,
      proxyAuth: {
        ...config.proxyAuth,
        jwtProviders: providers
      }
    });
  };

  const removeJwtProvider = index => {
    const providers = [...(config.proxyAuth?.jwtProviders || [])];
    providers.splice(index, 1);

    onChange({
      ...config,
      proxyAuth: {
        ...config.proxyAuth,
        jwtProviders: providers
      }
    });
  };

  const updateAuthDebugConfig = (field, value) => {
    onChange({
      ...config,
      authDebug: {
        ...config.authDebug,
        [field]: value
      }
    });
  };

  const updateAuthDebugProvider = (provider, field, value) => {
    onChange({
      ...config,
      authDebug: {
        ...config.authDebug,
        providers: {
          ...config.authDebug?.providers,
          [provider]: {
            ...config.authDebug?.providers?.[provider],
            [field]: value
          }
        }
      }
    });
  };

  if (!config) {
    return (
      <div className="p-8 text-center text-gray-500">
        <Icon name="exclamation-triangle" className="h-12 w-12 mx-auto mb-4 text-gray-400" />
        <p className="text-lg font-medium">
          {t('admin.auth.noConfigData', 'No configuration data available')}
        </p>
      </div>
    );
  }

  return (
    <div className="platform-form-editor space-y-8">
      {/* Primary Authentication Mode Selection */}
      <div className="bg-white rounded-lg shadow-sm border border-gray-200 p-6">
        <h3 className="text-lg font-semibold text-gray-900 mb-4">Primary Authentication Mode</h3>
        <p className="text-sm text-gray-600 mb-4">
          Select the primary authentication mode for default behavior and routing.
        </p>
        <div className="space-y-4">
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-4">
            {[
              {
                mode: 'proxy',
                title: 'Proxy Mode',
                desc: 'Authentication via reverse proxy or JWT tokens'
              },
              {
                mode: 'local',
                title: 'Local Mode',
                desc: 'Built-in username/password authentication'
              },
              {
                mode: 'oidc',
                title: 'OIDC Mode',
                desc: 'OpenID Connect with external providers'
              },
              {
                mode: 'anonymous',
                title: 'Anonymous Mode',
                desc: 'No authentication required (default)'
              }
            ].map(modeOption => (
              <div
                key={modeOption.mode}
                className={`p-4 border-2 rounded-lg cursor-pointer transition-colors ${
                  config.auth?.mode === modeOption.mode
                    ? 'border-blue-500 bg-blue-50'
                    : 'border-gray-200 hover:border-gray-300'
                }`}
                onClick={() => updateAuthMode(modeOption.mode)}
              >
                <div className="flex items-center mb-2">
                  <input
                    type="radio"
                    checked={config.auth?.mode === modeOption.mode}
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

      {/* Multiple Authentication Methods */}
      <div className="bg-white rounded-lg shadow-sm border border-gray-200 p-6">
        <h3 className="text-lg font-semibold text-gray-900 mb-4">
          {t('admin.auth.methods', 'Authentication Methods')}
        </h3>
        <p className="text-sm text-gray-600 mb-4">
          Enable multiple authentication methods simultaneously. Users can choose their preferred
          login method.
        </p>
        <div className="space-y-4">
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            <div className="flex items-start space-x-3">
              <div className="flex items-center h-5">
                <input
                  type="checkbox"
                  checked={config.proxyAuth?.enabled || false}
                  onChange={e => toggleAuthMethod('proxyAuth', e.target.checked)}
                  className="h-4 w-4 text-blue-600 focus:ring-blue-500 border-gray-300 rounded"
                />
              </div>
              <div className="flex-1">
                <label className="text-sm font-medium text-gray-900">
                  Proxy/JWT Authentication
                </label>
                <p className="text-xs text-gray-500">Headers or JWT tokens from reverse proxy</p>
              </div>
            </div>

            <div className="flex items-start space-x-3">
              <div className="flex items-center h-5">
                <input
                  type="checkbox"
                  checked={config.localAuth?.enabled || false}
                  onChange={e => toggleAuthMethod('localAuth', e.target.checked)}
                  className="h-4 w-4 text-blue-600 focus:ring-blue-500 border-gray-300 rounded"
                />
              </div>
              <div className="flex-1">
                <label className="text-sm font-medium text-gray-900">Local Authentication</label>
                <p className="text-xs text-gray-500">
                  {t('admin.auth.builtInSystem', 'Built-in username/password system')}
                </p>
              </div>
            </div>

            <div className="flex items-start space-x-3">
              <div className="flex items-center h-5">
                <input
                  type="checkbox"
                  checked={config.oidcAuth?.enabled || false}
                  onChange={e => toggleAuthMethod('oidcAuth', e.target.checked)}
                  className="h-4 w-4 text-blue-600 focus:ring-blue-500 border-gray-300 rounded"
                />
              </div>
              <div className="flex-1">
                <label className="text-sm font-medium text-gray-900">OIDC Authentication</label>
                <p className="text-xs text-gray-500">OpenID Connect providers (Google, etc.)</p>
              </div>
            </div>

            <div className="flex items-start space-x-3">
              <div className="flex items-center h-5">
                <input
                  type="checkbox"
                  checked={config.anonymousAuth?.enabled || false}
                  onChange={e => toggleAuthMethod('anonymousAuth', e.target.checked)}
                  className="h-4 w-4 text-blue-600 focus:ring-blue-500 border-gray-300 rounded"
                />
              </div>
              <div className="flex-1">
                <label className="text-sm font-medium text-gray-900">
                  {t('admin.auth.anonymousAccess', 'Anonymous Access')}
                </label>
                <p className="text-xs text-gray-500">
                  Allow users to access without authentication
                </p>
              </div>
            </div>
          </div>
        </div>
      </div>

      {/* General Authentication Settings */}
      <div className="bg-white rounded-lg shadow-sm border border-gray-200 p-6">
        <h3 className="text-lg font-semibold text-gray-900 mb-4">
          {t('admin.auth.defaultGroups', 'Default Groups')}
        </h3>
        <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">
              Authenticated Groups
            </label>
            <input
              type="text"
              value={config.auth?.authenticatedGroup || ''}
              onChange={e => updateNestedConfig('auth', 'authenticatedGroup', e.target.value)}
              className="w-full px-3 py-2 border border-gray-300 rounded-md shadow-sm focus:ring-blue-500 focus:border-blue-500 sm:text-sm"
              placeholder="authenticated"
            />
            <p className="text-xs text-gray-500 mt-1">
              Group automatically assigned to all authenticated users
            </p>
          </div>
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">Anonymous Groups</label>
            <input
              type="text"
              value={
                Array.isArray(config.anonymousAuth?.defaultGroups)
                  ? config.anonymousAuth.defaultGroups.join(', ')
                  : ''
              }
              onChange={e =>
                updateNestedConfig(
                  'anonymousAuth',
                  'defaultGroups',
                  e.target.value
                    .split(',')
                    .map(g => g.trim())
                    .filter(g => g)
                )
              }
              className="w-full px-3 py-2 border border-gray-300 rounded-md shadow-sm focus:ring-blue-500 focus:border-blue-500 sm:text-sm"
              placeholder="anonymous, guest"
            />
            <p className="text-xs text-gray-500 mt-1">
              Groups assigned to users who access without authentication (comma-separated)
            </p>
          </div>
        </div>
      </div>

      {/* Proxy Auth Configuration */}
      {config.proxyAuth?.enabled && (
        <div className="bg-white rounded-lg shadow-sm border border-gray-200 p-6">
          <h3 className="text-lg font-semibold text-gray-900 mb-4">
            Proxy/JWT Authentication Settings
          </h3>
          <p className="text-sm text-gray-600 mb-4">
            Configure header-based authentication from reverse proxy and/or JWT token validation for
            pure JWT authentication.
          </p>
          <div className="space-y-4">
            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">User Header</label>
                <input
                  type="text"
                  value={config.proxyAuth?.userHeader || ''}
                  onChange={e => updateNestedConfig('proxyAuth', 'userHeader', e.target.value)}
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
                  value={config.proxyAuth?.groupsHeader || ''}
                  onChange={e => updateNestedConfig('proxyAuth', 'groupsHeader', e.target.value)}
                  className="w-full px-3 py-2 border border-gray-300 rounded-md shadow-sm focus:ring-blue-500 focus:border-blue-500 sm:text-sm"
                  placeholder="X-Forwarded-Groups"
                />
              </div>
            </div>

            {/* Self-signup Setting */}
            <div>
              <label className="flex items-center">
                <input
                  type="checkbox"
                  checked={config.proxyAuth?.allowSelfSignup || false}
                  onChange={e =>
                    updateNestedConfig('proxyAuth', 'allowSelfSignup', e.target.checked)
                  }
                  className="mr-2"
                />
                <span className="text-sm font-medium text-gray-700">Allow Self-Signup</span>
              </label>
              <p className="text-xs text-gray-500 mt-1">
                Allow new users to register automatically through proxy authentication. If disabled,
                new users must be added manually by administrators.
              </p>
            </div>

            {/* JWT Providers */}
            <div>
              <div className="flex justify-between items-center mb-4">
                <div>
                  <h4 className="text-md font-medium text-gray-900">
                    {t('admin.auth.jwtProviders', 'JWT Providers')}
                  </h4>
                  <p className="text-xs text-gray-500">
                    Configure JWT token validation for pure JWT authentication (no headers required)
                  </p>
                </div>
                <button
                  type="button"
                  onClick={addJwtProvider}
                  className="inline-flex items-center px-3 py-1 border border-transparent text-sm font-medium rounded-md text-blue-700 bg-blue-100 hover:bg-blue-200"
                >
                  <Icon name="plus" size="sm" className="mr-1" />
                  Add Provider
                </button>
              </div>
              {(config.proxyAuth?.jwtProviders || []).map((provider, index) => (
                <div key={index} className="p-4 border border-gray-200 rounded-md mb-4">
                  <div className="flex justify-between items-start mb-3">
                    <h5 className="font-medium text-gray-900">JWT Provider {index + 1}</h5>
                    <button
                      type="button"
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
                      value={provider.name || ''}
                      onChange={e => updateJwtProvider(index, 'name', e.target.value)}
                      className="px-3 py-2 border border-gray-300 rounded-md shadow-sm focus:ring-blue-500 focus:border-blue-500 sm:text-sm"
                    />
                    <input
                      type="text"
                      placeholder="Header name"
                      value={provider.header || ''}
                      onChange={e => updateJwtProvider(index, 'header', e.target.value)}
                      className="px-3 py-2 border border-gray-300 rounded-md shadow-sm focus:ring-blue-500 focus:border-blue-500 sm:text-sm"
                    />
                    <input
                      type="text"
                      placeholder="Issuer URL"
                      value={provider.issuer || ''}
                      onChange={e => updateJwtProvider(index, 'issuer', e.target.value)}
                      className="px-3 py-2 border border-gray-300 rounded-md shadow-sm focus:ring-blue-500 focus:border-blue-500 sm:text-sm"
                    />
                    <input
                      type="text"
                      placeholder="Audience"
                      value={provider.audience || ''}
                      onChange={e => updateJwtProvider(index, 'audience', e.target.value)}
                      className="px-3 py-2 border border-gray-300 rounded-md shadow-sm focus:ring-blue-500 focus:border-blue-500 sm:text-sm"
                    />
                    <input
                      type="text"
                      placeholder="JWK URL"
                      value={provider.jwkUrl || ''}
                      onChange={e => updateJwtProvider(index, 'jwkUrl', e.target.value)}
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
      {config.localAuth?.enabled && (
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
                value={config.localAuth?.usersFile || ''}
                onChange={e => updateNestedConfig('localAuth', 'usersFile', e.target.value)}
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
                value={config.localAuth?.sessionTimeoutMinutes || ''}
                onChange={e =>
                  updateNestedConfig('localAuth', 'sessionTimeoutMinutes', parseInt(e.target.value))
                }
                className="w-full px-3 py-2 border border-gray-300 rounded-md shadow-sm focus:ring-blue-500 focus:border-blue-500 sm:text-sm"
                placeholder="480"
              />
            </div>
            <div className="md:col-span-2">
              <label className="block text-sm font-medium text-gray-700 mb-1">JWT Secret</label>
              <input
                type="text"
                value={config.localAuth?.jwtSecret || ''}
                onChange={e => updateNestedConfig('localAuth', 'jwtSecret', e.target.value)}
                className="w-full px-3 py-2 border border-gray-300 rounded-md shadow-sm focus:ring-blue-500 focus:border-blue-500 sm:text-sm"
                placeholder="${JWT_SECRET}"
              />
              <p className="text-xs text-gray-500 mt-1">
                Use environment variable ${'{JWT_SECRET}'} for security
              </p>
            </div>
            <div className="md:col-span-2">
              <label className="flex items-center">
                <input
                  type="checkbox"
                  checked={config.localAuth?.showDemoAccounts || false}
                  onChange={e =>
                    updateNestedConfig('localAuth', 'showDemoAccounts', e.target.checked)
                  }
                  className="mr-2"
                />
                <span className="text-sm font-medium text-gray-700">
                  Show Demo Accounts in Login Form
                </span>
              </label>
              <p className="text-xs text-gray-500 mt-1">
                Display demo account credentials on the login form for development/testing
              </p>
            </div>
          </div>
        </div>
      )}

      {/* OIDC Configuration */}
      {config.oidcAuth?.enabled && (
        <div className="bg-white rounded-lg shadow-sm border border-gray-200 p-6">
          <div className="flex justify-between items-center mb-4">
            <h3 className="text-lg font-semibold text-gray-900">OIDC Authentication Settings</h3>
            <button
              type="button"
              onClick={addOidcProvider}
              className="inline-flex items-center px-4 py-2 border border-transparent text-sm font-medium rounded-md text-blue-700 bg-blue-100 hover:bg-blue-200"
            >
              <Icon name="plus" size="sm" className="mr-2" />
              Add OIDC Provider
            </button>
          </div>

          {/* Self-signup Setting */}
          <div className="mb-6 p-4 bg-yellow-50 border-2 border-yellow-300 rounded-lg">
            <label className="flex items-center">
              <input
                type="checkbox"
                checked={config.oidcAuth?.allowSelfSignup || false}
                onChange={e => updateNestedConfig('oidcAuth', 'allowSelfSignup', e.target.checked)}
                className="mr-2"
              />
              <span className="text-sm font-medium text-gray-700">Allow Self-Signup</span>
            </label>
            <p className="text-xs text-gray-500 mt-1">
              Allow new users to register automatically through OIDC authentication. If disabled,
              new users must be added manually by administrators.
            </p>
          </div>

          {!config.oidcAuth?.providers || config.oidcAuth.providers.length === 0 ? (
            <div className="text-center py-8 text-gray-500">
              <Icon name="key" size="lg" className="mx-auto mb-4 text-gray-400" />
              <p>{t('admin.auth.noOidcProviders', 'No OIDC providers configured')}</p>
              <p className="text-sm">
                {t('admin.auth.addProvider', 'Add a provider to enable OIDC authentication')}
              </p>
            </div>
          ) : (
            <div className="space-y-6">
              {config.oidcAuth.providers.map((provider, index) => (
                <div key={index} className="p-6 border border-gray-200 rounded-md">
                  <div className="flex justify-between items-start mb-4">
                    <div className="flex items-center space-x-3">
                      <input
                        type="checkbox"
                        checked={provider.enabled !== false}
                        onChange={e => updateOidcProvider(index, 'enabled', e.target.checked)}
                        className="h-4 w-4 text-blue-600 focus:ring-blue-500 border-gray-300 rounded"
                      />
                      <h4 className="text-md font-medium text-gray-900">
                        {provider.displayName || provider.name || `Provider ${index + 1}`}
                      </h4>
                      {provider.enabled === false && (
                        <span className="inline-flex items-center px-2 py-0.5 rounded text-xs font-medium bg-gray-100 text-gray-800">
                          Disabled
                        </span>
                      )}
                    </div>
                    <button
                      type="button"
                      onClick={() => removeOidcProvider(index)}
                      className="text-red-600 hover:text-red-800"
                    >
                      <Icon name="trash" size="sm" />
                    </button>
                  </div>
                  <div
                    className={`grid grid-cols-1 md:grid-cols-2 gap-4 ${provider.enabled === false ? 'opacity-50 pointer-events-none' : ''}`}
                  >
                    <div>
                      <label className="block text-sm font-medium text-gray-700 mb-1">
                        Provider Name
                      </label>
                      <input
                        type="text"
                        placeholder="google"
                        value={provider.name || ''}
                        onChange={e => updateOidcProvider(index, 'name', e.target.value)}
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
                        value={provider.displayName || ''}
                        onChange={e => updateOidcProvider(index, 'displayName', e.target.value)}
                        className="w-full px-3 py-2 border border-gray-300 rounded-md shadow-sm focus:ring-blue-500 focus:border-blue-500 sm:text-sm"
                      />
                    </div>
                    <div>
                      <label className="block text-sm font-medium text-gray-700 mb-1">
                        Client ID
                      </label>
                      <input
                        type="text"
                        placeholder="${GOOGLE_CLIENT_ID}"
                        value={provider.clientId || ''}
                        onChange={e => updateOidcProvider(index, 'clientId', e.target.value)}
                        className="w-full px-3 py-2 border border-gray-300 rounded-md shadow-sm focus:ring-blue-500 focus:border-blue-500 sm:text-sm"
                      />
                    </div>
                    <div>
                      <label className="block text-sm font-medium text-gray-700 mb-1">
                        Client Secret
                      </label>
                      <input
                        type="password"
                        placeholder="${GOOGLE_CLIENT_SECRET}"
                        value={provider.clientSecret || ''}
                        onChange={e => updateOidcProvider(index, 'clientSecret', e.target.value)}
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
                        value={provider.authorizationURL || ''}
                        onChange={e =>
                          updateOidcProvider(index, 'authorizationURL', e.target.value)
                        }
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
                        value={provider.tokenURL || ''}
                        onChange={e => updateOidcProvider(index, 'tokenURL', e.target.value)}
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
                        value={provider.userInfoURL || ''}
                        onChange={e => updateOidcProvider(index, 'userInfoURL', e.target.value)}
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
                        value={provider.groupsAttribute || ''}
                        onChange={e => updateOidcProvider(index, 'groupsAttribute', e.target.value)}
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
                        onChange={e =>
                          updateOidcProvider(
                            index,
                            'scope',
                            e.target.value.split(',').map(s => s.trim())
                          )
                        }
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
                        onChange={e =>
                          updateOidcProvider(
                            index,
                            'defaultGroups',
                            e.target.value
                              .split(',')
                              .map(s => s.trim())
                              .filter(s => s)
                          )
                        }
                        className="w-full px-3 py-2 border border-gray-300 rounded-md shadow-sm focus:ring-blue-500 focus:border-blue-500 sm:text-sm"
                      />
                    </div>
                    <div>
                      <label className="flex items-center">
                        <input
                          type="checkbox"
                          checked={provider.pkce !== false}
                          onChange={e => updateOidcProvider(index, 'pkce', e.target.checked)}
                          className="mr-2"
                        />
                        <span className="text-sm font-medium text-gray-700">Enable PKCE</span>
                      </label>
                    </div>
                    <div>
                      <label className="flex items-center">
                        <input
                          type="checkbox"
                          checked={provider.autoRedirect || false}
                          onChange={e =>
                            updateOidcProvider(index, 'autoRedirect', e.target.checked)
                          }
                          className="mr-2"
                        />
                        <span className="text-sm font-medium text-gray-700">Auto-redirect</span>
                      </label>
                      <p className="text-xs text-gray-500 mt-1">
                        Automatically redirect users to this provider when it's the only auth method
                        enabled
                      </p>
                    </div>
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      )}

      {/* Authentication Debug Settings */}
      <div className="bg-white rounded-lg shadow-sm border border-gray-200 p-6">
        <div className="mb-4">
          <h3 className="text-lg font-semibold text-gray-900">Debug Settings</h3>
          <p className="text-sm text-gray-600 mt-1">
            Enable detailed logging for authentication providers to troubleshoot issues.
            <span className="text-amber-600 font-medium ml-1">
              Warning: This may log sensitive information.
            </span>
          </p>
        </div>

        <div className="space-y-4">
          <div className="flex items-start space-x-3">
            <div className="flex items-center h-5">
              <input
                type="checkbox"
                checked={config.authDebug?.enabled || false}
                onChange={e => updateAuthDebugConfig('enabled', e.target.checked)}
                className="h-4 w-4 text-blue-600 focus:ring-blue-500 border-gray-300 rounded"
              />
            </div>
            <div className="flex-1">
              <label className="text-sm font-medium text-gray-900">
                Enable Authentication Debug Logging
              </label>
              <p className="text-xs text-gray-500">
                Log authentication events, token exchanges, and user information for troubleshooting
              </p>
            </div>
          </div>

          {config.authDebug?.enabled && (
            <div className="ml-6 space-y-4 pl-4 border-l-2 border-gray-200">
              <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                <div>
                  <label className="flex items-center">
                    <input
                      type="checkbox"
                      checked={config.authDebug?.maskTokens !== false}
                      onChange={e => updateAuthDebugConfig('maskTokens', e.target.checked)}
                      className="mr-2 h-4 w-4 text-blue-600 focus:ring-blue-500 border-gray-300 rounded"
                    />
                    <span className="text-sm font-medium text-gray-700">Mask Tokens</span>
                  </label>
                  <p className="text-xs text-gray-500 mt-1 ml-6">
                    Hide sensitive parts of access tokens and secrets
                  </p>
                </div>

                <div>
                  <label className="flex items-center">
                    <input
                      type="checkbox"
                      checked={config.authDebug?.redactPasswords !== false}
                      onChange={e => updateAuthDebugConfig('redactPasswords', e.target.checked)}
                      className="mr-2 h-4 w-4 text-blue-600 focus:ring-blue-500 border-gray-300 rounded"
                    />
                    <span className="text-sm font-medium text-gray-700">Redact Passwords</span>
                  </label>
                  <p className="text-xs text-gray-500 mt-1 ml-6">
                    Remove passwords and credentials from logs
                  </p>
                </div>

                <div>
                  <label className="flex items-center">
                    <input
                      type="checkbox"
                      checked={config.authDebug?.consoleLogging || false}
                      onChange={e => updateAuthDebugConfig('consoleLogging', e.target.checked)}
                      className="mr-2 h-4 w-4 text-blue-600 focus:ring-blue-500 border-gray-300 rounded"
                    />
                    <span className="text-sm font-medium text-gray-700">Console Logging</span>
                  </label>
                  <p className="text-xs text-gray-500 mt-1 ml-6">
                    Also output debug logs to console
                  </p>
                </div>

                <div>
                  <label className="flex items-center">
                    <input
                      type="checkbox"
                      checked={config.authDebug?.includeRawData || false}
                      onChange={e => updateAuthDebugConfig('includeRawData', e.target.checked)}
                      className="mr-2 h-4 w-4 text-blue-600 focus:ring-blue-500 border-gray-300 rounded"
                    />
                    <span className="text-sm font-medium text-gray-700">Include Raw Data</span>
                  </label>
                  <p className="text-xs text-gray-500 mt-1 ml-6">
                    Include unsanitized raw data (security risk)
                  </p>
                </div>
              </div>

              {/* Provider-specific settings */}
              <div className="pt-4 border-t border-gray-200">
                <h4 className="text-sm font-medium text-gray-900 mb-3">Provider Settings</h4>
                <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-3">
                  {['oidc', 'local', 'proxy', 'ldap', 'ntlm'].map(provider => (
                    <div key={provider} className="flex items-center space-x-2">
                      <input
                        type="checkbox"
                        id={`debug-${provider}`}
                        checked={config.authDebug?.providers?.[provider]?.enabled !== false}
                        onChange={e =>
                          updateAuthDebugProvider(provider, 'enabled', e.target.checked)
                        }
                        className="h-4 w-4 text-blue-600 focus:ring-blue-500 border-gray-300 rounded"
                      />
                      <label htmlFor={`debug-${provider}`} className="text-sm text-gray-700">
                        {provider.toUpperCase()}
                      </label>
                    </div>
                  ))}
                </div>
                <p className="text-xs text-gray-500 mt-2">
                  Enable debug logging per authentication provider
                </p>
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
};

export default PlatformFormEditor;
