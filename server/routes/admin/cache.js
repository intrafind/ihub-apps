// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

import configCache from '../../configCache.js';
import { announceFullConfigReload, getConfigSyncStats } from '../../configSync.js';
import { adminAuth } from '../../middleware/adminAuth.js';
import { buildServerPath } from '../../utils/basePath.js';
import { ServiceError } from '../../utils/ServiceError.js';
import logger from '../../utils/logger.js';
import tokenStorageService from '../../services/TokenStorageService.js';
import { updatePlatform } from '../../utils/platformConfigStore.js';

export default function registerAdminCacheRoutes(app) {
  app.get(buildServerPath('/api/admin/cache/stats'), adminAuth, async (req, res) => {
    const stats = configCache.getStats();
    // Cluster invalidation counters, so a multi-worker deployment can tell
    // whether config changes are actually reaching the other workers.
    res.json({ ...stats, sync: getConfigSyncStats() });
  });

  app.post(buildServerPath('/api/admin/cache/_refresh'), adminAuth, async (req, res) => {
    await configCache.refreshAll();
    res.status(204).end();
  });

  app.post(buildServerPath('/api/admin/cache/_clear'), adminAuth, async (req, res) => {
    configCache.clear();
    await configCache.initialize();
    // clear()/initialize() only rebuild this worker's cache; the rest of the
    // cluster reloads from the announcement.
    announceFullConfigReload();
    res.status(204).end();
  });

  app.post(buildServerPath('/api/admin/client/_refresh'), adminAuth, async (req, res) => {
    // A counter: concurrent clicks must each add one, so the increment runs on
    // the stored file under the update lock.
    const { data: platformConfig } = await updatePlatform(platformConfig => {
      const salt = Number(platformConfig.refreshSalt?.salt) || 0;
      platformConfig.refreshSalt = { ...platformConfig.refreshSalt, salt: salt + 1 };
      platformConfig.refreshSalt.lastUpdated = new Date().toISOString();
    });
    await new Promise(resolve => setTimeout(resolve, 100));
    await configCache.refreshCacheEntry('config/platform.json');
    logger.info('Force refresh triggered', {
      component: 'AdminCache',
      newAdminSalt: platformConfig.refreshSalt.salt
    });
    res.json({
      newAdminSalt: platformConfig.refreshSalt.salt,
      timestamp: platformConfig.refreshSalt.lastUpdated
    });
  });

  /**
   * Encrypt a plaintext value for storage in environment variables
   * POST /api/admin/encrypt-value
   *
   * Request body:
   * {
   *   "value": "plaintext_to_encrypt"
   * }
   *
   * Response:
   * {
   *   "encryptedValue": "ENC[AES256_GCM,data:...,iv:...,tag:...,type:str]"
   * }
   */
  app.post(buildServerPath('/api/admin/encrypt-value'), adminAuth, async (req, res) => {
    const { value } = req.body ?? {};

    // Validate input
    if (!value || typeof value !== 'string' || value.trim() === '') {
      throw new ServiceError('BAD_REQUEST', 'Invalid value: must be a non-empty string');
    }

    // Check if value is already encrypted
    if (tokenStorageService.isEncrypted(value)) {
      throw new ServiceError('BAD_REQUEST', 'Value is already encrypted');
    }

    // Encrypt the value
    const encryptedValue = tokenStorageService.encryptString(value);

    logger.info('Value encrypted successfully via admin UI', { component: 'AdminEncryption' });

    res.json({
      encryptedValue
    });
  });
}
