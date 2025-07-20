import { promises as fs } from 'fs';
import { join } from 'path';
import { getRootDir } from '../../pathUtils.js';
import { atomicWriteJSON } from '../../utils/atomicWrite.js';
import configCache from '../../configCache.js';
import { adminAuth } from '../../middleware/adminAuth.js';

export default function registerAdminConfigRoutes(app) {
  /**
   * Get platform configuration for admin
   */
  app.get('/api/admin/configs/platform', adminAuth, async (req, res) => {
    try {
      const rootDir = getRootDir();
      const platformConfigPath = join(rootDir, 'contents', 'config', 'platform.json');

      let platformConfig = {};
      try {
        const platformConfigData = await fs.readFile(platformConfigPath, 'utf8');
        platformConfig = JSON.parse(platformConfigData);
      } catch (error) {
        console.log('Platform config not found, returning default config');
        platformConfig = {
          auth: {
            mode: 'proxy',
            allowAnonymous: true,
            anonymousGroup: 'anonymous',
            authenticatedGroup: 'authenticated'
          },
          proxyAuth: {
            enabled: false,
            userHeader: 'X-Forwarded-User',
            groupsHeader: 'X-Forwarded-Groups',
            anonymousGroup: 'anonymous',
            jwtProviders: []
          },
          localAuth: {
            enabled: false,
            usersFile: 'contents/config/users.json',
            sessionTimeoutMinutes: 480,
            jwtSecret: '${JWT_SECRET}'
          },
          oidcAuth: {
            enabled: false,
            providers: []
          },
          authorization: {
            adminGroups: ['admin', 'IT-Admin', 'Platform-Admin'],
            userGroups: ['user', 'users'],
            anonymousAccess: true,
            defaultGroup: 'anonymous'
          }
        };
      }

      res.json(platformConfig);
    } catch (error) {
      console.error('Error getting platform configuration:', error);
      res.status(500).json({ error: 'Failed to get platform configuration' });
    }
  });

  /**
   * Update platform configuration
   */
  app.post('/api/admin/configs/platform', adminAuth, async (req, res) => {
    try {
      const newConfig = req.body;

      if (!newConfig || typeof newConfig !== 'object') {
        return res.status(400).json({ error: 'Invalid configuration data' });
      }

      const rootDir = getRootDir();
      const platformConfigPath = join(rootDir, 'contents', 'config', 'platform.json');

      // Load existing config to preserve other fields
      let existingConfig = {};
      try {
        const existingConfigData = await fs.readFile(platformConfigPath, 'utf8');
        existingConfig = JSON.parse(existingConfigData);
      } catch (error) {
        // File doesn't exist, start with empty config
        console.log('Creating new platform config file');
      }

      // Merge the authentication-related config with existing config
      const mergedConfig = {
        ...existingConfig,
        auth: newConfig.auth || existingConfig.auth,
        proxyAuth: newConfig.proxyAuth || existingConfig.proxyAuth,
        localAuth: newConfig.localAuth || existingConfig.localAuth,
        oidcAuth: newConfig.oidcAuth || existingConfig.oidcAuth,
        authorization: newConfig.authorization || existingConfig.authorization
      };

      // Save to file
      await atomicWriteJSON(platformConfigPath, mergedConfig);

      // Refresh cache
      await configCache.refreshCacheEntry('config/platform.json');

      console.log('🔧 Platform authentication configuration updated');

      res.json({
        message: 'Platform configuration updated successfully',
        config: mergedConfig
      });
    } catch (error) {
      console.error('Error updating platform configuration:', error);
      res.status(500).json({ error: 'Failed to update platform configuration' });
    }
  });
}
