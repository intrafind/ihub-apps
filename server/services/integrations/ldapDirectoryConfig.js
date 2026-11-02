// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * People directories as installations of the built-in definition
 * `com.intrafind/ldap-directory` ("People directory (LDAP)"), one
 * installation per directory, and the admin LDAP browsers as installations of
 * `com.intrafind/ldap-browser`, each naming the directory installation whose
 * connection it reuses. The LDAP code (`services/peopleDirectory/*`) works on
 * the shapes of `validators/peopleDirectorySchema.js`; this module is the
 * bridge: it reads the installations from the cache and turns each into that
 * shape.
 *
 * Who may use a directory is not part of the directory shape: the groups
 * grant installations (`permissions.integrations`, see
 * `integrationAccess.js`).
 *
 * Kept free of service imports so the people directory service, the
 * connector and the migration can all use it without an import cycle.
 */
import configCache from '../../configCache.js';
import { MAPPED_PERSON_FIELDS } from '../peopleDirectory/presets.js';

export const LDAP_DIRECTORY_DEFINITION_ID = 'com.intrafind/ldap-directory';
export const LDAP_BROWSER_DEFINITION_ID = 'com.intrafind/ldap-browser';

/** The directory actions, as `com.intrafind/ldap-directory` declares them. */
export const DIRECTORY_SEARCH_ACTIONS = ['search_people', 'get_person', 'list_units'];
/** The admin LDAP browser's actions, as `com.intrafind/ldap-browser` declares them. */
export const BROWSER_ACTIONS = ['browse_search', 'browse_read', 'browse_children'];

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

/** The installations of one definition, as stored; empty when the cache cannot answer. */
function installationsOf(definitionId) {
  try {
    const installed = configCache.getIntegrations?.()?.data?.installed || [];
    return installed.filter(instance => instance?.definition === definitionId);
  } catch {
    return [];
  }
}

/**
 * The installations of the LDAP directory definition, as stored.
 * @returns {object[]}
 */
export function getDirectoryInstallations() {
  return installationsOf(LDAP_DIRECTORY_DEFINITION_ID);
}

/**
 * The installations of the LDAP browser definition, as stored.
 * @returns {object[]}
 */
export function getBrowserInstallations() {
  return installationsOf(LDAP_BROWSER_DEFINITION_ID);
}

/**
 * Whether an installation is a people directory.
 * @param {object|null} instance
 */
export function isDirectoryInstallation(instance) {
  return Boolean(instance) && instance.definition === LDAP_DIRECTORY_DEFINITION_ID;
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
  directory.dataFlow = values.dataFlow === 'external' ? 'external' : 'internal';
  putTexts(directory, instance);
  return directory;
}

/** `name` and `description` of an entry from the installation's label and description. */
function putTexts(target, instance) {
  if (instance?.label && typeof instance.label === 'object') target.name = instance.label;
  else if (typeof instance?.label === 'string' && instance.label) {
    target.name = { en: instance.label };
  }
  if (instance?.description && typeof instance.description === 'object') {
    target.description = instance.description;
  } else if (typeof instance?.description === 'string' && instance.description) {
    target.description = { en: instance.description };
  }
}

/**
 * Whether an installation is an LDAP browser.
 * @param {object|null} instance
 */
export function isBrowserInstallation(instance) {
  return Boolean(instance) && instance.definition === LDAP_BROWSER_DEFINITION_ID;
}

/**
 * An LDAP browser entry (the shape of `ldapBrowserSchema`) from an
 * installation of `com.intrafind/ldap-browser`. Unset values are left out, so
 * the schema's defaults and the directory's base DN and bind apply.
 *
 * @param {object} instance - installed integration of `com.intrafind/ldap-browser`
 * @returns {{ id: string, enabled: boolean, directory: string, base?: string,
 *   maxResults?: number, bind?: object, denyAttributes?: string[],
 *   name?: object, description?: object }}
 * @example
 *   browserFromInstance({ id: 'corp-browser', definition: 'com.intrafind/ldap-browser',
 *                         values: { directory: 'corp', baseDn: 'ou=groups,dc=corp' } });
 *   // → { id: 'corp-browser', enabled: true, directory: 'corp', base: 'ou=groups,dc=corp' }
 */
export function browserFromInstance(instance) {
  const values = instance?.values || {};
  const browser = {
    id: instance?.id,
    enabled: instance?.enabled !== false,
    directory: text(values.directory) ?? ''
  };
  put(browser, 'base', text(values.baseDn));
  put(browser, 'maxResults', number(values.maxResults));
  put(browser, 'bind', bindOf(values.bindMode, values.bindDn, values.bindPasswordRef));
  const deny = list(values.denyAttributes);
  if (deny.length) browser.denyAttributes = deny;
  putTexts(browser, instance);
  return browser;
}
