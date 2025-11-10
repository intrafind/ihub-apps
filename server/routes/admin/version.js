import { adminAuth } from '../../middleware/adminAuth.js';
import { buildServerPath } from '../../utils/basePath.js';
import { getAppVersion } from '../../utils/versionHelper.js';
import { readFileSync, existsSync } from 'fs';
import { join } from 'path';
import { getRootDir } from '../../pathUtils.js';

/**
 * Get client version from package.json
 */
function getClientVersion() {
  const rootDir = getRootDir();
  const clientPackageJsonPath = join(rootDir, 'client', 'package.json');

  if (existsSync(clientPackageJsonPath)) {
    try {
      const packageJson = JSON.parse(readFileSync(clientPackageJsonPath, 'utf8'));
      return packageJson.version || '1.0.0';
    } catch (error) {
      console.warn('Could not read version from client package.json:', error.message);
    }
  }

  return '1.0.0';
}

/**
 * Get server version from package.json
 */
function getServerVersion() {
  const rootDir = getRootDir();
  const serverPackageJsonPath = join(rootDir, 'server', 'package.json');

  if (existsSync(serverPackageJsonPath)) {
    try {
      const packageJson = JSON.parse(readFileSync(serverPackageJsonPath, 'utf8'));
      return packageJson.version || '1.0.0';
    } catch (error) {
      console.warn('Could not read version from server package.json:', error.message);
    }
  }

  return '1.0.0';
}

export default function registerAdminVersionRoutes(app, basePath = '') {
  /**
   * GET /api/admin/version
   * Returns version information for frontend and backend
   */
  app.get(buildServerPath('/api/admin/version', basePath), adminAuth, async (req, res) => {
    try {
      const appVersion = getAppVersion();
      const clientVersion = getClientVersion();
      const serverVersion = getServerVersion();

      res.json({
        app: appVersion,
        client: clientVersion,
        server: serverVersion,
        node: process.version
      });
    } catch (error) {
      console.error('Error getting version information:', error);
      res.status(500).json({ error: 'Failed to get version information' });
    }
  });
}
