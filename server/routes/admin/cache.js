import { promises as fs } from 'fs';
import { join } from 'path';
import { getRootDir } from '../../pathUtils.js';
import { atomicWriteJSON } from '../../utils/atomicWrite.js';
import configCache from '../../configCache.js';
import { getUsage } from '../../usageTracker.js';
import { adminAuth } from '../../middleware/adminAuth.js';
import { buildServerPath } from '../../utils/basePath.js';
import logger from '../../utils/logger.js';
import tokenStorageService from '../../services/TokenStorageService.js';
import { sendInternalError, sendBadRequest } from '../../utils/responseHelpers.js';

export default function registerAdminCacheRoutes(app) {
  app.get(buildServerPath('/api/admin/usage'), adminAuth, async (req, res) => {
    try {
      const data = await getUsage();
      res.json(data);
    } catch (e) {
      return sendInternalError(res, e, 'load usage data');
    }
  });

  app.get(buildServerPath('/api/admin/cache/stats'), adminAuth, async (req, res) => {
    try {
      const stats = configCache.getStats();
      res.json(stats);
    } catch (e) {
      return sendInternalError(res, e, 'get cache statistics');
    }
  });

  app.post(buildServerPath('/api/admin/cache/_refresh'), adminAuth, async (req, res) => {
    try {
      await configCache.refreshAll();
      res.json({ message: 'Configuration cache refreshed successfully' });
    } catch (e) {
      return sendInternalError(res, e, 'refresh cache');
    }
  });

  app.get(buildServerPath('/api/admin/cache/_refresh'), adminAuth, (req, res, next) => {
    req.method = 'POST';
    app._router.handle(req, res, next);
  });

  app.post(buildServerPath('/api/admin/cache/_clear'), adminAuth, async (req, res) => {
    try {
      configCache.clear();
      await configCache.initialize();
      res.json({ message: 'Configuration cache cleared successfully' });
    } catch (e) {
      return sendInternalError(res, e, 'clear cache');
    }
  });

  app.get(buildServerPath('/api/admin/cache/_clear'), adminAuth, (req, res, next) => {
    req.method = 'POST';
    app._router.handle(req, res, next);
  });

  app.post(buildServerPath('/api/admin/client/_refresh'), adminAuth, async (req, res) => {
    try {
      const rootDir = getRootDir();
      const platformConfigPath = join(rootDir, 'contents', 'config', 'platform.json');
      const platformConfigData = await fs.readFile(platformConfigPath, 'utf8');
      const platformConfig = JSON.parse(platformConfigData);
      if (!platformConfig.refreshSalt) {
        platformConfig.refreshSalt = { salt: 0, lastUpdated: new Date().toISOString() };
      }
      platformConfig.refreshSalt.salt += 1;
      platformConfig.refreshSalt.lastUpdated = new Date().toISOString();
      await atomicWriteJSON(platformConfigPath, platformConfig);
      await new Promise(resolve => setTimeout(resolve, 100));
      await configCache.refreshCacheEntry('config/platform.json');
      logger.info('Force refresh triggered', {
        component: 'AdminCache',
        newAdminSalt: platformConfig.refreshSalt.salt
      });
      res.json({
        message: 'Force refresh triggered successfully',
        newAdminSalt: platformConfig.refreshSalt.salt,
        timestamp: platformConfig.refreshSalt.lastUpdated
      });
    } catch (error) {
      return sendInternalError(res, error, 'trigger force refresh');
    }
  });

  app.get(buildServerPath('/api/admin/client/_refresh'), adminAuth, (req, res, next) => {
    req.method = 'POST';
    app._router.handle(req, res, next);
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
    try {
      const { value } = req.body;

      // Validate input
      if (!value || typeof value !== 'string' || value.trim() === '') {
        return sendBadRequest(res, 'Invalid value: must be a non-empty string');
      }

      // Check if value is already encrypted
      if (tokenStorageService.isEncrypted(value)) {
        return sendBadRequest(res, 'Value is already encrypted');
      }

      // Encrypt the value
      const encryptedValue = tokenStorageService.encryptString(value);

      logger.info('Value encrypted successfully via admin UI', { component: 'AdminEncryption' });

      res.json({
        encryptedValue,
        message: 'Value encrypted successfully'
      });
    } catch (error) {
      return sendInternalError(res, error, 'encrypt value');
    }
  });
}
