import { promises as fs } from 'fs';
import { join } from 'path';
import { getRootDir } from '../../pathUtils.js';
import { atomicWriteJSON } from '../../utils/atomicWrite.js';
import configCache from '../../configCache.js';
import { adminAuth, isAdminAuthRequired, hashPassword } from '../../middleware/adminAuth.js';

export default function registerAdminAuthRoutes(app) {
  app.get('/api/admin/auth/status', async(req, res) => {
    try {
      const authRequired = isAdminAuthRequired();
      res.json({
        authRequired,
        authenticated: !authRequired || req.headers.authorization?.startsWith('Bearer ')
      });
    } catch (error) {
      console.error('Error checking admin auth status:', error);
      res.status(500).json({ error: 'Failed to check authentication status' });
    }
  });

  app.get('/api/admin/auth/test', adminAuth, async(req, res) => {
    try {
      res.json({ message: 'Admin authentication successful', authenticated: true });
    } catch (error) {
      console.error('Error testing admin auth:', error);
      res.status(500).json({ error: 'Failed to test authentication' });
    }
  });

  app.post('/api/admin/auth/change-password', adminAuth, async(req, res) => {
    try {
      const { newPassword } = req.body;
      if (!newPassword || typeof newPassword !== 'string' || newPassword.length < 1) {
        return res.status(400).json({ error: 'New password is required' });
      }
      const rootDir = getRootDir();
      const platformConfigPath = join(rootDir, 'contents', 'config', 'platform.json');
      const platformConfigData = await fs.readFile(platformConfigPath, 'utf8');
      const platformConfig = JSON.parse(platformConfigData);
      if (!platformConfig.admin) {
        platformConfig.admin = {};
      }
      const hashedPassword = hashPassword(newPassword);
      platformConfig.admin.secret = hashedPassword;
      platformConfig.admin.encrypted = true;
      await atomicWriteJSON(platformConfigPath, platformConfig);
      await configCache.refreshCacheEntry('config/platform.json');
      console.log('🔐 Admin password changed and encrypted');
      res.json({ message: 'Admin password changed successfully', encrypted: true });
    } catch (error) {
      console.error('Error changing admin password:', error);
      res.status(500).json({ error: 'Failed to change admin password' });
    }
  });
}
