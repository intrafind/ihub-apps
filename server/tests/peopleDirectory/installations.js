// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * Test helper: people directories in the directory shape become installations
 * of `com.intrafind/ldap-directory` in the config cache, the way migration
 * V198 writes them, so the directory tests keep describing directories.
 *
 * Who may use a directory is not part of the installation (#3093, V202): the
 * tests grant it on the groups (`permissions.integrations`). A directory's
 * old `groups` field, which V198 turned into `allowedGroups`, is dropped here
 * as V202 drops it.
 */
import { instanceFrom } from '../../migrations/V198__people_directories_installed_integrations.js';

export const DEFINITION_ID = 'com.intrafind/ldap-directory';

/** The installation of one directory entry, without the removed `allowedGroups`. */
function installationOf(directory) {
  const instance = instanceFrom(directory);
  delete instance.allowedGroups;
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
