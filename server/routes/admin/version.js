import { adminAuth } from '../../middleware/adminAuth.js';
import { buildServerPath } from '../../utils/basePath.js';
import { getAppVersion } from '../../utils/versionHelper.js';

export default function registerAdminVersionRoutes(app, basePath = '') {
  /**
   * GET /api/admin/version
   * Returns version information for frontend and backend
   *
   * Uses getAppVersion() which reads from:
   * 1. APP_VERSION environment variable
   * 2. version.txt file (created during build)
   * 3. package.json (development mode)
   * 4. Fallback default
   *
   * All components (app, client, server) share the same version number.
   */
  app.get(buildServerPath('/api/admin/version', basePath), adminAuth, async (req, res) => {
    try {
      const version = getAppVersion();

      res.json({
        app: version,
        client: version,
        server: version,
        node: process.version
      });
    } catch (error) {
      console.error('Error getting version information:', error);
      res.status(500).json({ error: 'Failed to get version information' });
    }
  });
}
