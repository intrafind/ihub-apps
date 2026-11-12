// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

import configStore from '../services/config/ConfigStore.js';
import configCache from '../configCache.js';
import logger from './logger.js';

/** The marketplace installation manifest, relative to `contents/`. */
const INSTALLATIONS_FILE = 'config/installations.json';

/**
 * Removes marketplace installation tracking entry after an item is deleted via admin.
 * This is a no-op if the item was not marketplace-installed or if installations tracking
 * is unavailable.
 *
 * @param {string} type - The content type ('app', 'model', 'prompt', 'workflow', 'skill')
 * @param {string} itemId - The ID of the deleted item
 */
export async function removeMarketplaceInstallation(type, itemId) {
  try {
    const key = `${type}:${itemId}`;
    // Read, change and write in one locked step; a stale snapshot would erase
    // entries a concurrent install recorded.
    const { written } = await configStore.updateJson(INSTALLATIONS_FILE, current => {
      if (!current?.installations?.[key]) return undefined;
      delete current.installations[key];
      return current;
    });
    if (written) await configCache.refreshInstallationsCache();
  } catch (error) {
    logger.warn('Failed to clean up installation tracking', {
      component: 'InstallationCleanup',
      type,
      itemId,
      error
    });
  }
}
