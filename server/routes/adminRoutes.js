import { getUsage } from '../usageTracker.js';

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

}
