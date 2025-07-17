import { promises as fs } from 'fs';
import { join } from 'path';
import { getRootDir } from '../../pathUtils.js';
import { atomicWriteJSON } from '../../utils/atomicWrite.js';
import configCache from '../../configCache.js';
import { getUsage } from '../../usageTracker.js';
import { adminAuth } from '../../middleware/adminAuth.js';

export default function registerAdminCacheRoutes(app) {
  app.get('/api/admin/usage', adminAuth, async (req, res) => {
    try {
      const data = await getUsage();
      res.json(data);
    } catch (e) {
      console.error('Error loading usage data:', e);
      res.status(500).json({ error: 'Failed to load usage data' });
    }
  });

  app.get('/api/admin/cache/stats', adminAuth, async (req, res) => {
    try {
      const stats = configCache.getStats();
      res.json(stats);
    } catch (e) {
      console.error('Error getting cache stats:', e);
      res.status(500).json({ error: 'Failed to get cache statistics' });
    }
  });

  app.post('/api/admin/cache/_refresh', adminAuth, async (req, res) => {
    try {
      await configCache.refreshAll();
      res.json({ message: 'Configuration cache refreshed successfully' });
    } catch (e) {
      console.error('Error refreshing cache:', e);
      res.status(500).json({ error: 'Failed to refresh cache' });
    }
  });

  app.get('/api/admin/cache/_refresh', adminAuth, (req, res, next) => {
    req.method = 'POST';
    app._router.handle(req, res, next);
  });

  app.post('/api/admin/cache/_clear', adminAuth, async (req, res) => {
    try {
      configCache.clear();
      await configCache.initialize();
      res.json({ message: 'Configuration cache cleared successfully' });
    } catch (e) {
      console.error('Error clearing cache:', e);
      res.status(500).json({ error: 'Failed to clear cache' });
    }
  });

  app.get('/api/admin/cache/_clear', adminAuth, (req, res, next) => {
    req.method = 'POST';
    app._router.handle(req, res, next);
  });

  app.post('/api/admin/client/_refresh', adminAuth, async (req, res) => {
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
      console.log(`🔄 Force refresh triggered. New admin salt: ${platformConfig.refreshSalt.salt}`);
      res.json({
        message: 'Force refresh triggered successfully',
        newAdminSalt: platformConfig.refreshSalt.salt,
        timestamp: platformConfig.refreshSalt.lastUpdated
      });
    } catch (error) {
      console.error('Error triggering force refresh:', error);
      res.status(500).json({ error: 'Failed to trigger force refresh' });
    }
  });

  app.get('/api/admin/client/_refresh', adminAuth, (req, res, next) => {
    req.method = 'POST';
    app._router.handle(req, res, next);
  });
}
