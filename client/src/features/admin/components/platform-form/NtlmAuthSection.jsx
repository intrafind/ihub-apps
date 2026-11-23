// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

import GroupMultiSelect from '../GroupMultiSelect';
import { CHECKBOX_CLASS, INPUT_CLASS } from '../formStyles';

/**
 * NtlmAuthSection - Windows Integrated Authentication (NTLM) settings,
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
    <div className="bg-white dark:bg-gray-800 rounded-lg shadow-xs border border-gray-200 dark:border-gray-700 p-6">
      <h3 className="text-lg font-semibold text-gray-900 dark:text-gray-100 mb-4">
        {t('admin.auth.ntlm.title', 'NTLM Authentication Settings')}
      </h3>
      <p className="text-sm text-gray-600 dark:text-gray-400 mb-4">
        {t(
          'admin.auth.ntlm.help',
          'Configure Windows Integrated Authentication (NTLM) for domain users.'
        )}
      </p>
      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        <div>
          <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">
            {t('admin.auth.ntlm.domain', 'Domain Name')}
          </label>
          <input
            type="text"
            value={config.ntlmAuth?.domain || ''}
            onChange={e => updateNtlmAuth('domain', e.target.value)}
            className={INPUT_CLASS}
            placeholder="EXAMPLE"
          />
          <p className="text-xs text-gray-500 dark:text-gray-400 mt-1">
            {t('admin.auth.ntlm.domainHelp', 'Windows domain name (e.g., EXAMPLE, MUC)')}
          </p>
        </div>
        <div>
          <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">
            {t('admin.auth.ntlm.domainController', 'Domain Controller URL')}
          </label>
          <input
            type="text"
            value={config.ntlmAuth?.domainController || ''}
            onChange={e => updateNtlmAuth('domainController', e.target.value)}
            className={INPUT_CLASS}
            placeholder="ldaps://dc.example.com:636"
          />
          <p className="text-xs text-gray-500 dark:text-gray-400 mt-1">
            {t(
              'admin.auth.ntlm.domainControllerHelp',
              'LDAP URL of the domain controller that checks the sign-in (e.g., ldaps://dc.example.com:636, or ldap://dc.example.com:389 for an unencrypted connection)'
            )}
          </p>
        </div>
        <div>
          <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">
            {t('admin.auth.sessionTimeout', 'Session Timeout (minutes)')}
          </label>
          <input
            type="number"
            value={config.ntlmAuth?.sessionTimeoutMinutes || 480}
            onChange={e => updateNtlmAuth('sessionTimeoutMinutes', Number.parseInt(e.target.value))}
            className={INPUT_CLASS}
            placeholder="480"
          />
          <p className="text-xs text-gray-500 dark:text-gray-400 mt-1">
            {t('admin.auth.ntlm.sessionTimeoutHelp', 'JWT token expiration time')}
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
              className={`${CHECKBOX_CLASS} mr-2`}
            />
            <span className="text-sm font-medium text-gray-700 dark:text-gray-300">
              {t('admin.auth.ntlm.debug', 'Enable Debug Logging')}
            </span>
          </label>
          <p className="text-xs text-gray-500 dark:text-gray-400 mt-1">
            {t('admin.auth.ntlm.debugHelp', 'Log detailed NTLM authentication information')}
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
              className={CHECKBOX_CLASS}
            />
            <span className="text-sm font-medium text-gray-700 dark:text-gray-300">
              {t(
                'admin.auth.ntlm.selfSigned',
                'Allow self-signed / internal CA certificates (ldaps://)'
              )}
            </span>
          </label>
          <p className="text-xs text-gray-500 dark:text-gray-400 mt-1 ml-7">
            {t(
              'admin.auth.ntlm.selfSignedHelp',
              'Enable when the domain controller uses a certificate from a private or internal CA. Required for most on-premise ldaps:// setups.'
            )}
          </p>
        </div>
      </div>

      {/* LDAP Group Lookup Provider */}
      <div className="mt-4">
        <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">
          {t('admin.auth.ldapGroupLookup.provider', 'LDAP Group Lookup Provider')}
        </label>
        <select
          value={config.ntlmAuth?.ldapGroupLookupProvider || ''}
          onChange={e => updateNtlmAuth('ldapGroupLookupProvider', e.target.value || undefined)}
          className={INPUT_CLASS}
        >
          <option value="">
            {t('admin.auth.ntlm.ldapLookupNone', 'None (default groups only)')}
          </option>
          {(config.ldapAuth?.providers || []).map(p => (
            <option key={p.name} value={p.name}>
              {p.displayName || p.name}
            </option>
          ))}
        </select>
        <p className="text-xs text-gray-500 dark:text-gray-400 mt-1">
          {t(
            'admin.auth.ntlm.ldapLookupHelp',
            'NTLM sign-in returns no groups. To give NTLM users their directory groups, pick an LDAP provider with admin credentials and group search configured; without one, NTLM users get only the default groups.'
          )}
        </p>
      </div>
    </div>
  );
}

export default NtlmAuthSection;
