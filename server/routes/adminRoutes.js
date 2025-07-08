import { getUsage } from '../usageTracker.js';
import configCache from '../configCache.js';
import { writeFileSync, readFileSync } from 'fs';
import { join } from 'path';
import { getRootDir } from '../pathUtils.js';

export default function registerAdminRoutes(app) {
  app.get('/api/admin/usage', async (req, res) => {
    try {
      const data = await getUsage();
      res.json(data);
    } catch (e) {
      console.error('Error loading usage data:', e);
      res.status(500).json({ error: 'Failed to load usage data' });
    }
  });

  // Configuration cache management endpoints
  app.get('/api/admin/cache/stats', async (req, res) => {
    try {
      const stats = configCache.getStats();
      res.json(stats);
    } catch (e) {
      console.error('Error getting cache stats:', e);
      res.status(500).json({ error: 'Failed to get cache statistics' });
    }
  });
  // Support both POST and GET for cache refresh
  app.post('/api/admin/cache/_refresh', async (req, res) => {
    try {
      await configCache.refreshAll();
      res.json({ message: 'Configuration cache refreshed successfully' });
    } catch (e) {
      console.error('Error refreshing cache:', e);
      res.status(500).json({ error: 'Failed to refresh cache' });
    }
  });

  app.get('/api/admin/cache/_refresh', (req, res, next) => {
    req.method = 'POST';
    app._router.handle(req, res, next);
  });

  // Support both POST and GET for cache clear
  app.post('/api/admin/cache/_clear', async (req, res) => {
    try {
      configCache.clear();
      res.json({ message: 'Configuration cache cleared successfully' });
    } catch (e) {
      console.error('Error clearing cache:', e);
      res.status(500).json({ error: 'Failed to clear cache' });
    }
  });

  app.get('/api/admin/cache/_clear', (req, res, next) => {
    req.method = 'POST';
    app._router.handle(req, res, next);
  });

  // Force refresh endpoint - triggers client reload by updating refresh salt
  app.post('/api/admin/client/_refresh', async (req, res) => {
    try {
      const rootDir = getRootDir();
      const platformConfigPath = join(rootDir, 'contents', 'config', 'platform.json');
      
      // Read current platform config
      const platformConfig = JSON.parse(readFileSync(platformConfigPath, 'utf8'));
      
      // Initialize refreshSalt if it doesn't exist
      if (!platformConfig.refreshSalt) {
        platformConfig.refreshSalt = {
          salt: 0,
          lastUpdated: new Date().toISOString()
        };
      }
      
      // Increment admin-triggered value and update timestamp
      platformConfig.refreshSalt.salt += 1;
      platformConfig.refreshSalt.lastUpdated = new Date().toISOString();
      
      // Write back to file
      writeFileSync(platformConfigPath, JSON.stringify(platformConfig, null, 2));
      
      // Small delay to ensure file write is complete
      await new Promise(resolve => setTimeout(resolve, 100));
      
      // Refresh specifically the platform configuration
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

  app.get('/api/admin/client/_refresh', (req, res, next) => {
    req.method = 'POST';
    app._router.handle(req, res, next);
  });

}
