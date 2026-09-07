import { useState } from 'react';
import Icon from '../../../../shared/components/Icon';
import { CredentialRefSelect } from '../OpenApiToolEditor';
import GroupMultiSelect from '../GroupMultiSelect';

// OIDC Provider Templates
const OIDC_PROVIDER_TEMPLATES = {
  auth0: {
    name: 'auth0',
    displayName: 'Auth0',
    authorizationURL: 'https://${AUTH0_DOMAIN}/authorize',
    tokenURL: 'https://${AUTH0_DOMAIN}/oauth/token',
    userInfoURL: 'https://${AUTH0_DOMAIN}/userinfo',
    scope: ['openid', 'profile', 'email'],
    groupsAttribute: 'groups',
    pkce: true,
    defaultGroups: []
  },
  google: {
    name: 'google',
    displayName: 'Google',
    authorizationURL: 'https://accounts.google.com/o/oauth2/v2/auth',
    tokenURL: 'https://www.googleapis.com/oauth2/v4/token',
    userInfoURL: 'https://www.googleapis.com/oauth2/v2/userinfo',
    scope: ['openid', 'profile', 'email'],
    groupsAttribute: 'groups',
    pkce: true,
    defaultGroups: []
  },
  microsoft: {
    name: 'microsoft',
    displayName: 'Microsoft',
    authorizationURL: 'https://login.microsoftonline.com/common/oauth2/v2.0/authorize',
    tokenURL: 'https://login.microsoftonline.com/common/oauth2/v2.0/token',
    userInfoURL: 'https://graph.microsoft.com/v1.0/me',
    scope: ['openid', 'profile', 'email', 'User.Read'],
    groupsAttribute: 'groups',
    pkce: true,
    defaultGroups: []
  },
  keycloak: {
    name: 'keycloak',
    displayName: 'Keycloak',
    authorizationURL:
      'https://${KEYCLOAK_SERVER}/realms/${KEYCLOAK_REALM}/protocol/openid-connect/auth',
    tokenURL: 'https://${KEYCLOAK_SERVER}/realms/${KEYCLOAK_REALM}/protocol/openid-connect/token',
    userInfoURL:
      'https://${KEYCLOAK_SERVER}/realms/${KEYCLOAK_REALM}/protocol/openid-connect/userinfo',
    scope: ['openid', 'profile', 'email'],
    groupsAttribute: 'groups',
    pkce: true,
    defaultGroups: []
  },
  custom: {
    name: '',
    displayName: '',
    authorizationURL: '',
    tokenURL: '',
    userInfoURL: '',
    scope: ['openid', 'profile', 'email'],
    groupsAttribute: 'groups',
    pkce: true,
    defaultGroups: []
  }
};

/**
 * OidcProvidersSection - OIDC authentication settings card: self-signup toggle,
 * provider list (add/update/remove), and the provider-template selection modal.
 */
function OidcProvidersSection({ config, onChange, t, availableGroups = [] }) {
  const [showProviderModal, setShowProviderModal] = useState(false);

  const updateNestedConfig = (section, field, value) => {
    onChange({
      ...config,
      [section]: {
        ...config[section],
        [field]: value
      }
    });
  };

  const addOidcProvider = (templateType = 'custom') => {
    const template = OIDC_PROVIDER_TEMPLATES[templateType] || OIDC_PROVIDER_TEMPLATES.custom;
    const newProvider = {
      ...template,
      clientId: '',
      clientSecret: '',
      callbackURL: '',
      enabled: true
    };

    onChange({
      ...config,
      oidcAuth: {
        ...config.oidcAuth,
        providers: [...(config.oidcAuth?.providers || []), newProvider]
      }
    });
    setShowProviderModal(false);
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

  if (!config.oidcAuth?.enabled) {
    return null;
  }

  return (
    <div className="bg-white dark:bg-gray-800 rounded-lg shadow-sm border border-gray-200 dark:border-gray-700 p-6">
      <div className="flex justify-between items-center mb-4">
        <h3 className="text-lg font-semibold text-gray-900 dark:text-gray-100">
          OIDC Authentication Settings
        </h3>
        <button
          type="button"
          onClick={() => setShowProviderModal(true)}
          className="inline-flex items-center px-4 py-2 border border-transparent text-sm font-medium rounded-md text-blue-700 bg-blue-100 hover:bg-blue-200"
        >
          <Icon name="plus" size="sm" className="mr-2" />
          {t('admin.auth.addOidcProvider', 'Add OIDC Provider')}
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
        <p className="text-xs text-gray-500 dark:text-gray-400 mt-1">
          Allow new users to register automatically through OIDC authentication. If disabled, new
          users must be added manually by administrators.
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
                  <h4 className="text-md font-medium text-gray-900 dark:text-gray-100">
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
                  <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">
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
                  <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">
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
                  <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">
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
                  <CredentialRefSelect
                    value={provider.clientSecretRef || ''}
                    onChange={id => updateOidcProvider(index, 'clientSecretRef', id)}
                    types={['secret', 'oauth2']}
                    label={t('admin.auth.oidc.clientSecret', 'Client Secret')}
                    help={t(
                      'admin.auth.oidc.clientSecretHelp',
                      'Select a stored credential profile holding the OIDC client secret.'
                    )}
                  />
                </div>
                <div>
                  <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">
                    Authorization URL
                  </label>
                  <input
                    type="url"
                    placeholder="https://accounts.google.com/o/oauth2/v2/auth"
                    value={provider.authorizationURL || ''}
                    onChange={e => updateOidcProvider(index, 'authorizationURL', e.target.value)}
                    className="w-full px-3 py-2 border border-gray-300 rounded-md shadow-sm focus:ring-blue-500 focus:border-blue-500 sm:text-sm"
                  />
                </div>
                <div>
                  <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">
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
                  <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">
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
                <div className="md:col-span-2">
                  <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">
                    {t('admin.auth.callbackURL', 'Callback URL')}{' '}
                    <span className="text-xs text-gray-500 dark:text-gray-400 font-normal">
                      {t('admin.auth.callbackURLOptional', '(Optional - Auto-generated if empty)')}
                    </span>
                  </label>
                  <input
                    type="url"
                    placeholder={t(
                      'admin.auth.callbackURLPlaceholder',
                      '/api/auth/oidc/{{providerName}}/callback'
                    ).replace('{{providerName}}', provider.name || 'provider')}
                    value={provider.callbackURL || ''}
                    onChange={e => updateOidcProvider(index, 'callbackURL', e.target.value)}
                    className="w-full px-3 py-2 border border-gray-300 rounded-md shadow-sm focus:ring-blue-500 focus:border-blue-500 sm:text-sm"
                  />
                  <p className="text-xs text-gray-500 dark:text-gray-400 mt-1">
                    {t(
                      'admin.auth.callbackURLHelp',
                      'Leave empty to auto-generate. Override for custom domains or subpath deployments.'
                    )}
                  </p>
                  {!provider.callbackURL && provider.name && (
                    <p className="text-xs text-blue-600 dark:text-blue-400 mt-1">
                      <Icon name="information-circle" className="h-3 w-3 inline mr-1" />
                      Auto-generated: /api/auth/oidc/{provider.name}/callback
                    </p>
                  )}
                </div>
                <div>
                  <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">
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
                  <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">
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
                  <GroupMultiSelect
                    id={`oidc-default-groups-${index}`}
                    label={t('admin.auth.groups.defaultLabel', 'Default Groups')}
                    allowCustom={false}
                    availableGroups={availableGroups}
                    value={Array.isArray(provider.defaultGroups) ? provider.defaultGroups : []}
                    onChange={next => updateOidcProvider(index, 'defaultGroups', next)}
                    placeholder={t('admin.auth.groups.searchPlaceholder', 'Search groups…')}
                    helpText={t(
                      'admin.auth.groups.oidcHelp',
                      'Internal groups automatically assigned to users authenticating with this provider'
                    )}
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
                      onChange={e => updateOidcProvider(index, 'autoRedirect', e.target.checked)}
                      className="mr-2"
                    />
                    <span className="text-sm font-medium text-gray-700">Auto-redirect</span>
                  </label>
                  <p className="text-xs text-gray-500 dark:text-gray-400 mt-1">
                    Automatically redirect users to this provider when it's the only auth method
                    enabled
                  </p>
                </div>
              </div>
            </div>
          ))}
        </div>
      )}

      {/* OIDC Provider Selection Modal */}
      {showProviderModal && (
        <div className="fixed inset-0 bg-gray-500 bg-opacity-75 dark:bg-gray-900/80 flex items-center justify-center z-50">
          <div className="bg-white dark:bg-gray-800 rounded-lg shadow-xl max-w-2xl w-full mx-4">
            <div className="px-6 py-4 border-b border-gray-200 dark:border-gray-700">
              <div className="flex justify-between items-center">
                <h3 className="text-lg font-semibold text-gray-900 dark:text-gray-100">
                  {t('admin.auth.selectOidcProvider', 'Select OIDC Provider')}
                </h3>
                <button
                  onClick={() => setShowProviderModal(false)}
                  className="text-gray-400 hover:text-gray-500 dark:hover:text-gray-300"
                >
                  <Icon name="close" size="md" />
                </button>
              </div>
            </div>
            <div className="px-6 py-4">
              <p className="text-sm text-gray-600 dark:text-gray-400 mb-4">
                {t(
                  'admin.auth.selectProviderDescription',
                  'Choose a preconfigured provider template or create a custom configuration'
                )}
              </p>
              <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                {/* Auth0 */}
                <button
                  onClick={() => addOidcProvider('auth0')}
                  className="flex items-start p-4 border-2 border-gray-200 dark:border-gray-600 rounded-lg hover:border-blue-500 dark:hover:border-blue-400 hover:bg-blue-50 dark:hover:bg-blue-900/30 transition-all text-left"
                >
                  <div className="flex-shrink-0 mt-1">
                    <div className="w-10 h-10 bg-orange-100 dark:bg-orange-900/30 rounded-lg flex items-center justify-center">
                      <Icon name="key" size="md" className="text-orange-600 dark:text-orange-400" />
                    </div>
                  </div>
                  <div className="ml-3">
                    <h4 className="text-sm font-semibold text-gray-900 dark:text-gray-100">
                      Auth0
                    </h4>
                    <p className="text-xs text-gray-500 dark:text-gray-400 mt-1">
                      {t('admin.auth.auth0Description', 'Enterprise identity platform')}
                    </p>
                  </div>
                </button>

                {/* Google */}
                <button
                  onClick={() => addOidcProvider('google')}
                  className="flex items-start p-4 border-2 border-gray-200 dark:border-gray-600 rounded-lg hover:border-blue-500 dark:hover:border-blue-400 hover:bg-blue-50 dark:hover:bg-blue-900/30 transition-all text-left"
                >
                  <div className="flex-shrink-0 mt-1">
                    <div className="w-10 h-10 bg-red-100 dark:bg-red-900/30 rounded-lg flex items-center justify-center">
                      <Icon name="key" size="md" className="text-red-600 dark:text-red-400" />
                    </div>
                  </div>
                  <div className="ml-3">
                    <h4 className="text-sm font-semibold text-gray-900 dark:text-gray-100">
                      Google
                    </h4>
                    <p className="text-xs text-gray-500 dark:text-gray-400 mt-1">
                      {t('admin.auth.googleDescription', 'Sign in with Google accounts')}
                    </p>
                  </div>
                </button>

                {/* Microsoft */}
                <button
                  onClick={() => addOidcProvider('microsoft')}
                  className="flex items-start p-4 border-2 border-gray-200 dark:border-gray-600 rounded-lg hover:border-blue-500 dark:hover:border-blue-400 hover:bg-blue-50 dark:hover:bg-blue-900/30 transition-all text-left"
                >
                  <div className="flex-shrink-0 mt-1">
                    <div className="w-10 h-10 bg-blue-100 dark:bg-blue-900/30 rounded-lg flex items-center justify-center">
                      <Icon name="key" size="md" className="text-blue-600 dark:text-blue-400" />
                    </div>
                  </div>
                  <div className="ml-3">
                    <h4 className="text-sm font-semibold text-gray-900 dark:text-gray-100">
                      Microsoft
                    </h4>
                    <p className="text-xs text-gray-500 dark:text-gray-400 mt-1">
                      {t(
                        'admin.auth.microsoftDescription',
                        'Sign in with Microsoft/Azure AD accounts'
                      )}
                    </p>
                  </div>
                </button>

                {/* Keycloak */}
                <button
                  onClick={() => addOidcProvider('keycloak')}
                  className="flex items-start p-4 border-2 border-gray-200 dark:border-gray-600 rounded-lg hover:border-blue-500 dark:hover:border-blue-400 hover:bg-blue-50 dark:hover:bg-blue-900/30 transition-all text-left"
                >
                  <div className="flex-shrink-0 mt-1">
                    <div className="w-10 h-10 bg-green-100 dark:bg-green-900/30 rounded-lg flex items-center justify-center">
                      <Icon name="key" size="md" className="text-green-600 dark:text-green-400" />
                    </div>
                  </div>
                  <div className="ml-3">
                    <h4 className="text-sm font-semibold text-gray-900 dark:text-gray-100">
                      Keycloak
                    </h4>
                    <p className="text-xs text-gray-500 dark:text-gray-400 mt-1">
                      {t('admin.auth.keycloakDescription', 'Open source identity management')}
                    </p>
                  </div>
                </button>

                {/* Custom */}
                <button
                  onClick={() => addOidcProvider('custom')}
                  className="flex items-start p-4 border-2 border-gray-200 dark:border-gray-600 rounded-lg hover:border-blue-500 dark:hover:border-blue-400 hover:bg-blue-50 dark:hover:bg-blue-900/30 transition-all text-left md:col-span-2"
                >
                  <div className="flex-shrink-0 mt-1">
                    <div className="w-10 h-10 bg-gray-100 dark:bg-gray-700 rounded-lg flex items-center justify-center">
                      <Icon name="cog" size="md" className="text-gray-600 dark:text-gray-400" />
                    </div>
                  </div>
                  <div className="ml-3">
                    <h4 className="text-sm font-semibold text-gray-900 dark:text-gray-100">
                      {t('admin.auth.customProvider', 'Custom Provider')}
                    </h4>
                    <p className="text-xs text-gray-500 dark:text-gray-400 mt-1">
                      {t(
                        'admin.auth.customProviderDescription',
                        'Configure a custom OIDC provider with your own settings'
                      )}
                    </p>
                  </div>
                </button>
              </div>
            </div>
            <div className="px-6 py-4 bg-gray-50 dark:bg-gray-900 border-t border-gray-200 dark:border-gray-700 flex justify-end rounded-b-lg">
              <button
                onClick={() => setShowProviderModal(false)}
                className="px-4 py-2 text-sm font-medium text-gray-700 dark:text-gray-300 bg-white dark:bg-gray-800 border border-gray-300 dark:border-gray-600 rounded-md hover:bg-gray-50 dark:hover:bg-gray-700"
              >
                {t('common.cancel', 'Cancel')}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

export default OidcProvidersSection;
