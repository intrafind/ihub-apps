// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * Test helper: people directories in the directory shape become installations
 * of `com.intrafind/ldap-directory` in the config cache, the way migration
 * V198 writes them, and LDAP browsers in the browser shape become
 * installations of `com.intrafind/ldap-browser`, so the directory tests keep
 * describing directories and browsers.
 *
 * Who may use a directory or a browser is not part of the installation
 * (#3093, V202): the tests grant it on the groups
 * (`permissions.integrations`). A directory's old `groups` field, which V198
 * turned into `allowedGroups`, is dropped here as V202 drops it; its old
 * `browse` block is not supported any more (V204 moved it into a browser).
 */
import { instanceFrom } from '../../migrations/V198__people_directories_installed_integrations.js';

export const DEFINITION_ID = 'com.intrafind/ldap-directory';
export const BROWSER_DEFINITION_ID = 'com.intrafind/ldap-browser';

/** The installation of one directory entry, without the removed `allowedGroups`. */
function installationOf(directory) {
  if (directory.browse) {
    throw new Error('A directory has no browse block any more: describe an LDAP browser instead');
  }
  const instance = instanceFrom(directory);
  delete instance.allowedGroups;
  return instance;
}

/**
 * The installation of one LDAP browser entry (the shape of `ldapBrowserSchema`):
 * the inverse of `ldapDirectoryConfig.browserFromInstance`.
 * @param {{ id: string, directory: string, enabled?: boolean, base?: string,
 *   maxResults?: number, bind?: object, denyAttributes?: string[], name?: object }} browser
 */
export function browserInstallationOf(browser) {
  const values = { directory: browser.directory };
  if (browser.base) values.baseDn = browser.base;
  if (browser.maxResults !== undefined) values.maxResults = browser.maxResults;
  if (browser.bind) {
    values.bindMode = browser.bind.mode;
    if (browser.bind.mode === 'service') {
      values.bindDn = browser.bind.dn;
      values.bindPasswordRef = browser.bind.passwordRef;
    }
  }
  if (browser.denyAttributes) values.denyAttributes = browser.denyAttributes;
  const instance = {
    id: browser.id,
    definition: BROWSER_DEFINITION_ID,
    definitionVersion: '1.0.0',
    enabled: browser.enabled !== false,
    values,
    auth: { mode: 'none' },
    actions: { enabled: ['*'], disabled: [], overrides: {} }
  };
  if (browser.name) instance.label = browser.name;
  return instance;
}

/** The installations of a list of directory entries (other installations first). */
export function installationsOf(directories, others = []) {
  return [...others, ...directories.map(installationOf)];
}

/** Put the directories (and other installations) into the config cache. */
export function installDirectories(configCache, directories, others = []) {
  configCache.setCacheEntry('config/integrations.json', {
    installed: installationsOf(directories, others),
    security: { blockPrivateIps: true, allowedHosts: [] }
  });
}

/** Put the directories and the LDAP browsers into the config cache. */
export function installDirectoriesAndBrowsers(configCache, directories, browsers, others = []) {
  installDirectories(configCache, directories, [...others, ...browsers.map(browserInstallationOf)]);
}
