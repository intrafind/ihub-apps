import path from 'path';
import { atomicWriteJSON } from './atomicWrite.js';
import { getRootDir } from '../pathUtils.js';
import config from '../config.js';
import configCache from '../configCache.js';
import logger from './logger.js';

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
    const { data: installationsData } = configCache.getInstallations();
    const installations = installationsData || { installations: {} };
    const key = `${type}:${itemId}`;
    if (installations.installations[key]) {
      delete installations.installations[key];
      const installationsPath = path.join(
        getRootDir(),
        config.CONTENTS_DIR,
        'config',
        'installations.json'
      );
      await atomicWriteJSON(installationsPath, installations);
      await configCache.refreshInstallationsCache();
    }
  } catch (err) {
    logger.warn(`Failed to clean up installation tracking for ${type} '${itemId}': ${err.message}`);
  }
}
