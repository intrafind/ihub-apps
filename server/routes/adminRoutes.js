import { getUsage } from '../usageTracker.js';
import configCache from '../configCache.js';

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

}
