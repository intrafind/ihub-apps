// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import Icon from '../../../shared/components/Icon';
import GroupMultiSelect from './GroupMultiSelect';
import JwtProvidersSection from './platform-form/JwtProvidersSection';
import OidcProvidersSection from './platform-form/OidcProvidersSection';
import LdapProvidersSection from './platform-form/LdapProvidersSection';
import LocalAuthSection from './platform-form/LocalAuthSection';
import NtlmAuthSection from './platform-form/NtlmAuthSection';
import { withAuthMethodEnabled } from './platform-form/authMethodDefaults';
import { CredentialRefSelect } from './OpenApiToolEditor';
import { CHECKBOX_CLASS, INPUT_CLASS, RADIO_CLASS } from './formStyles';

/** `proxyAuth.trustedProxies` when it is not set, as on the server. */
const DEFAULT_TRUSTED_PROXIES = ['loopback'];

/** Parse the comma-separated text of the trusted proxies field. */
const parseList = text =>
  text
    .split(',')
    .map(entry => entry.trim())
    .filter(Boolean);

/**
 * Comma-separated list input for `proxyAuth.trustedProxies`. Keeps its own
 * text so separators can be typed; the parsed list goes to `onChange`. When
 * the list changes from outside (for example when unsaved changes are
 * discarded), the text follows it.
 */
function TrustedProxiesInput({ value, onChange }) {
  const [text, setText] = useState(() => (value || []).join(', '));
  const [shownValue, setShownValue] = useState(value);
  if (value !== shownValue) {
    setShownValue(value);
    const list = value || [];
    if (parseList(text).join(',') !== list.join(',')) setText(list.join(', '));
  }
  return (
    <input
      id="proxy-auth-trusted-proxies"
      type="text"
      value={text}
      onChange={e => {
        setText(e.target.value);
        onChange(parseList(e.target.value));
      }}
      className={INPUT_CLASS}
      placeholder="loopback, 10.0.0.5"
    />
  );
}

/**
 * PlatformFormEditor - Form-based editor for platform configuration
 */
function PlatformFormEditor({
  value: config,
  onChange,
  onValidationChange,
  availableGroups = [],
  savedLdapProviderNames,
  hasUnsavedChanges = false
}) {
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

  // A method whose block is missing starts from its defaults (see authMethodDefaults).
  const toggleAuthMethod = (method, enabled) => {
    onChange(withAuthMethodEnabled(config, method, enabled));
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
        <Icon name="exclamation-triangle" className="h-12 w-12 mx-auto mb-4 text-gray-500" />
        <p className="text-lg font-medium">
          {t('admin.auth.noConfigData', 'No configuration data available')}
        </p>
      </div>
    );
  }

  return (
    <div className="platform-form-editor space-y-8">
      {/* Primary Authentication Mode Selection */}
      <div className="bg-white dark:bg-gray-800 rounded-lg shadow-xs border border-gray-200 dark:border-gray-700 p-6">
        <h3 className="text-lg font-semibold text-gray-900 dark:text-gray-100 mb-4">
          {t('admin.auth.mode.title', 'Primary Authentication Mode')}
        </h3>
        <p className="text-sm text-gray-600 dark:text-gray-400 mb-4">
          {t(
            'admin.auth.mode.help',
            'Select the primary authentication mode for default behavior and routing.'
          )}
        </p>
        <div className="space-y-4">
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
            {[
              {
                mode: 'proxy',
                title: t('admin.auth.mode.proxy', 'Proxy Mode'),
                desc: t(
                  'admin.auth.mode.proxyDesc',
                  'Authentication via reverse proxy or JWT tokens'
                )
              },
              {
                mode: 'local',
                title: t('admin.auth.mode.local', 'Local Mode'),
                desc: t('admin.auth.mode.localDesc', 'Built-in username/password authentication')
              },
              {
                mode: 'oidc',
                title: t('admin.auth.mode.oidc', 'OIDC Mode'),
                desc: t('admin.auth.mode.oidcDesc', 'OpenID Connect with external providers')
              },
              {
                mode: 'ldap',
                title: t('admin.auth.mode.ldap', 'LDAP Mode'),
                desc: t('admin.auth.mode.ldapDesc', 'LDAP/Active Directory authentication')
              },
              {
                mode: 'ntlm',
                title: t('admin.auth.mode.ntlm', 'NTLM Mode'),
                desc: t(
                  'admin.auth.mode.ntlmDesc',
                  'Windows Integrated Authentication (NTLM/Kerberos)'
                )
              },
              {
                mode: 'anonymous',
                title: t('admin.auth.mode.anonymous', 'Anonymous Mode'),
                desc: t('admin.auth.mode.anonymousDesc', 'No authentication required (default)')
              }
            ].map(modeOption => (
              <div
                role="presentation"
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
                    aria-labelledby={`auth-mode-${modeOption.mode}-title`}
                    className={`${RADIO_CLASS} mr-2`}
                  />
                  <h4
                    id={`auth-mode-${modeOption.mode}-title`}
                    className="font-medium text-gray-900 dark:text-gray-100"
                  >
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
      <div className="bg-white dark:bg-gray-800 rounded-lg shadow-xs border border-gray-200 dark:border-gray-700 p-6">
        <h3 className="text-lg font-semibold text-gray-900 dark:text-gray-100 mb-4">
          {t('admin.auth.methods', 'Authentication Methods')}
        </h3>
        <p className="text-sm text-gray-600 dark:text-gray-400 mb-4">
          {t(
            'admin.auth.methodsHelp',
            'Enable multiple authentication methods simultaneously. Users can choose their preferred login method.'
          )}
        </p>
        <div className="space-y-4">
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            <div>
              <label className="flex items-center gap-3 text-sm font-medium text-gray-900 dark:text-gray-100">
                <input
                  type="checkbox"
                  checked={config.proxyAuth?.enabled || false}
                  onChange={e => toggleAuthMethod('proxyAuth', e.target.checked)}
                  className={CHECKBOX_CLASS}
                />
                {t('admin.auth.methodNames.proxy', 'Proxy/JWT Authentication')}
              </label>
              <p className="ml-7 text-xs text-gray-500 dark:text-gray-400">
                {t('admin.auth.methodNames.proxyDesc', 'Headers or JWT tokens from reverse proxy')}
              </p>
            </div>

            <div>
              <label className="flex items-center gap-3 text-sm font-medium text-gray-900 dark:text-gray-100">
                <input
                  type="checkbox"
                  checked={config.localAuth?.enabled || false}
                  onChange={e => toggleAuthMethod('localAuth', e.target.checked)}
                  className={CHECKBOX_CLASS}
                />
                {t('admin.auth.methodNames.local', 'Local Authentication')}
              </label>
              <p className="ml-7 text-xs text-gray-500 dark:text-gray-400">
                {t('admin.auth.builtInSystem', 'Built-in username/password system')}
              </p>
            </div>

            <div>
              <label className="flex items-center gap-3 text-sm font-medium text-gray-900 dark:text-gray-100">
                <input
                  type="checkbox"
                  checked={config.oidcAuth?.enabled || false}
                  onChange={e => toggleAuthMethod('oidcAuth', e.target.checked)}
                  className={CHECKBOX_CLASS}
                />
                {t('admin.auth.methodNames.oidc', 'OIDC Authentication')}
              </label>
              <p className="ml-7 text-xs text-gray-500 dark:text-gray-400">
                {t('admin.auth.methodNames.oidcDesc', 'OpenID Connect providers (Google, etc.)')}
              </p>
            </div>

            <div>
              <label className="flex items-center gap-3 text-sm font-medium text-gray-900 dark:text-gray-100">
                <input
                  type="checkbox"
                  checked={config.ldapAuth?.enabled || false}
                  onChange={e => toggleAuthMethod('ldapAuth', e.target.checked)}
                  className={CHECKBOX_CLASS}
                />
                {t('admin.auth.methodNames.ldap', 'LDAP Authentication')}
              </label>
              <p className="ml-7 text-xs text-gray-500 dark:text-gray-400">
                {t(
                  'admin.auth.methodNames.ldapDesc',
                  'LDAP/Active Directory authentication with multiple providers'
                )}
              </p>
            </div>

            <div>
              <label className="flex items-center gap-3 text-sm font-medium text-gray-900 dark:text-gray-100">
                <input
                  type="checkbox"
                  checked={config.ntlmAuth?.enabled || false}
                  onChange={e => toggleAuthMethod('ntlmAuth', e.target.checked)}
                  className={CHECKBOX_CLASS}
                />
                {t('admin.auth.methodNames.ntlm', 'NTLM Authentication')}
              </label>
              <p className="ml-7 text-xs text-gray-500 dark:text-gray-400">
                {t('admin.auth.methodNames.ntlmDesc', 'Windows Integrated Authentication (NTLM)')}
              </p>
            </div>

            <div>
              <label className="flex items-center gap-3 text-sm font-medium text-gray-900 dark:text-gray-100">
                <input
                  type="checkbox"
                  checked={config.anonymousAuth?.enabled || false}
                  onChange={e => toggleAuthMethod('anonymousAuth', e.target.checked)}
                  className={CHECKBOX_CLASS}
                />
                {t('admin.auth.anonymousAccess', 'Anonymous Access')}
              </label>
              <p className="ml-7 text-xs text-gray-500 dark:text-gray-400">
                {t(
                  'admin.auth.methodNames.anonymousDesc',
                  'Allow users to access without authentication'
                )}
              </p>
            </div>
          </div>
        </div>
      </div>

      {/* General Authentication Settings */}
      <div className="bg-white dark:bg-gray-800 rounded-lg shadow-xs border border-gray-200 dark:border-gray-700 p-6">
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
              onChange={next => updateNestedConfig('auth', 'authenticatedGroup', next.at(-1) || '')}
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
        <div className="bg-white dark:bg-gray-800 rounded-lg shadow-xs border border-gray-200 dark:border-gray-700 p-6">
          <h3 className="text-lg font-semibold text-gray-900 dark:text-gray-100 mb-4">
            {t('admin.auth.proxy.settingsTitle', 'Proxy/JWT Authentication Settings')}
          </h3>
          <p className="text-sm text-gray-600 dark:text-gray-400 mb-4">
            {t(
              'admin.auth.proxy.settingsHelp',
              'Configure header-based authentication from reverse proxy and/or JWT token validation for pure JWT authentication.'
            )}
          </p>
          <div className="space-y-4">
            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
              <div>
                <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">
                  {t('admin.auth.proxy.userHeader', 'User Header')}
                </label>
                <input
                  type="text"
                  value={config.proxyAuth?.userHeader || ''}
                  onChange={e => updateNestedConfig('proxyAuth', 'userHeader', e.target.value)}
                  className={INPUT_CLASS}
                  placeholder="X-Forwarded-User"
                />
              </div>
              <div>
                <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">
                  {t('admin.auth.proxy.groupsHeader', 'Groups Header')}
                </label>
                <input
                  type="text"
                  value={config.proxyAuth?.groupsHeader || ''}
                  onChange={e => updateNestedConfig('proxyAuth', 'groupsHeader', e.target.value)}
                  className={INPUT_CLASS}
                  placeholder="X-Forwarded-Groups"
                />
              </div>
            </div>

            {/* Where the identity headers may come from */}
            {!(config.proxyAuth?.trustedProxies ?? DEFAULT_TRUSTED_PROXIES).length &&
              !config.proxyAuth?.sharedSecretRef && (
                <div
                  role="alert"
                  className="p-3 rounded-md border bg-amber-50 dark:bg-amber-900/30 border-amber-200 dark:border-amber-800 text-sm text-amber-800 dark:text-amber-200"
                >
                  {t(
                    'admin.auth.proxy.headersIgnoredWarning',
                    'Unless PROXY_AUTH_TRUSTED_PROXIES or PROXY_AUTH_SHARED_SECRET is set on the server, the user and groups headers are ignored until you list trusted proxies or select a shared secret. Without one, any client that can reach the server could set them.'
                  )}
                </div>
              )}
            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
              <div>
                <label
                  htmlFor="proxy-auth-trusted-proxies"
                  className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1"
                >
                  {t('admin.auth.proxy.trustedProxiesLabel', 'Trusted Proxies')}
                </label>
                <TrustedProxiesInput
                  value={config.proxyAuth?.trustedProxies ?? DEFAULT_TRUSTED_PROXIES}
                  onChange={list => updateNestedConfig('proxyAuth', 'trustedProxies', list)}
                />
                <p className="text-xs text-gray-500 dark:text-gray-400 mt-1">
                  {t(
                    'admin.auth.proxy.trustedProxiesHelp',
                    'Addresses or subnets the proxy connects from, comma-separated (for example loopback, 10.0.0.5 or 10.0.0.0/8). The headers are used only on connections from these addresses. The default, loopback, covers a proxy on the same host or in the same pod; if other local processes (such as a service-mesh sidecar) forward traffic to iHub, set a shared secret as well.'
                  )}
                </p>
              </div>
              <div>
                <label
                  htmlFor="proxy-auth-shared-secret-header"
                  className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1"
                >
                  {t('admin.auth.proxy.sharedSecretHeaderLabel', 'Shared Secret Header')}
                </label>
                <input
                  id="proxy-auth-shared-secret-header"
                  type="text"
                  value={config.proxyAuth?.sharedSecretHeader || ''}
                  onChange={e =>
                    updateNestedConfig(
                      'proxyAuth',
                      'sharedSecretHeader',
                      e.target.value || undefined
                    )
                  }
                  className={INPUT_CLASS}
                  placeholder="X-Proxy-Secret"
                />
              </div>
            </div>
            <CredentialRefSelect
              id="proxy-auth-shared-secret"
              value={config.proxyAuth?.sharedSecretRef || ''}
              onChange={id => updateNestedConfig('proxyAuth', 'sharedSecretRef', id || undefined)}
              types={['secret']}
              label={t('admin.auth.proxy.sharedSecretLabel', 'Shared Secret')}
              help={t(
                'admin.auth.proxy.sharedSecretHelp',
                'A secret the proxy sends in the shared secret header. When set, the headers are used only on requests that carry it. Together with trusted proxies, both must match: for a proxy elsewhere, add its address above or clear the list to rely on the secret alone.'
              )}
            />

            {/* Self-signup Setting */}
            <div>
              <label className="flex items-center">
                <input
                  type="checkbox"
                  checked={config.proxyAuth?.allowSelfSignup || false}
                  onChange={e =>
                    updateNestedConfig('proxyAuth', 'allowSelfSignup', e.target.checked)
                  }
                  className={`${CHECKBOX_CLASS} mr-2`}
                />
                <span className="text-sm font-medium text-gray-700 dark:text-gray-300">
                  {t('admin.auth.allowSelfSignup', 'Allow Self-Signup')}
                </span>
              </label>
              <p className="text-xs text-gray-500 dark:text-gray-400 mt-1">
                {t(
                  'admin.auth.proxy.selfSignupHelp',
                  'Allow new users to register automatically through proxy authentication. If disabled, new users must be added manually by administrators.'
                )}
              </p>
            </div>

            {/* LDAP Group Lookup */}
            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
              <div>
                <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">
                  {t('admin.auth.ldapGroupLookup.provider', 'LDAP Group Lookup Provider')}
                </label>
                <select
                  value={config.proxyAuth?.ldapGroupLookupProvider || ''}
                  onChange={e =>
                    updateNestedConfig(
                      'proxyAuth',
                      'ldapGroupLookupProvider',
                      e.target.value || undefined
                    )
                  }
                  className={INPUT_CLASS}
                >
                  <option value="">
                    {t('admin.auth.proxy.ldapLookupNone', 'None (use header/JWT groups only)')}
                  </option>
                  {(config.ldapAuth?.providers || []).map(p => (
                    <option key={p.name} value={p.name}>
                      {p.displayName || p.name}
                    </option>
                  ))}
                </select>
                <p className="text-xs text-gray-500 dark:text-gray-400 mt-1">
                  {t(
                    'admin.auth.proxy.ldapLookupHelp',
                    "When set, look up the authenticated user's group memberships in the selected LDAP provider and merge them with the groups supplied via the groups header and JWT claim. The LDAP provider must have admin credentials and group search configured."
                  )}
                </p>
              </div>
              <div>
                <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">
                  {t('admin.auth.ldapGroupLookup.cacheTtl', 'LDAP Group Cache TTL (seconds)')}
                </label>
                <input
                  type="number"
                  min="0"
                  value={config.proxyAuth?.ldapGroupLookupCacheTtlSeconds ?? 600}
                  onChange={e =>
                    updateNestedConfig(
                      'proxyAuth',
                      'ldapGroupLookupCacheTtlSeconds',
                      Number(e.target.value)
                    )
                  }
                  className={INPUT_CLASS}
                  placeholder="600"
                />
                <p className="text-xs text-gray-500 dark:text-gray-400 mt-1">
                  {t(
                    'admin.auth.ldapGroupLookup.cacheTtlHelp',
                    'How long to cache LDAP group results per user. Set to 0 to disable caching.'
                  )}
                </p>
              </div>
            </div>

            {/* JWT Providers */}
            <JwtProvidersSection config={config} onChange={onChange} t={t} />
          </div>
        </div>
      )}

      {/* Local Auth Configuration */}
      {config.localAuth?.enabled && <LocalAuthSection config={config} onChange={onChange} />}

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
        savedProviderNames={savedLdapProviderNames}
        hasUnsavedChanges={hasUnsavedChanges}
      />

      {/* NTLM Configuration */}
      {config.ntlmAuth?.enabled && (
        <NtlmAuthSection
          config={config}
          onChange={onChange}
          t={t}
          availableGroups={availableGroups}
        />
      )}

      {/* Authentication Debug Settings — consolidated onto the Logging page */}
      <div className="bg-blue-50 dark:bg-blue-900/20 rounded-lg border border-blue-200 dark:border-blue-800 p-4">
        <div className="flex items-start">
          <Icon
            name="information-circle"
            className="h-5 w-5 mr-2 text-blue-600 dark:text-blue-400 shrink-0 mt-0.5"
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
