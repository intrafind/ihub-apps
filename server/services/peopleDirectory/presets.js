// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

import { LDAP_PRESETS } from '../../utils/ldapProviderConfig.js';

/**
 * Search presets for people directories: which entries are people, which
 * attributes free text is matched against, and where each `Person` field is
 * read from.
 *
 * The same attribute name means different things per directory: `title` is the
 * job title in OpenLDAP and Active Directory, but the academic title ("Dr.") in
 * the IVBB directory of the German federal administration (x500.bund.de),
 * whose job title is `role`. The presets keep that in one place, and a
 * directory's `attributeMapping` overrides it per field.
 *
 * `openldap` and `activeDirectory` are the sign-in presets' `search` blocks
 * (`utils/ldapProviderConfig.js`), so a directory that reuses a sign-in
 * provider gets the matching search preset. `ivbb` is search-only.
 */

/** The fields of a `Person`, in the order a result lists them. */
export const PERSON_FIELDS = [
  'directory',
  'personId',
  'name',
  'firstName',
  'lastName',
  'salutation',
  'academicTitle',
  'jobTitle',
  'department',
  'organization',
  'location',
  'email',
  'phone',
  'fax',
  'mobile',
  'managerId'
];

/** The `Person` fields an attribute mapping fills (`directory` and `personId` are fixed). */
export const MAPPED_PERSON_FIELDS = PERSON_FIELDS.filter(
  field => field !== 'directory' && field !== 'personId'
);

/**
 * `search_people` parameters matched by prefix against the attributes their
 * field is mapped to. They are offered only when the directory maps them to at
 * least one plain attribute.
 */
export const STRUCTURED_SEARCH_FIELDS = [
  'firstName',
  'lastName',
  'email',
  'jobTitle',
  'department'
];

/**
 * Attributes that never leave a directory, whatever a mapping or the search
 * attributes name: passwords and key material, and binary blobs no model can
 * use. Compared lower-cased.
 */
export const FORBIDDEN_ATTRIBUTES = new Set([
  'userpassword',
  'unicodepwd',
  'ntpassword',
  'lmpassword',
  'sambantpassword',
  'sambalmpassword',
  'krbprincipalkey',
  'supplementalcredentials',
  'dbcspwd',
  'jpegphoto',
  'thumbnailphoto',
  'usercertificate',
  'usersmimecertificate',
  'userpkcs12',
  'cacertificate',
  'certificaterevocationlist',
  'authorityrevocationlist',
  'objectsid',
  'objectguid',
  // Readable by some directory accounts in Active Directory: LAPS, BitLocker
  // recovery and gMSA passwords.
  'ms-mcs-admpwd',
  'mslaps-password',
  'mslaps-encryptedpassword',
  'mslaps-encryptedpasswordhistory',
  'mslaps-encrypteddsrmpassword',
  'mslaps-encrypteddsrmpasswordhistory',
  'msfve-recoverypassword',
  'msds-managedpassword',
  'unixuserpassword',
  // Old password hashes: OpenLDAP ppolicy, Samba, and the NT hash in FreeIPA.
  'pwdhistory',
  'sambapasswordhistory',
  'ipanthash'
]);

export const SEARCH_PRESETS = {
  openldap: {
    id: 'openldap',
    label: LDAP_PRESETS.openldap.label,
    ...LDAP_PRESETS.openldap.search
  },
  activeDirectory: {
    id: 'activeDirectory',
    label: LDAP_PRESETS.activeDirectory.label,
    ...LDAP_PRESETS.activeDirectory.search
  },
  ivbb: {
    id: 'ivbb',
    label: 'IVBB directory (x500.bund.de)',
    personFilter: '(objectClass=ivbbPerson)',
    // The name attributes only: substring scans on a public server stay on
    // what it indexes.
    searchAttributes: ['cn', 'sn', 'givenName', 'mail'],
    attributeMapping: {
      // `cn` and `displayName` are surname first ("Mustermann Erika").
      name: ['givenName sn', 'cn'],
      firstName: ['givenName'],
      lastName: ['sn'],
      salutation: ['vocation'],
      academicTitle: ['title'],
      jobTitle: ['role'],
      // The attribute name really is spelled "gouvernment…".
      department: ['gouvernmentOrganizationalUnit'],
      organization: ['company', 'dn:ou'],
      // The server withholds `l` from anonymous clients; the city is in the DN.
      location: ['dn:l', 'l'],
      email: ['mail'],
      phone: ['telephoneNumber'],
      fax: ['facsimileTelephoneNumber']
    }
  }
};

export const SEARCH_PRESET_IDS = Object.keys(SEARCH_PRESETS);

/** Preset used when neither the directory nor its sign-in provider names one. */
export const DEFAULT_SEARCH_PRESET = 'openldap';

/**
 * The effective mapping of every `Person` field for a preset and a directory's
 * overrides. A field the preset does not map, and the directory does not
 * either, maps to an empty list (its value is then always `null`).
 *
 * @param {string} presetId
 * @param {Object<string, string|string[]>} [overrides] - `attributeMapping` of the directory
 * @returns {{mapping: Object<string, string[]>, sources: Object<string, 'explicit'|'preset'|'unset'>}}
 */
export function resolveMapping(presetId, overrides = {}) {
  const preset = SEARCH_PRESETS[presetId] || SEARCH_PRESETS[DEFAULT_SEARCH_PRESET];
  const mapping = {};
  const sources = {};
  for (const field of MAPPED_PERSON_FIELDS) {
    const override = overrides?.[field];
    const list = (Array.isArray(override) ? override : override ? [override] : [])
      .map(value => (typeof value === 'string' ? value.trim() : ''))
      .filter(Boolean);
    if (list.length > 0) {
      mapping[field] = list;
      sources[field] = 'explicit';
    } else {
      mapping[field] = [...(preset.attributeMapping[field] || [])];
      sources[field] = mapping[field].length > 0 ? 'preset' : 'unset';
    }
  }
  return { mapping, sources };
}

/**
 * Plain attribute names a mapping source reads. `dn:<type>` reads none (the
 * DN comes with every entry); `givenName sn` reads both.
 *
 * @param {string} source
 * @returns {string[]}
 */
export function attributesOfSource(source) {
  if (typeof source !== 'string' || source.startsWith('dn:')) return [];
  return source.split(/\s+/).filter(Boolean);
}

/**
 * The plain attributes a field can be matched against with a prefix filter:
 * single-attribute sources only, since a DN component or a composed value has
 * no attribute to filter on.
 *
 * @param {string[]} sources - Mapping of one field
 * @returns {string[]}
 */
export function filterableAttributes(sources = []) {
  return sources.filter(source => !source.startsWith('dn:') && !/\s/.test(source.trim()));
}

/**
 * The structured search fields a directory can serve: those its mapping reads
 * from at least one plain attribute.
 * @param {Object} resolved
 * @returns {Object<string, string[]>} field → attributes
 */
export function structuredFieldAttributes(resolved) {
  const fields = {};
  for (const field of STRUCTURED_SEARCH_FIELDS) {
    const attributes = filterableAttributes(resolved.mapping[field] || []);
    if (attributes.length > 0) fields[field] = attributes;
  }
  return fields;
}
