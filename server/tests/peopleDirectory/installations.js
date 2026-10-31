// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * Test helper: people directories in the directory shape become installations
 * of `com.intrafind/ldap-directory` in the config cache, the way migration
 * V198 writes them, so the directory tests keep describing directories.
 */
import { instanceFrom } from '../../migrations/V198__people_directories_installed_integrations.js';

export const DEFINITION_ID = 'com.intrafind/ldap-directory';

/** The installations of a list of directory entries (other installations first). */
export function installationsOf(directories, others = []) {
  return [...others, ...directories.map(directory => instanceFrom(directory))];
}

/** Put the directories (and other installations) into the config cache. */
export function installDirectories(configCache, directories, others = []) {
  configCache.setCacheEntry('config/integrations.json', {
    installed: installationsOf(directories, others),
    security: { blockPrivateIps: true, allowedHosts: [] }
  });
}
