/**
 * Client-side mirror of the LDAP provider derivations in
 * `server/utils/ldapProviderConfig.js`, used only to show an admin what an
 * empty advanced field will resolve to. The server stays the source of truth —
 * nothing here is written into the configuration, and the connection test
 * reports the values the server actually resolved.
 */

export const LDAP_PRESETS = {
  openldap: {
    id: 'openldap',
    label: 'OpenLDAP / generic LDAP',
    usernameAttribute: 'uid',
    groupClass: 'groupOfNames',
    groupMemberAttribute: 'member',
    groupMemberUserAttribute: 'dn',
    attributeMapping: {
      id: ['uid', 'sAMAccountName', 'cn'],
      name: ['displayName', 'cn', 'name'],
      email: ['mail', 'email']
    }
  },
  activeDirectory: {
    id: 'activeDirectory',
    label: 'Active Directory',
    usernameAttribute: 'sAMAccountName',
    groupClass: 'group',
    groupMemberAttribute: 'member',
    groupMemberUserAttribute: 'dn',
    attributeMapping: {
      id: ['sAMAccountName', 'uid', 'cn'],
      name: ['displayName', 'cn', 'name'],
      email: ['mail', 'userPrincipalName']
    }
  }
};

export const DEFAULT_LDAP_PRESET = 'openldap';

const trimmed = value => (typeof value === 'string' ? value.trim() : '');

/**
 * Resolve the values a provider falls back to for the fields an admin can
 * leave empty.
 * @param {Object} provider - Provider entry as edited in the form
 * @returns {Object} Derived values, for use as input placeholders
 */
export function deriveLdapDefaults(provider = {}) {
  const preset = LDAP_PRESETS[provider.preset] || LDAP_PRESETS[DEFAULT_LDAP_PRESET];
  const baseDn = trimmed(provider.baseDn);
  const userSearchBase = trimmed(provider.userSearchBase) || baseDn;
  const usernameAttribute = trimmed(provider.usernameAttribute) || preset.usernameAttribute;

  return {
    preset,
    userSearchBase,
    usernameAttribute,
    userDn: userSearchBase ? `${usernameAttribute}={{username}},${userSearchBase}` : '',
    groupSearchBase: trimmed(provider.groupSearchBase) || baseDn,
    groupClass: preset.groupClass,
    groupMemberAttribute: preset.groupMemberAttribute,
    groupMemberUserAttribute: preset.groupMemberUserAttribute,
    attributeMapping: preset.attributeMapping
  };
}
