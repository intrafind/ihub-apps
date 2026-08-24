import Icon from '../../../../shared/components/Icon';
import { CredentialRefSelect } from '../OpenApiToolEditor';
import GroupMultiSelect from '../GroupMultiSelect';

/**
 * LdapProvidersSection - LDAP authentication settings card: provider list
 * (add/update/remove), shown when LDAP or NTLM is enabled (NTLM can use LDAP
 * for group lookup).
 */
function LdapProvidersSection({ config, onChange, t, availableGroups = [] }) {
  const addLdapProvider = () => {
    const newProvider = {
      name: '',
      displayName: '',
      url: '',
      adminDn: '',
      adminPassword: '',
      userSearchBase: '',
      usernameAttribute: 'uid',
      userDn: '',
      groupSearchBase: '',
      groupClass: 'groupOfNames',
      defaultGroups: [],
      sessionTimeoutMinutes: 480
    };

    onChange({
      ...config,
      ldapAuth: {
        ...config.ldapAuth,
        providers: [...(config.ldapAuth?.providers || []), newProvider]
      }
    });
  };

  const updateLdapProvider = (index, field, value) => {
    const providers = [...(config.ldapAuth?.providers || [])];
    providers[index] = { ...providers[index], [field]: value };

    onChange({
      ...config,
      ldapAuth: {
        ...config.ldapAuth,
        providers
      }
    });
  };

  const removeLdapProvider = index => {
    const providers = [...(config.ldapAuth?.providers || [])];
    providers.splice(index, 1);

    onChange({
      ...config,
      ldapAuth: {
        ...config.ldapAuth,
        providers
      }
    });
  };

  if (!(config.ldapAuth?.enabled || config.ntlmAuth?.enabled)) {
    return null;
  }

  return (
    <div className="bg-white dark:bg-gray-800 rounded-lg shadow-sm border border-gray-200 dark:border-gray-700 p-6">
      <div className="flex justify-between items-center mb-4">
        <div>
          <h3 className="text-lg font-semibold text-gray-900 dark:text-gray-100">
            LDAP Authentication Settings
          </h3>
          <p className="text-sm text-gray-600 mt-1">
            Configure LDAP/Active Directory authentication providers
          </p>
        </div>
        <button
          type="button"
          onClick={addLdapProvider}
          className="px-4 py-2 bg-blue-600 text-white rounded-md hover:bg-blue-700 focus:outline-none focus:ring-2 focus:ring-blue-500 focus:ring-offset-2 text-sm font-medium"
        >
          <Icon name="plus" className="h-4 w-4 inline-block mr-1" />
          Add LDAP Provider
        </button>
      </div>

      {config.ldapAuth?.providers?.length === 0 && (
        <div className="text-center py-8 text-gray-500">
          <Icon name="server" className="h-12 w-12 mx-auto mb-2 text-gray-400" />
          <p>No LDAP providers configured</p>
          <p className="text-sm mt-1">Click "Add LDAP Provider" to get started</p>
        </div>
      )}

      {config.ldapAuth?.providers?.map((provider, index) => (
        <div key={index} className="mb-6 p-6 border border-gray-200 rounded-lg">
          <div className="flex justify-between items-start mb-4">
            <div className="flex items-center space-x-2">
              <h4 className="text-md font-semibold text-gray-900 dark:text-gray-100">
                LDAP Provider {index + 1}
                {provider.displayName && `: ${provider.displayName}`}
              </h4>
            </div>
            <button
              type="button"
              onClick={() => removeLdapProvider(index)}
              className="text-red-600 hover:text-red-800 text-sm font-medium"
            >
              <Icon name="trash" className="h-4 w-4" />
            </button>
          </div>

          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            <div>
              <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">
                Provider Name
              </label>
              <input
                type="text"
                value={provider.name || ''}
                onChange={e => updateLdapProvider(index, 'name', e.target.value)}
                className="w-full px-3 py-2 border border-gray-300 rounded-md shadow-sm focus:ring-blue-500 focus:border-blue-500 sm:text-sm"
                placeholder="corporate-ldap"
              />
              <p className="text-xs text-gray-500 dark:text-gray-400 mt-1">
                Internal identifier for this provider
              </p>
            </div>

            <div>
              <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">
                Display Name
              </label>
              <input
                type="text"
                value={provider.displayName || ''}
                onChange={e => updateLdapProvider(index, 'displayName', e.target.value)}
                className="w-full px-3 py-2 border border-gray-300 rounded-md shadow-sm focus:ring-blue-500 focus:border-blue-500 sm:text-sm"
                placeholder="Corporate LDAP"
              />
              <p className="text-xs text-gray-500 dark:text-gray-400 mt-1">
                User-friendly name shown in login
              </p>
            </div>

            <div className="md:col-span-2">
              <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">
                LDAP URL
              </label>
              <input
                type="text"
                value={provider.url || ''}
                onChange={e => updateLdapProvider(index, 'url', e.target.value)}
                className="w-full px-3 py-2 border border-gray-300 rounded-md shadow-sm focus:ring-blue-500 focus:border-blue-500 sm:text-sm"
                placeholder="ldap://ldap.example.com:389"
              />
              <p className="text-xs text-gray-500 dark:text-gray-400 mt-1">
                LDAP server URL (e.g., ldap://ldap.example.com:389 or ldaps://ldap.example.com:636)
              </p>
            </div>

            <div>
              <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">
                Admin DN
              </label>
              <input
                type="text"
                value={provider.adminDn || ''}
                onChange={e => updateLdapProvider(index, 'adminDn', e.target.value)}
                className="w-full px-3 py-2 border border-gray-300 rounded-md shadow-sm focus:ring-blue-500 focus:border-blue-500 sm:text-sm"
                placeholder="cn=admin,dc=example,dc=org"
              />
              <p className="text-xs text-gray-500 dark:text-gray-400 mt-1">
                Admin Distinguished Name for binding
              </p>
            </div>

            <div>
              <CredentialRefSelect
                value={provider.adminPasswordRef || ''}
                onChange={id => updateLdapProvider(index, 'adminPasswordRef', id)}
                types={['secret', 'basic']}
                label={t('admin.auth.ldap.adminPassword', 'Admin Password')}
                help={t(
                  'admin.auth.ldap.adminPasswordHelp',
                  'Select a stored credential profile holding the bind password.'
                )}
              />
            </div>

            <div>
              <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">
                User Search Base
              </label>
              <input
                type="text"
                value={provider.userSearchBase || ''}
                onChange={e => updateLdapProvider(index, 'userSearchBase', e.target.value)}
                className="w-full px-3 py-2 border border-gray-300 rounded-md shadow-sm focus:ring-blue-500 focus:border-blue-500 sm:text-sm"
                placeholder="ou=people,dc=example,dc=org"
              />
              <p className="text-xs text-gray-500 dark:text-gray-400 mt-1">
                Base DN for user searches
              </p>
            </div>

            <div>
              <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">
                Username Attribute
              </label>
              <input
                type="text"
                value={provider.usernameAttribute ?? 'uid'}
                onChange={e => updateLdapProvider(index, 'usernameAttribute', e.target.value)}
                className="w-full px-3 py-2 border border-gray-300 rounded-md shadow-sm focus:ring-blue-500 focus:border-blue-500 sm:text-sm"
                placeholder="uid"
              />
              <p className="text-xs text-gray-500 dark:text-gray-400 mt-1">
                LDAP attribute for username (uid or sAMAccountName)
              </p>
            </div>

            <div>
              <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">
                User DN
              </label>
              <input
                type="text"
                value={provider.userDn || ''}
                onChange={e => updateLdapProvider(index, 'userDn', e.target.value)}
                className="w-full px-3 py-2 border border-gray-300 rounded-md shadow-sm focus:ring-blue-500 focus:border-blue-500 sm:text-sm"
                placeholder="uid={{username}},ou=people,dc=example,dc=org"
              />
              <p className="text-xs text-gray-500 dark:text-gray-400 mt-1">
                User DN template (use {'{{username}}'} placeholder)
              </p>
            </div>

            <div>
              <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">
                Group Search Base
              </label>
              <input
                type="text"
                value={provider.groupSearchBase || ''}
                onChange={e => updateLdapProvider(index, 'groupSearchBase', e.target.value)}
                className="w-full px-3 py-2 border border-gray-300 rounded-md shadow-sm focus:ring-blue-500 focus:border-blue-500 sm:text-sm"
                placeholder="ou=groups,dc=example,dc=org"
              />
              <p className="text-xs text-gray-500 dark:text-gray-400 mt-1">
                Base DN for group searches
              </p>
            </div>

            <div>
              <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">
                Group Class
              </label>
              <input
                type="text"
                value={provider.groupClass ?? 'groupOfNames'}
                onChange={e => updateLdapProvider(index, 'groupClass', e.target.value)}
                className="w-full px-3 py-2 border border-gray-300 rounded-md shadow-sm focus:ring-blue-500 focus:border-blue-500 sm:text-sm"
                placeholder="groupOfNames"
              />
              <p className="text-xs text-gray-500 dark:text-gray-400 mt-1">
                LDAP group object class (groupOfNames or group for AD)
              </p>
            </div>

            <div>
              <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">
                Session Timeout (minutes)
              </label>
              <input
                type="number"
                value={provider.sessionTimeoutMinutes || 480}
                onChange={e =>
                  updateLdapProvider(index, 'sessionTimeoutMinutes', parseInt(e.target.value))
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
                id={`ldap-default-groups-${index}`}
                label={t('admin.auth.groups.defaultLabel', 'Default Groups')}
                allowCustom={false}
                availableGroups={availableGroups}
                value={Array.isArray(provider.defaultGroups) ? provider.defaultGroups : []}
                onChange={next => updateLdapProvider(index, 'defaultGroups', next)}
                placeholder={t('admin.auth.groups.searchPlaceholder', 'Search groups…')}
                helpText={t(
                  'admin.auth.groups.ldapHelp',
                  'Internal groups automatically assigned to LDAP users'
                )}
              />
            </div>

            <div className="md:col-span-2">
              <label className="flex items-center space-x-3 cursor-pointer">
                <input
                  type="checkbox"
                  checked={provider.tlsOptions?.rejectUnauthorized === false}
                  onChange={e =>
                    updateLdapProvider(
                      index,
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
                Enable when the LDAP server uses a certificate from a private or internal CA.
                Required for most on-premise ldaps:// setups.
              </p>
            </div>
          </div>
        </div>
      ))}
    </div>
  );
}

export default LdapProvidersSection;
