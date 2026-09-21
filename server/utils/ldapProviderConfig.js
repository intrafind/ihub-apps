import logger from './logger.js';

/**
 * LDAP provider configuration: presets, derivation and attribute mapping.
 *
 * A provider really only needs three facts: where the directory is (`url`),
 * where its entries live (`baseDn`) and which flavour of directory it is
 * (`preset`). Everything else an LDAP client needs — the user search base, the
 * user DN template, the group search base, the group object class, the
 * attributes a user's id/name/email come from — follows from those. Spelling
 * each one out per provider is what made the configuration read like the same
 * DN typed five times:
 *
 *   userSearchBase:  ou=people,dc=example,dc=org
 *   userDn:          uid={{username}},ou=people,dc=example,dc=org
 *   groupSearchBase: ou=groups,dc=example,dc=org
 *
 * Deriving it in one place keeps the login path, the NTLM group lookup and the
 * admin connection test in agreement, and lets the admin UI show what a value
 * *would* be before anyone types it. Every derived field can still be set
 * explicitly — an explicit value always wins.
 */

/**
 * Directory flavours. A preset only supplies defaults for the attribute names
 * that differ between directory products; it never overrides an explicit value.
 *
 * `openldap` reproduces the defaults this code has always used, so a provider
 * configured before presets existed resolves exactly as it did before.
 */
export const LDAP_PRESETS = {
  openldap: {
    id: 'openldap',
    label: 'OpenLDAP / generic LDAP',
    usernameAttribute: 'uid',
    groupClass: 'groupOfNames',
    groupMemberAttribute: 'member',
    groupMemberUserAttribute: 'dn',
    // Ordered candidate lists: the first attribute the directory actually
    // returns a value for wins.
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

/** Preset applied when a provider does not name one. */
export const DEFAULT_LDAP_PRESET = 'openldap';

/** Attribute-mapping slots an admin may override. */
export const LDAP_MAPPED_FIELDS = ['id', 'name', 'email'];

/** Placeholder replaced with the login name inside `userDn`. */
const USERNAME_PLACEHOLDER = '{{username}}';

const trimmed = value => (typeof value === 'string' ? value.trim() : '');

/**
 * Escape special characters in a string for use in LDAP search filters
 * (RFC 4515). Prevents LDAP filter injection when user-supplied values are used
 * in queries.
 * @param {string} str - Raw string to escape
 * @returns {string} Escaped string safe for LDAP filter use
 */
export function escapeLdapFilterValue(str) {
  if (typeof str !== 'string') return str;
  return str.replace(/[\\*()\x00]/g, c => '\\' + c.charCodeAt(0).toString(16).padStart(2, '0'));
}

/**
 * Normalize an attribute-mapping override into a candidate list.
 * Accepts a single attribute name or an array of them.
 * @param {string|string[]|undefined} value
 * @returns {string[]|null} Candidate attribute names, or null when unset
 */
function normalizeMappingEntry(value) {
  const list = (Array.isArray(value) ? value : [value])
    .map(trimmed)
    .filter(entry => entry.length > 0);
  return list.length > 0 ? list : null;
}

/**
 * Resolve a provider into the complete set of values the LDAP client needs,
 * recording where each one came from.
 *
 * @param {Object} provider - Raw provider entry from `platform.json`
 * @returns {{resolved: Object, sources: Object<string, string>}} The resolved
 *   config and, per derived field, one of `explicit`, `preset`, `baseDn`,
 *   `derived` or `unset`.
 */
function resolve(provider = {}) {
  const sources = {};
  const presetId = LDAP_PRESETS[provider.preset] ? provider.preset : DEFAULT_LDAP_PRESET;
  const preset = LDAP_PRESETS[presetId];
  sources.preset = provider.preset && LDAP_PRESETS[provider.preset] ? 'explicit' : 'derived';

  const baseDn = trimmed(provider.baseDn);

  // `userSearchBase` falls back to the directory root: searching from the root
  // is what most directories expect anyway, and it is what the Active Directory
  // example in the docs already did by hand.
  const userSearchBase = trimmed(provider.userSearchBase) || baseDn;
  sources.userSearchBase = trimmed(provider.userSearchBase)
    ? 'explicit'
    : baseDn
      ? 'baseDn'
      : 'unset';

  const usernameAttribute = trimmed(provider.usernameAttribute) || preset.usernameAttribute;
  sources.usernameAttribute = trimmed(provider.usernameAttribute) ? 'explicit' : 'preset';

  // With admin bind credentials the library searches for the user and binds to
  // the DN it found, so `userDn` is only consulted when no admin bind is
  // configured. Deriving it from the two values that describe the same thing
  // beats the placeholder DN this used to fall back to, which pointed at
  // example.org and therefore never authenticated anyone.
  const explicitUserDn = trimmed(provider.userDn);
  const userDn =
    explicitUserDn ||
    (userSearchBase ? `${usernameAttribute}=${USERNAME_PLACEHOLDER},${userSearchBase}` : '');
  sources.userDn = explicitUserDn ? 'explicit' : userSearchBase ? 'derived' : 'unset';

  // Group search stays opt-in for providers that predate `baseDn`: without a
  // base DN and without an explicit group search base, no group search runs —
  // exactly as before. Setting `baseDn` opts in, because a directory root is
  // also a valid place to look for groups.
  const explicitGroupSearchBase = trimmed(provider.groupSearchBase);
  const groupSearchBase = explicitGroupSearchBase || baseDn;
  sources.groupSearchBase = explicitGroupSearchBase ? 'explicit' : baseDn ? 'baseDn' : 'unset';

  const groupClass = trimmed(provider.groupClass) || preset.groupClass;
  sources.groupClass = trimmed(provider.groupClass) ? 'explicit' : 'preset';

  const groupMemberAttribute =
    trimmed(provider.groupMemberAttribute) || preset.groupMemberAttribute;
  sources.groupMemberAttribute = trimmed(provider.groupMemberAttribute) ? 'explicit' : 'preset';

  const groupMemberUserAttribute =
    trimmed(provider.groupMemberUserAttribute) || preset.groupMemberUserAttribute;
  sources.groupMemberUserAttribute = trimmed(provider.groupMemberUserAttribute)
    ? 'explicit'
    : 'preset';

  const attributeMapping = {};
  for (const field of LDAP_MAPPED_FIELDS) {
    const override = normalizeMappingEntry(provider.attributeMapping?.[field]);
    attributeMapping[field] = override || preset.attributeMapping[field];
    sources[`attributeMapping.${field}`] = override ? 'explicit' : 'preset';
  }

  const resolved = {
    ...provider,
    preset: presetId,
    baseDn,
    displayName: trimmed(provider.displayName) || trimmed(provider.name),
    userSearchBase,
    usernameAttribute,
    userDn,
    groupSearchBase,
    groupClass,
    groupMemberAttribute,
    groupMemberUserAttribute,
    attributeMapping
  };

  return { resolved, sources };
}

/**
 * Resolve a provider config for use by an LDAP client.
 * @param {Object} provider - Raw provider entry
 * @returns {Object} Fully resolved provider config
 */
export function resolveLdapProvider(provider = {}) {
  return resolve(provider).resolved;
}

/**
 * Resolve a provider and describe how each value was arrived at, so the admin
 * UI and the connection test can show effective values next to the handful the
 * admin actually typed.
 *
 * @param {Object} provider - Raw provider entry
 * @returns {{resolved: Object, sources: Object, fields: Array, problems: string[], warnings: string[]}}
 */
export function describeLdapProvider(provider = {}) {
  const { resolved, sources } = resolve(provider);

  const fields = [
    'preset',
    'userSearchBase',
    'usernameAttribute',
    'userDn',
    'groupSearchBase',
    'groupClass',
    'groupMemberAttribute',
    'groupMemberUserAttribute'
  ].map(key => ({ key, value: resolved[key] || null, source: sources[key] }));

  for (const field of LDAP_MAPPED_FIELDS) {
    fields.push({
      key: `attributeMapping.${field}`,
      value: resolved.attributeMapping[field].join(', '),
      source: sources[`attributeMapping.${field}`]
    });
  }

  const problems = [];
  if (!trimmed(resolved.url)) problems.push('No LDAP URL is configured.');
  if (!resolved.userSearchBase) {
    problems.push(
      'Neither a base DN nor a user search base is configured — users cannot be found.'
    );
  }

  const warnings = [];
  if (!resolved.groupSearchBase) {
    warnings.push(
      'No base DN or group search base is configured, so no LDAP groups are read. Users get only the default groups of this provider.'
    );
  }
  if (!trimmed(resolved.adminDn)) {
    warnings.push(
      `No bind account is configured, so the user is bound directly as "${resolved.userDn || '<unresolvable>'}". Group membership is only read when the directory allows the user themselves to search it.`
    );
  } else if (!trimmed(resolved.adminPasswordRef)) {
    problems.push('A bind DN is configured but no bind password credential is selected.');
  }

  return { resolved, sources, fields, problems, warnings };
}

/**
 * Build the option object for `ldap-authentication`'s `authenticate()`.
 *
 * @param {Object} resolved - Provider config from `resolveLdapProvider()`
 * @param {Object} options
 * @param {string} options.username - Login name to search for
 * @param {string} [options.password] - User password; omit with `verifyUserExists`
 * @param {string} [options.adminPassword] - Resolved bind-account password
 * @param {boolean} [options.verifyUserExists] - Look the user up without binding as them
 * @returns {Object} Options for `authenticate()`
 */
export function buildLdapAuthOptions(
  resolved,
  { username, password, adminPassword, verifyUserExists = false } = {}
) {
  // A configured bind DN always selects the service-account flow, even when its
  // password came back empty: the library then names `adminPassword` as the
  // missing field, instead of silently falling back to a direct user bind that
  // fails for an unrelated-looking reason.
  const useAdminBind = Boolean(resolved.adminDn);

  return {
    ldapOpts: {
      url: resolved.url,
      ...(resolved.tlsOptions && { tlsOptions: resolved.tlsOptions }),
      ...(resolved.timeout && { timeout: resolved.timeout }),
      ...(resolved.reconnect && { reconnect: resolved.reconnect })
    },
    ...(useAdminBind && { adminDn: resolved.adminDn, adminPassword }),
    ...(resolved.userDn && { userDn: resolved.userDn }),
    ...(verifyUserExists ? { verifyUserExists: true } : { userPassword: password }),
    userSearchBase: resolved.userSearchBase,
    usernameAttribute: resolved.usernameAttribute,
    username,
    // Note: the ldap-authentication library spells this option `groupsSearchBase`.
    ...(resolved.groupSearchBase && {
      groupsSearchBase: resolved.groupSearchBase,
      groupClass: resolved.groupClass,
      groupMemberAttribute: resolved.groupMemberAttribute,
      groupMemberUserAttribute: resolved.groupMemberUserAttribute
    })
  };
}

/**
 * First usable value of a possibly multi-valued LDAP attribute.
 * @param {*} value
 * @returns {string|null}
 */
function firstValue(value) {
  const candidate = Array.isArray(value) ? value[0] : value;
  if (candidate === null || candidate === undefined) return null;
  const asString = typeof candidate === 'string' ? candidate.trim() : String(candidate);
  return asString.length > 0 ? asString : null;
}

/**
 * Map a raw LDAP entry onto iHub's user fields using the provider's attribute
 * mapping, and report which attribute each value came from so the admin test
 * can show it.
 *
 * @param {Object} ldapUser - Raw entry returned by the LDAP server
 * @param {Object} resolved - Provider config from `resolveLdapProvider()`
 * @param {string} username - Login name, used as the last-resort fallback
 * @returns {{id: string, name: string, email: string|null, usedAttributes: Object}}
 */
export function mapLdapUserAttributes(ldapUser, resolved, username) {
  const entry = ldapUser || {};
  const usedAttributes = {};

  const pick = field => {
    for (const attribute of resolved.attributeMapping?.[field] || []) {
      const value = firstValue(entry[attribute]);
      if (value) {
        usedAttributes[field] = attribute;
        return value;
      }
    }
    return null;
  };

  const id = pick('id');
  if (!id) usedAttributes.id = null;

  let name = pick('name');
  if (!name) {
    const composed = `${firstValue(entry.givenName) || ''} ${firstValue(entry.sn) || ''}`.trim();
    if (composed) {
      name = composed;
      usedAttributes.name = 'givenName + sn';
    } else {
      usedAttributes.name = null;
    }
  }

  const email = pick('email');
  if (!email) usedAttributes.email = null;

  return {
    id: id || username,
    name: name || username,
    email: email || null,
    usedAttributes
  };
}

/**
 * Extract a group name from an LDAP group entry.
 * Handles string values, objects with cn/name/displayName, and DN parsing.
 * @param {string|Object} group - LDAP group entry
 * @returns {string|null} Group name or null if not extractable
 */
export function extractGroupName(group) {
  if (typeof group === 'string') {
    return group;
  }

  if (typeof group === 'object' && group !== null) {
    if (group.cn) {
      return Array.isArray(group.cn) ? group.cn[0] : group.cn;
    }
    if (group.name) {
      return Array.isArray(group.name) ? group.name[0] : group.name;
    }
    if (group.displayName) {
      return Array.isArray(group.displayName) ? group.displayName[0] : group.displayName;
    }
    if (group.dn) {
      const dnString = Array.isArray(group.dn) ? group.dn[0] : group.dn;
      const cnMatch = dnString.match(/^CN=([^,]+)/i);
      if (cnMatch) {
        return cnMatch[1];
      }
    }
  }

  return null;
}

/**
 * Extract group names from an LDAP groups response.
 * Handles both array and object formats.
 * @param {Array|Object} groups - Raw groups from LDAP response
 * @returns {string[]} Array of group name strings
 */
export function extractGroupNames(groups) {
  if (!groups) {
    return [];
  }

  const groupsArray = Array.isArray(groups)
    ? groups
    : Object.values(groups).filter(g => g && typeof g === 'object');

  return groupsArray
    .map(group => {
      const name = extractGroupName(group);
      if (name === null && group != null) {
        logger.warn('LDAP: could not extract group name from group object', {
          component: 'LdapAuth',
          group
        });
      }
      return name;
    })
    .filter(g => g !== null);
}
