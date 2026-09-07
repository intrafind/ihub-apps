import { CredentialRefSelect } from '../OpenApiToolEditor';
import GroupMultiSelect from '../GroupMultiSelect';

/**
 * NtlmAuthSection - Windows Integrated Authentication (NTLM/Negotiate) settings,
 * including the optional LDAP-backed group lookup.
 */
function NtlmAuthSection({ config, onChange, t, availableGroups = [] }) {
  const updateNtlmAuth = (field, value) => {
    onChange({
      ...config,
      ntlmAuth: {
        ...config.ntlmAuth,
        [field]: value
      }
    });
  };

  return (
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
            onChange={e => updateNtlmAuth('domain', e.target.value)}
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
            onChange={e => updateNtlmAuth('domainController', e.target.value)}
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
            onChange={e => updateNtlmAuth('domainControllerUser', e.target.value)}
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
            onChange={id => updateNtlmAuth('domainControllerPasswordRef', id)}
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
            onChange={e => updateNtlmAuth('type', e.target.value)}
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
            onChange={e => updateNtlmAuth('sessionTimeoutMinutes', parseInt(e.target.value))}
            className="w-full px-3 py-2 border border-gray-300 rounded-md shadow-sm focus:ring-blue-500 focus:border-blue-500 sm:text-sm"
            placeholder="480"
          />
          <p className="text-xs text-gray-500 dark:text-gray-400 mt-1">JWT token expiration time</p>
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
            onChange={next => updateNtlmAuth('defaultGroups', next)}
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
              onChange={e => updateNtlmAuth('debug', e.target.checked)}
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
              onChange={e => updateNtlmAuth('getUserInfo', e.target.checked)}
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
              onChange={e => updateNtlmAuth('getGroups', e.target.checked)}
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
              onChange={e => updateNtlmAuth('generateJwtToken', e.target.checked)}
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
                updateNtlmAuth(
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
          onChange={e => updateNtlmAuth('ldapGroupLookupProvider', e.target.value || undefined)}
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
          Use an LDAP provider to look up user groups during login instead of relying on the domain
          controller. The LDAP provider must have admin credentials and group search configured.
        </p>
      </div>
    </div>
  );
}

export default NtlmAuthSection;
