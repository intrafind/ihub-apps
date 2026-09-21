import { useState } from 'react';
import Icon from '../../../../shared/components/Icon';
import { CredentialRefSelect } from '../OpenApiToolEditor';
import GroupMultiSelect from '../GroupMultiSelect';
import LdapLoginTest from './LdapLoginTest';
import { LDAP_PRESETS, DEFAULT_LDAP_PRESET, deriveLdapDefaults } from '../../utils/ldapPresets';

/**
 * LdapProvidersSection - LDAP authentication settings card: provider list
 * (add/update/remove), shown when LDAP or NTLM is enabled (NTLM can use LDAP
 * for group lookup).
 *
 * A provider needs three things: the server URL, the directory's base DN and
 * which kind of directory it is. Search bases, the user DN template, the group
 * object class and the attribute mapping are all derived from those (see
 * `server/utils/ldapProviderConfig.js`), so they live under "Advanced" with the
 * derived value shown as the placeholder — typing one only overrides it.
 */

const INPUT_CLASS =
  'w-full px-3 py-2 border border-gray-300 dark:border-gray-600 dark:bg-gray-700 dark:text-gray-100 rounded-md shadow-xs focus:ring-blue-500 focus:border-blue-500 sm:text-sm';

/** A labelled text input with help text, optionally spanning both columns. */
function Field({ id, label, value, onChange, placeholder, help, type = 'text', wide = false }) {
  return (
    <div className={wide ? 'md:col-span-2' : undefined}>
      <label
        htmlFor={id}
        className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1"
      >
        {label}
      </label>
      <input
        id={id}
        type={type}
        value={value ?? ''}
        onChange={e => onChange(e.target.value)}
        className={INPUT_CLASS}
        placeholder={placeholder}
      />
      {help && <p className="text-xs text-gray-500 dark:text-gray-400 mt-1">{help}</p>}
    </div>
  );
}

function LdapProvidersSection({ config, onChange, t, availableGroups = [] }) {
  const [advancedOpen, setAdvancedOpen] = useState({});

  const setProviders = providers =>
    onChange({ ...config, ldapAuth: { ...config.ldapAuth, providers } });

  const addLdapProvider = () => {
    // Only the fields an admin really has to decide on. Everything else is
    // derived from `preset` + `baseDn` until it is explicitly overridden.
    const newProvider = {
      name: '',
      displayName: '',
      url: '',
      preset: DEFAULT_LDAP_PRESET,
      baseDn: '',
      adminDn: '',
      defaultGroups: [],
      sessionTimeoutMinutes: 480
    };
    setProviders([...(config.ldapAuth?.providers || []), newProvider]);
  };

  const updateLdapProvider = (index, field, value) => {
    const providers = [...(config.ldapAuth?.providers || [])];
    providers[index] = { ...providers[index], [field]: value };
    setProviders(providers);
  };

  const updateAttributeMapping = (index, field, rawValue) => {
    const providers = [...(config.ldapAuth?.providers || [])];
    const mapping = { ...(providers[index]?.attributeMapping || {}) };
    const attributes = rawValue
      .split(',')
      .map(entry => entry.trim())
      .filter(Boolean);

    if (attributes.length === 0) {
      delete mapping[field];
    } else {
      mapping[field] = attributes;
    }

    providers[index] = {
      ...providers[index],
      ...(Object.keys(mapping).length > 0
        ? { attributeMapping: mapping }
        : { attributeMapping: undefined })
    };
    setProviders(providers);
  };

  const removeLdapProvider = index => {
    const providers = [...(config.ldapAuth?.providers || [])];
    providers.splice(index, 1);
    setProviders(providers);
  };

  if (!(config.ldapAuth?.enabled || config.ntlmAuth?.enabled)) {
    return null;
  }

  const mappingValue = (provider, field) => {
    const raw = provider.attributeMapping?.[field];
    if (!raw) return '';
    return Array.isArray(raw) ? raw.join(', ') : raw;
  };

  return (
    <div className="bg-white dark:bg-gray-800 rounded-lg shadow-xs border border-gray-200 dark:border-gray-700 p-6">
      <div className="flex justify-between items-center mb-4">
        <div>
          <h3 className="text-lg font-semibold text-gray-900 dark:text-gray-100">
            {t('admin.auth.ldap.title', 'LDAP Authentication Settings')}
          </h3>
          <p className="text-sm text-gray-600 dark:text-gray-400 mt-1">
            {t(
              'admin.auth.ldap.subtitle',
              'Configure LDAP/Active Directory authentication providers'
            )}
          </p>
        </div>
        <button
          type="button"
          onClick={addLdapProvider}
          className="px-4 py-2 bg-blue-600 text-white rounded-md hover:bg-blue-700 focus:outline-hidden focus:ring-2 focus:ring-blue-500 focus:ring-offset-2 text-sm font-medium"
        >
          <Icon name="plus" className="h-4 w-4 inline-block mr-1" />
          {t('admin.auth.ldap.add', 'Add LDAP Provider')}
        </button>
      </div>

      {config.ldapAuth?.providers?.length === 0 && (
        <div className="text-center py-8 text-gray-500 dark:text-gray-400">
          <Icon name="server" className="h-12 w-12 mx-auto mb-2 text-gray-400" />
          <p>{t('admin.auth.ldap.empty', 'No LDAP providers configured')}</p>
          <p className="text-sm mt-1">
            {t('admin.auth.ldap.emptyHint', 'Click "Add LDAP Provider" to get started')}
          </p>
        </div>
      )}

      {config.ldapAuth?.providers?.map((provider, index) => {
        const derived = deriveLdapDefaults(provider);
        const showAdvanced = Boolean(advancedOpen[index]);
        const derivedHelp = t(
          'admin.auth.ldap.derivedHelp',
          'Leave empty to use the value shown — it follows from the directory type and base DN.'
        );

        return (
          <div
            key={index}
            className="mb-6 p-6 border border-gray-200 dark:border-gray-700 rounded-lg"
          >
            <div className="flex justify-between items-start mb-4">
              <div className="flex items-center space-x-2">
                <h4 className="text-md font-semibold text-gray-900 dark:text-gray-100">
                  {t('admin.auth.ldap.providerHeading', 'LDAP Provider {{number}}', {
                    number: index + 1
                  })}
                  {provider.displayName && `: ${provider.displayName}`}
                </h4>
              </div>
              <button
                type="button"
                onClick={() => removeLdapProvider(index)}
                className="text-red-600 hover:text-red-800 text-sm font-medium"
                aria-label={t('admin.auth.ldap.remove', 'Remove this LDAP provider')}
              >
                <Icon name="trash" className="h-4 w-4" />
              </button>
            </div>

            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
              <Field
                id={`ldap-name-${index}`}
                label={t('admin.auth.ldap.name', 'Provider Name')}
                value={provider.name}
                onChange={value => updateLdapProvider(index, 'name', value)}
                placeholder="corporate-ldap"
                help={t('admin.auth.ldap.nameHelp', 'Internal identifier for this provider')}
              />

              <Field
                id={`ldap-display-name-${index}`}
                label={t('admin.auth.ldap.displayName', 'Display Name')}
                value={provider.displayName}
                onChange={value => updateLdapProvider(index, 'displayName', value)}
                placeholder={provider.name || 'Corporate LDAP'}
                help={t(
                  'admin.auth.ldap.displayNameHelp',
                  'Shown on the login page. Defaults to the provider name.'
                )}
              />

              <Field
                id={`ldap-url-${index}`}
                label={t('admin.auth.ldap.url', 'LDAP URL')}
                value={provider.url}
                onChange={value => updateLdapProvider(index, 'url', value)}
                placeholder="ldap://ldap.example.com:389"
                help={t(
                  'admin.auth.ldap.urlHelp',
                  'ldap://host:389 for plain connections, ldaps://host:636 for TLS'
                )}
                wide
              />

              <div>
                <label
                  htmlFor={`ldap-preset-${index}`}
                  className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1"
                >
                  {t('admin.auth.ldap.preset', 'Directory Type')}
                </label>
                <select
                  id={`ldap-preset-${index}`}
                  value={provider.preset || DEFAULT_LDAP_PRESET}
                  onChange={e => updateLdapProvider(index, 'preset', e.target.value)}
                  className={INPUT_CLASS}
                >
                  {Object.values(LDAP_PRESETS).map(preset => (
                    <option key={preset.id} value={preset.id}>
                      {t(`admin.auth.ldap.presetLabel.${preset.id}`, preset.label)}
                    </option>
                  ))}
                </select>
                <p className="text-xs text-gray-500 dark:text-gray-400 mt-1">
                  {t('admin.auth.ldap.presetHelp', 'Sets the attribute defaults: {{attributes}}', {
                    attributes: `${derived.usernameAttribute}, ${derived.groupClass}`
                  })}
                </p>
              </div>

              <Field
                id={`ldap-base-dn-${index}`}
                label={t('admin.auth.ldap.baseDn', 'Base DN')}
                value={provider.baseDn}
                onChange={value => updateLdapProvider(index, 'baseDn', value)}
                placeholder="dc=example,dc=org"
                help={t(
                  'admin.auth.ldap.baseDnHelp',
                  'Root of the directory. Users and groups are searched here unless overridden.'
                )}
              />

              <Field
                id={`ldap-admin-dn-${index}`}
                label={t('admin.auth.ldap.adminDn', 'Bind DN')}
                value={provider.adminDn}
                onChange={value => updateLdapProvider(index, 'adminDn', value)}
                placeholder="cn=admin,dc=example,dc=org"
                help={t(
                  'admin.auth.ldap.adminDnHelp',
                  'Service account used to find users and read their groups. Leave empty to bind as the user directly.'
                )}
              />

              <div>
                <CredentialRefSelect
                  value={provider.adminPasswordRef || ''}
                  onChange={id => updateLdapProvider(index, 'adminPasswordRef', id)}
                  types={['secret', 'basic']}
                  label={t('admin.auth.ldap.adminPassword', 'Bind Password')}
                  help={t(
                    'admin.auth.ldap.adminPasswordHelp',
                    'Select a stored credential profile holding the bind password.'
                  )}
                />
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
                    className="h-4 w-4 text-blue-600 border-gray-300 rounded-sm focus:ring-blue-500"
                  />
                  <span className="text-sm font-medium text-gray-700 dark:text-gray-300">
                    {t(
                      'admin.auth.ldap.selfSigned',
                      'Allow self-signed / internal CA certificates (ldaps://)'
                    )}
                  </span>
                </label>
                <p className="text-xs text-gray-500 dark:text-gray-400 mt-1 ml-7">
                  {t(
                    'admin.auth.ldap.selfSignedHelp',
                    'Enable when the LDAP server uses a certificate from a private or internal CA. Required for most on-premise ldaps:// setups.'
                  )}
                </p>
              </div>

              <div className="md:col-span-2 border-t border-gray-200 dark:border-gray-700 pt-4">
                <button
                  type="button"
                  onClick={() => setAdvancedOpen(prev => ({ ...prev, [index]: !prev[index] }))}
                  aria-expanded={showAdvanced}
                  className="inline-flex items-center text-sm font-medium text-gray-700 dark:text-gray-300 hover:text-gray-900 dark:hover:text-gray-100"
                >
                  <Icon
                    name={showAdvanced ? 'chevron-up' : 'chevron-down'}
                    size="sm"
                    className="mr-1"
                  />
                  {t('admin.auth.ldap.advanced', 'Advanced: search bases and attributes')}
                </button>
                {!showAdvanced && (
                  <p className="text-xs text-gray-500 dark:text-gray-400 mt-1">
                    {t(
                      'admin.auth.ldap.advancedHint',
                      'Only needed when the directory does not follow the defaults of the selected type.'
                    )}
                  </p>
                )}
              </div>

              {showAdvanced && (
                <>
                  <Field
                    id={`ldap-user-search-base-${index}`}
                    label={t('admin.auth.ldap.userSearchBase', 'User Search Base')}
                    value={provider.userSearchBase}
                    onChange={value => updateLdapProvider(index, 'userSearchBase', value)}
                    placeholder={derived.userSearchBase || 'ou=people,dc=example,dc=org'}
                    help={derivedHelp}
                  />

                  <Field
                    id={`ldap-username-attribute-${index}`}
                    label={t('admin.auth.ldap.usernameAttribute', 'Username Attribute')}
                    value={provider.usernameAttribute}
                    onChange={value => updateLdapProvider(index, 'usernameAttribute', value)}
                    placeholder={derived.usernameAttribute}
                    help={derivedHelp}
                  />

                  <Field
                    id={`ldap-user-dn-${index}`}
                    label={t('admin.auth.ldap.userDn', 'User DN Template')}
                    value={provider.userDn}
                    onChange={value => updateLdapProvider(index, 'userDn', value)}
                    placeholder={derived.userDn}
                    help={t(
                      'admin.auth.ldap.userDnHelp',
                      'Used only when no bind DN is set. Leave empty to use the value shown.'
                    )}
                    wide
                  />

                  <Field
                    id={`ldap-group-search-base-${index}`}
                    label={t('admin.auth.ldap.groupSearchBase', 'Group Search Base')}
                    value={provider.groupSearchBase}
                    onChange={value => updateLdapProvider(index, 'groupSearchBase', value)}
                    placeholder={derived.groupSearchBase || 'ou=groups,dc=example,dc=org'}
                    help={t(
                      'admin.auth.ldap.groupSearchBaseHelp',
                      'Leave empty to search from the base DN. Without either, no LDAP groups are read.'
                    )}
                  />

                  <Field
                    id={`ldap-group-class-${index}`}
                    label={t('admin.auth.ldap.groupClass', 'Group Object Class')}
                    value={provider.groupClass}
                    onChange={value => updateLdapProvider(index, 'groupClass', value)}
                    placeholder={derived.groupClass}
                    help={derivedHelp}
                  />

                  <Field
                    id={`ldap-group-member-attribute-${index}`}
                    label={t('admin.auth.ldap.groupMemberAttribute', 'Group Member Attribute')}
                    value={provider.groupMemberAttribute}
                    onChange={value => updateLdapProvider(index, 'groupMemberAttribute', value)}
                    placeholder={derived.groupMemberAttribute}
                    help={derivedHelp}
                  />

                  <Field
                    id={`ldap-group-member-user-attribute-${index}`}
                    label={t('admin.auth.ldap.groupMemberUserAttribute', 'Member Value Attribute')}
                    value={provider.groupMemberUserAttribute}
                    onChange={value => updateLdapProvider(index, 'groupMemberUserAttribute', value)}
                    placeholder={derived.groupMemberUserAttribute}
                    help={t(
                      'admin.auth.ldap.groupMemberUserAttributeHelp',
                      'The user attribute that group entries reference. Usually dn.'
                    )}
                  />

                  <Field
                    id={`ldap-session-timeout-${index}`}
                    label={t('admin.auth.ldap.sessionTimeout', 'Session Timeout (minutes)')}
                    type="number"
                    value={provider.sessionTimeoutMinutes ?? ''}
                    onChange={value =>
                      updateLdapProvider(
                        index,
                        'sessionTimeoutMinutes',
                        value === '' ? undefined : parseInt(value, 10)
                      )
                    }
                    placeholder="480"
                    help={t('admin.auth.ldap.sessionTimeoutHelp', 'JWT token expiration time')}
                  />

                  <div className="md:col-span-2">
                    <p className="text-sm font-medium text-gray-700 dark:text-gray-300">
                      {t('admin.auth.ldap.attributeMapping', 'Attribute Mapping')}
                    </p>
                    <p className="text-xs text-gray-500 dark:text-gray-400 mt-1">
                      {t(
                        'admin.auth.ldap.attributeMappingHelp',
                        'Which LDAP attributes become the user id, name and e-mail. Comma-separated: the first attribute with a value wins.'
                      )}
                    </p>
                  </div>

                  {['id', 'name', 'email'].map(field => (
                    <Field
                      key={field}
                      id={`ldap-attribute-${field}-${index}`}
                      label={t(`admin.auth.ldap.attribute.${field}`, field)}
                      value={mappingValue(provider, field)}
                      onChange={value => updateAttributeMapping(index, field, value)}
                      placeholder={derived.attributeMapping[field].join(', ')}
                      help={derivedHelp}
                    />
                  ))}
                </>
              )}

              <LdapLoginTest provider={provider} />
            </div>
          </div>
        );
      })}
    </div>
  );
}

export default LdapProvidersSection;
