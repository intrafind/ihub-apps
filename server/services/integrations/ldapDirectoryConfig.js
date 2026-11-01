// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * People directories as installations of the built-in definition
 * `com.intrafind/ldap-directory`, one installation per directory. The LDAP
 * code (`services/peopleDirectory/*`) still works on the directory shape of
 * `validators/peopleDirectorySchema.js`; this module is the bridge: it reads
 * the installations from the cache and turns each into that shape.
 *
 * Kept free of service imports so the people directory service, the
 * connector and the migration can all use it without an import cycle.
 */
import configCache from '../../configCache.js';
import { MAPPED_PERSON_FIELDS } from '../peopleDirectory/presets.js';

export const LDAP_DIRECTORY_DEFINITION_ID = 'com.intrafind/ldap-directory';

/** The directory actions and the admin LDAP browser's, as the definition declares them. */
export const DIRECTORY_SEARCH_ACTIONS = ['search_people', 'get_person', 'list_units'];
export const DIRECTORY_BROWSE_ACTIONS = ['browse_search', 'browse_read', 'browse_children'];

const text = value => (typeof value === 'string' && value.trim() ? value.trim() : undefined);
const list = value =>
  Array.isArray(value) ? value.map(item => String(item).trim()).filter(Boolean) : [];
const number = value => (typeof value === 'number' && !Number.isNaN(value) ? value : undefined);

function put(target, key, value) {
  if (value !== undefined) target[key] = value;
}

function bindOf(mode, dn, passwordRef) {
  if (mode === 'anonymous') return { mode: 'anonymous' };
  if (mode === 'service')
    return { mode: 'service', dn: text(dn) ?? '', passwordRef: text(passwordRef) ?? '' };
  return undefined;
}

/**
 * The installations of the LDAP directory definition, as stored.
 * @returns {object[]}
 */
export function getDirectoryInstallations() {
  try {
    const installed = configCache.getIntegrations?.()?.data?.installed || [];
    return installed.filter(instance => instance?.definition === LDAP_DIRECTORY_DEFINITION_ID);
  } catch {
    return [];
  }
}

/**
 * Whether an installation is a people directory.
 * @param {object|null} instance
 */
export function isDirectoryInstallation(instance) {
  return Boolean(instance) && instance.definition === LDAP_DIRECTORY_DEFINITION_ID;
}

/**
 * The installation's `allowedGroups` as the directory's `groups`: an empty
 * list opens an installation to everyone, which the directory spells `*`.
 * @param {object} instance
 * @returns {string[]}
 */
export function directoryGroupsOf(instance) {
  const groups = Array.isArray(instance?.allowedGroups) ? instance.allowedGroups : [];
  return groups.length ? groups : ['*'];
}

/**
 * A directory entry (the shape of `peopleDirectorySchema`) from an
 * installation's values. Unset values are left out, so the schema's defaults,
 * the sign-in provider's values and the preset's apply as before.
 *
 * @param {object} instance - installed integration of `com.intrafind/ldap-directory`
 * @returns {object}
 */
export function directoryFromInstance(instance) {
  const values = instance?.values || {};
  const directory = { id: instance?.id, enabled: instance?.enabled !== false, type: 'ldap' };
  put(directory, 'authProvider', text(values.authProvider));
  put(directory, 'url', text(values.url));
  if (typeof values.starttls === 'boolean') directory.starttls = values.starttls;
  put(directory, 'baseDn', text(values.baseDn));
  put(directory, 'preset', text(values.preset));
  const tlsOptions = {};
  put(tlsOptions, 'minVersion', text(values.tlsMinVersion));
  put(tlsOptions, 'maxVersion', text(values.tlsMaxVersion));
  put(tlsOptions, 'ciphers', text(values.tlsCiphers));
  if (Object.keys(tlsOptions).length) directory.tlsOptions = tlsOptions;
  put(directory, 'bind', bindOf(values.bindMode, values.bindDn, values.bindPasswordRef));
  put(directory, 'searchBase', text(values.searchBase));
  put(directory, 'personFilter', text(values.personFilter));
  const searchAttributes = list(values.searchAttributes);
  if (searchAttributes.length) directory.searchAttributes = searchAttributes;
  const mapping = {};
  for (const field of MAPPED_PERSON_FIELDS) {
    const sources = list(values[`mapping_${field}`]);
    if (sources.length) mapping[field] = sources;
  }
  if (Object.keys(mapping).length) directory.attributeMapping = mapping;
  directory.units = values.units === true;
  directory.allowPlaintext = values.allowPlaintext === true;
  const tlsCa = list(values.tlsCa);
  if (tlsCa.length) directory.tlsCa = tlsCa;
  const allowedHosts = list(values.allowedHosts);
  if (allowedHosts.length) directory.allowedHosts = allowedHosts;
  for (const key of ['maxResults', 'timeoutMs', 'concurrency', 'requestDelayMs']) {
    put(directory, key, number(values[key]));
  }
  directory.groups = directoryGroupsOf(instance);
  directory.dataFlow = values.dataFlow === 'external' ? 'external' : 'internal';
  if (values.browse === true) {
    const browse = { enabled: true };
    const browseGroups = list(values.browseGroups);
    if (browseGroups.length) browse.groups = browseGroups;
    put(browse, 'maxResults', number(values.browseMaxResults));
    put(browse, 'base', text(values.browseBase));
    put(
      browse,
      'bind',
      bindOf(values.browseBindMode, values.browseBindDn, values.browseBindPasswordRef)
    );
    const deny = list(values.browseDenyAttributes);
    if (deny.length) browse.denyAttributes = deny;
    directory.browse = browse;
  }
  if (instance?.label && typeof instance.label === 'object') directory.name = instance.label;
  else if (typeof instance?.label === 'string' && instance.label) {
    directory.name = { en: instance.label };
  }
  if (instance?.description && typeof instance.description === 'object') {
    directory.description = instance.description;
  } else if (typeof instance?.description === 'string' && instance.description) {
    directory.description = { en: instance.description };
  }
  return directory;
}
