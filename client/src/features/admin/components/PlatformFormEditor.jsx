import { useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import Icon from '../../../shared/components/Icon';
import { CredentialRefSelect } from './OpenApiToolEditor';
import GroupMultiSelect from './GroupMultiSelect';
import JwtProvidersSection from './platform-form/JwtProvidersSection';
import OidcProvidersSection from './platform-form/OidcProvidersSection';
import LdapProvidersSection from './platform-form/LdapProvidersSection';

/**
 * PlatformFormEditor - Form-based editor for platform configuration
 */
function PlatformFormEditor({ value: config, onChange, onValidationChange, availableGroups = [] }) {
  const { t } = useTranslation();

  // Validation function
  const validateConfig = configData => {
    const errors = {};

    // Basic validation
    if (!configData.auth?.mode) {
      errors['auth.mode'] = 'Authentication mode is required';
    }

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
    // eslint-disable-next-line @eslint-react/exhaustive-deps
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
      <div className="bg-white dark:bg-gray-800 rounded-lg shadow-sm border border-gray-200 dark:border-gray-700 p-6">
        <h3 className="text-lg font-semibold text-gray-900 dark:text-gray-100 mb-4">
          Primary Authentication Mode
        </h3>
        <p className="text-sm text-gray-600 dark:text-gray-400 mb-4">
          Select the primary authentication mode for default behavior and routing.
        </p>
        <div className="space-y-4">
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
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
                mode: 'ldap',
                title: 'LDAP Mode',
                desc: 'LDAP/Active Directory authentication'
              },
              {
                mode: 'ntlm',
                title: 'NTLM Mode',
                desc: 'Windows Integrated Authentication (NTLM/Kerberos)'
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
                    ? 'border-blue-500 dark:border-blue-400 bg-blue-50 dark:bg-blue-900/30'
                    : 'border-gray-200 dark:border-gray-600 hover:border-gray-300 dark:hover:border-gray-500'
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
                  <h4 className="font-medium text-gray-900 dark:text-gray-100">
                    {modeOption.title}
                  </h4>
                </div>
                <p className="text-sm text-gray-600 dark:text-gray-400">{modeOption.desc}</p>
              </div>
            ))}
          </div>
        </div>
      </div>

      {/* Multiple Authentication Methods */}
      <div className="bg-white dark:bg-gray-800 rounded-lg shadow-sm border border-gray-200 dark:border-gray-700 p-6">
        <h3 className="text-lg font-semibold text-gray-900 dark:text-gray-100 mb-4">
          {t('admin.auth.methods', 'Authentication Methods')}
        </h3>
        <p className="text-sm text-gray-600 dark:text-gray-400 mb-4">
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
                <p className="text-xs text-gray-500 dark:text-gray-400">
                  Headers or JWT tokens from reverse proxy
                </p>
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
                <p className="text-xs text-gray-500 dark:text-gray-400">
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
                <p className="text-xs text-gray-500 dark:text-gray-400">
                  OpenID Connect providers (Google, etc.)
                </p>
              </div>
            </div>

            <div className="flex items-start space-x-3">
              <div className="flex items-center h-5">
                <input
                  type="checkbox"
                  checked={config.ldapAuth?.enabled || false}
                  onChange={e => toggleAuthMethod('ldapAuth', e.target.checked)}
                  className="h-4 w-4 text-blue-600 focus:ring-blue-500 border-gray-300 rounded"
                />
              </div>
              <div className="flex-1">
                <label className="text-sm font-medium text-gray-900">LDAP Authentication</label>
                <p className="text-xs text-gray-500 dark:text-gray-400">
                  LDAP/Active Directory authentication with multiple providers
                </p>
              </div>
            </div>

            <div className="flex items-start space-x-3">
              <div className="flex items-center h-5">
                <input
                  type="checkbox"
                  checked={config.ntlmAuth?.enabled || false}
                  onChange={e => toggleAuthMethod('ntlmAuth', e.target.checked)}
                  className="h-4 w-4 text-blue-600 focus:ring-blue-500 border-gray-300 rounded"
                />
              </div>
              <div className="flex-1">
                <label className="text-sm font-medium text-gray-900">NTLM Authentication</label>
                <p className="text-xs text-gray-500 dark:text-gray-400">
                  Windows Integrated Authentication (NTLM)
                </p>
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
                <p className="text-xs text-gray-500 dark:text-gray-400">
                  Allow users to access without authentication
                </p>
              </div>
            </div>
          </div>
        </div>
      </div>

      {/* General Authentication Settings */}
      <div className="bg-white dark:bg-gray-800 rounded-lg shadow-sm border border-gray-200 dark:border-gray-700 p-6">
        <h3 className="text-lg font-semibold text-gray-900 dark:text-gray-100 mb-4">
          {t('admin.auth.defaultGroups', 'Default Groups')}
        </h3>
        <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
          <div>
            <GroupMultiSelect
              id="auth-authenticated-group"
              label={t('admin.auth.groups.authenticatedLabel', 'Authenticated Group')}
              multiple={false}
              allowCustom={false}
              availableGroups={availableGroups}
              value={config.auth?.authenticatedGroup ? [config.auth.authenticatedGroup] : []}
              onChange={next =>
                updateNestedConfig('auth', 'authenticatedGroup', next[next.length - 1] || '')
              }
              placeholder={t('admin.auth.groups.searchPlaceholder', 'Search groups…')}
              emptyMessage={t('admin.auth.groups.emptySingle', 'No group selected yet')}
              helpText={t(
                'admin.auth.groups.authenticatedHelp',
                'Internal group automatically assigned to all authenticated users'
              )}
            />
          </div>
          <div>
            <GroupMultiSelect
              id="anonymous-default-groups"
              label={t('admin.auth.groups.anonymousLabel', 'Anonymous Groups')}
              allowCustom={false}
              availableGroups={availableGroups}
              value={
                Array.isArray(config.anonymousAuth?.defaultGroups)
                  ? config.anonymousAuth.defaultGroups
                  : []
              }
              onChange={next => updateNestedConfig('anonymousAuth', 'defaultGroups', next)}
              placeholder={t('admin.auth.groups.searchPlaceholder', 'Search groups…')}
              helpText={t(
                'admin.auth.groups.anonymousHelp',
                'Internal groups assigned to users who access without authentication'
              )}
            />
          </div>
        </div>
      </div>

      {/* Proxy Auth Configuration */}
      {config.proxyAuth?.enabled && (
        <div className="bg-white dark:bg-gray-800 rounded-lg shadow-sm border border-gray-200 dark:border-gray-700 p-6">
          <h3 className="text-lg font-semibold text-gray-900 dark:text-gray-100 mb-4">
            Proxy/JWT Authentication Settings
          </h3>
          <p className="text-sm text-gray-600 dark:text-gray-400 mb-4">
            Configure header-based authentication from reverse proxy and/or JWT token validation for
            pure JWT authentication.
          </p>
          <div className="space-y-4">
            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
              <div>
                <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">
                  User Header
                </label>
                <input
                  type="text"
                  value={config.proxyAuth?.userHeader || ''}
                  onChange={e => updateNestedConfig('proxyAuth', 'userHeader', e.target.value)}
                  className="w-full px-3 py-2 border border-gray-300 rounded-md shadow-sm focus:ring-blue-500 focus:border-blue-500 sm:text-sm"
                  placeholder="X-Forwarded-User"
                />
              </div>
              <div>
                <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">
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
              <p className="text-xs text-gray-500 dark:text-gray-400 mt-1">
                Allow new users to register automatically through proxy authentication. If disabled,
                new users must be added manually by administrators.
              </p>
            </div>

            {/* JWT Providers */}
            <JwtProvidersSection config={config} onChange={onChange} t={t} />
          </div>
        </div>
      )}

      {/* Local Auth Configuration */}
      {config.localAuth?.enabled && (
        <div className="bg-white dark:bg-gray-800 rounded-lg shadow-sm border border-gray-200 dark:border-gray-700 p-6">
          <h3 className="text-lg font-semibold text-gray-900 dark:text-gray-100 mb-4">
            Local Authentication Settings
          </h3>
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            <div>
              <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">
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
              <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">
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
              <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">
                JWT Secret
              </label>
              <input
                type="text"
                value={config.localAuth?.jwtSecret || ''}
                onChange={e => updateNestedConfig('localAuth', 'jwtSecret', e.target.value)}
                className="w-full px-3 py-2 border border-gray-300 rounded-md shadow-sm focus:ring-blue-500 focus:border-blue-500 sm:text-sm"
                placeholder="${JWT_SECRET}"
              />
              <p className="text-xs text-gray-500 dark:text-gray-400 mt-1">
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
              <p className="text-xs text-gray-500 dark:text-gray-400 mt-1">
                Display demo account credentials on the login form for development/testing
              </p>
            </div>
          </div>
        </div>
      )}

      {/* OIDC Configuration */}
      <OidcProvidersSection
        config={config}
        onChange={onChange}
        t={t}
        availableGroups={availableGroups}
      />

      {/* LDAP Configuration - shown when LDAP or NTLM is enabled (NTLM can use LDAP for group lookup) */}
      <LdapProvidersSection
        config={config}
        onChange={onChange}
        t={t}
        availableGroups={availableGroups}
      />

      {/* NTLM Configuration */}
      {config.ntlmAuth?.enabled && (
        <div className="bg-white dark:bg-gray-800 rounded-lg shadow-sm border border-gray-200 dark:border-gray-700 p-6">
          <h3 className="text-lg font-semibold text-gray-900 dark:text-gray-100 mb-4">
            NTLM Authentication Settings
          </h3>
          <p className="text-sm text-gray-600 dark:text-gray-400 mb-4">
            Configure Windows Integrated Authentication (NTLM) for domain users.
          </p>
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            <div>
              <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">
                Domain Name
              </label>
              <input
                type="text"
                value={config.ntlmAuth?.domain || ''}
                onChange={e => updateNestedConfig('ntlmAuth', 'domain', e.target.value)}
                className="w-full px-3 py-2 border border-gray-300 rounded-md shadow-sm focus:ring-blue-500 focus:border-blue-500 sm:text-sm"
                placeholder="EXAMPLE"
              />
              <p className="text-xs text-gray-500 dark:text-gray-400 mt-1">
                Windows domain name (e.g., EXAMPLE, MUC)
              </p>
            </div>
            <div>
              <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">
                Domain Controller URL
              </label>
              <input
                type="text"
                value={config.ntlmAuth?.domainController || ''}
                onChange={e => updateNestedConfig('ntlmAuth', 'domainController', e.target.value)}
                className="w-full px-3 py-2 border border-gray-300 rounded-md shadow-sm focus:ring-blue-500 focus:border-blue-500 sm:text-sm"
                placeholder="ldap://dc.example.com:389"
              />
              <p className="text-xs text-gray-500 dark:text-gray-400 mt-1">
                LDAP URL of domain controller (e.g., ldap://dc.example.com:389 or
                ldaps://dc.example.com:636)
              </p>
            </div>
            <div>
              <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">
                Domain Controller User
              </label>
              <input
                type="text"
                value={config.ntlmAuth?.domainControllerUser || ''}
                onChange={e =>
                  updateNestedConfig('ntlmAuth', 'domainControllerUser', e.target.value)
                }
                className="w-full px-3 py-2 border border-gray-300 rounded-md shadow-sm focus:ring-blue-500 focus:border-blue-500 sm:text-sm"
                placeholder="admin@EXAMPLE.COM"
              />
              <p className="text-xs text-gray-500 dark:text-gray-400 mt-1">
                Domain controller admin username (optional, for retrieving user info/groups)
              </p>
            </div>
            <div>
              <CredentialRefSelect
                value={config.ntlmAuth?.domainControllerPasswordRef || ''}
                onChange={id => updateNestedConfig('ntlmAuth', 'domainControllerPasswordRef', id)}
                types={['secret', 'basic']}
                label={t('admin.auth.ntlm.domainControllerPassword', 'Domain Controller Password')}
                help={t(
                  'admin.auth.ntlm.domainControllerPasswordHelp',
                  'Select a stored credential profile holding the domain controller password.'
                )}
              />
            </div>
            <div>
              <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">
                Authentication Type
              </label>
              <select
                value={config.ntlmAuth?.type || 'ntlm'}
                onChange={e => updateNestedConfig('ntlmAuth', 'type', e.target.value)}
                className="w-full px-3 py-2 border border-gray-300 rounded-md shadow-sm focus:ring-blue-500 focus:border-blue-500 sm:text-sm"
              >
                <option value="ntlm">NTLM</option>
                <option value="negotiate">Negotiate</option>
              </select>
              <p className="text-xs text-gray-500 dark:text-gray-400 mt-1">
                Protocol to use for Windows authentication
              </p>
            </div>
            <div>
              <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">
                Session Timeout (minutes)
              </label>
              <input
                type="number"
                value={config.ntlmAuth?.sessionTimeoutMinutes || 480}
                onChange={e =>
                  updateNestedConfig('ntlmAuth', 'sessionTimeoutMinutes', parseInt(e.target.value))
                }
                className="w-full px-3 py-2 border border-gray-300 rounded-md shadow-sm focus:ring-blue-500 focus:border-blue-500 sm:text-sm"
                placeholder="480"
              />
              <p className="text-xs text-gray-500 dark:text-gray-400 mt-1">
                JWT token expiration time
              </p>
            </div>
            <div className="md:col-span-2">
              <GroupMultiSelect
                id="ntlm-default-groups"
                label={t('admin.auth.groups.defaultLabel', 'Default Groups')}
                allowCustom={false}
                availableGroups={availableGroups}
                value={
                  Array.isArray(config.ntlmAuth?.defaultGroups) ? config.ntlmAuth.defaultGroups : []
                }
                onChange={next => updateNestedConfig('ntlmAuth', 'defaultGroups', next)}
                placeholder={t('admin.auth.groups.searchPlaceholder', 'Search groups…')}
                helpText={t(
                  'admin.auth.groups.ntlmHelp',
                  'Internal groups automatically assigned to NTLM authenticated users'
                )}
              />
            </div>
            <div>
              <label className="flex items-center">
                <input
                  type="checkbox"
                  checked={config.ntlmAuth?.debug || false}
                  onChange={e => updateNestedConfig('ntlmAuth', 'debug', e.target.checked)}
                  className="mr-2"
                />
                <span className="text-sm font-medium text-gray-700">Enable Debug Logging</span>
              </label>
              <p className="text-xs text-gray-500 dark:text-gray-400 mt-1">
                Log detailed NTLM authentication information
              </p>
            </div>
            <div>
              <label className="flex items-center">
                <input
                  type="checkbox"
                  checked={config.ntlmAuth?.getUserInfo !== false}
                  onChange={e => updateNestedConfig('ntlmAuth', 'getUserInfo', e.target.checked)}
                  className="mr-2"
                />
                <span className="text-sm font-medium text-gray-700">Get User Info</span>
              </label>
              <p className="text-xs text-gray-500 dark:text-gray-400 mt-1">
                Retrieve additional user information from domain
              </p>
            </div>
            <div>
              <label className="flex items-center">
                <input
                  type="checkbox"
                  checked={config.ntlmAuth?.getGroups !== false}
                  onChange={e => updateNestedConfig('ntlmAuth', 'getGroups', e.target.checked)}
                  className="mr-2"
                />
                <span className="text-sm font-medium text-gray-700">Get Groups</span>
              </label>
              <p className="text-xs text-gray-500 dark:text-gray-400 mt-1">
                Retrieve user group memberships from domain
              </p>
            </div>
            <div>
              <label className="flex items-center">
                <input
                  type="checkbox"
                  checked={config.ntlmAuth?.generateJwtToken !== false}
                  onChange={e =>
                    updateNestedConfig('ntlmAuth', 'generateJwtToken', e.target.checked)
                  }
                  className="mr-2"
                />
                <span className="text-sm font-medium text-gray-700">Generate JWT Token</span>
              </label>
              <p className="text-xs text-gray-500 dark:text-gray-400 mt-1">
                Generate JWT tokens for API access after NTLM authentication
              </p>
            </div>
            <div className="md:col-span-2">
              <label className="flex items-center space-x-3 cursor-pointer">
                <input
                  type="checkbox"
                  checked={config.ntlmAuth?.tlsOptions?.rejectUnauthorized === false}
                  onChange={e =>
                    updateNestedConfig(
                      'ntlmAuth',
                      'tlsOptions',
                      e.target.checked ? { rejectUnauthorized: false } : undefined
                    )
                  }
                  className="h-4 w-4 text-blue-600 border-gray-300 rounded focus:ring-blue-500"
                />
                <span className="text-sm font-medium text-gray-700 dark:text-gray-300">
                  Allow self-signed / internal CA certificates (ldaps://)
                </span>
              </label>
              <p className="text-xs text-gray-500 dark:text-gray-400 mt-1 ml-7">
                Enable when the domain controller uses a certificate from a private or internal CA.
                Required for most on-premise ldaps:// setups.
              </p>
            </div>
          </div>

          {/* LDAP Group Lookup Provider */}
          <div className="mt-4">
            <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">
              LDAP Group Lookup Provider
            </label>
            <select
              value={config.ntlmAuth?.ldapGroupLookupProvider || ''}
              onChange={e =>
                updateNestedConfig(
                  'ntlmAuth',
                  'ldapGroupLookupProvider',
                  e.target.value || undefined
                )
              }
              className="w-full px-3 py-2 border border-gray-300 dark:border-gray-600 rounded-md shadow-sm focus:ring-blue-500 focus:border-blue-500 sm:text-sm dark:bg-gray-700 dark:text-gray-200"
            >
              <option value="">None (use NTLM built-in groups)</option>
              {(config.ldapAuth?.providers || []).map(p => (
                <option key={p.name} value={p.name}>
                  {p.displayName || p.name}
                </option>
              ))}
            </select>
            <p className="text-xs text-gray-500 dark:text-gray-400 mt-1">
              Use an LDAP provider to look up user groups during login instead of relying on the
              domain controller. The LDAP provider must have admin credentials and group search
              configured.
            </p>
          </div>
        </div>
      )}

      {/* Authentication Debug Settings — consolidated onto the Logging page */}
      <div className="bg-blue-50 dark:bg-blue-900/20 rounded-lg border border-blue-200 dark:border-blue-800 p-4">
        <div className="flex items-start">
          <Icon
            name="information-circle"
            className="h-5 w-5 mr-2 text-blue-600 dark:text-blue-400 flex-shrink-0 mt-0.5"
          />
          <div className="text-sm text-blue-800 dark:text-blue-300">
            <p className="font-medium">
              {t('admin.auth.debugMovedTitle', 'Authentication debug logging moved')}
            </p>
            <p className="mt-1 text-xs">
              {t(
                'admin.auth.debugMovedHelp',
                'All authentication debug settings (OIDC/LDAP/NTLM tracing, token masking, raw data) now live in one place: Platform → Logging → Authentication Debug Logging.'
              )}
            </p>
          </div>
        </div>
      </div>
    </div>
  );
}

export default PlatformFormEditor;
