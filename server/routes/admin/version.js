import { adminAuth } from '../../middleware/adminAuth.js';
import { buildServerPath } from '../../utils/basePath.js';
import { getAppVersion } from '../../utils/versionHelper.js';
import { httpFetch } from '../../utils/httpConfig.js';
import { compareVersions, isVersionCheckDisabled } from '../../services/updateService.js';
import logger from '../../utils/logger.js';
import { sendInternalError } from '../../utils/responseHelpers.js';

export default function registerAdminVersionRoutes(app) {
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
  app.get(buildServerPath('/api/admin/version'), adminAuth, async (req, res) => {
    try {
      const version = getAppVersion();

      res.json({
        app: version,
        client: version,
        server: version,
        node: process.version
      });
    } catch (error) {
      return sendInternalError(res, error, 'get version information');
    }
  });

  /**
   * GET /api/admin/version/check-update
   * Checks if a newer version is available on GitHub
   *
   * Returns:
   * - updateAvailable: boolean
   * - currentVersion: string
   * - latestVersion: string (if available)
   * - releaseUrl: string (if available)
   * - error: string (if check failed)
   */
  app.get(buildServerPath('/api/admin/version/check-update'), adminAuth, async (req, res) => {
    try {
      const currentVersion = getAppVersion();

      if (isVersionCheckDisabled()) {
        return res.json({
          updateAvailable: false,
          currentVersion,
          versionCheckDisabled: true
        });
      }

      // Fetch latest release from GitHub
      const response = await httpFetch(
        'https://api.github.com/repos/intrafind/ihub-apps/releases/latest',
        {
          headers: {
            Accept: 'application/vnd.github.v3+json',
            'User-Agent': 'ihub-apps'
          }
        }
      );

      if (!response.ok) {
        // If no releases found or other error, return no update available
        return res.json({
          updateAvailable: false,
          currentVersion,
          error:
            response.status === 404 ? 'No releases found' : `GitHub API error: ${response.status}`
        });
      }

      const releaseData = await response.json();

      // Validate tag_name exists
      if (!releaseData.tag_name) {
        return res.json({
          updateAvailable: false,
          currentVersion,
          error: 'Invalid release data from GitHub'
        });
      }

      const latestVersion = releaseData.tag_name.replace(/^v/, ''); // Remove 'v' prefix if present

      // Simple version comparison
      const updateAvailable = compareVersions(latestVersion, currentVersion) > 0;

      res.json({
        updateAvailable,
        currentVersion,
        latestVersion,
        releaseUrl: releaseData.html_url,
        releaseName: releaseData.name,
        publishedAt: releaseData.published_at
      });
    } catch (error) {
      logger.error('Error checking for updates', { component: 'AdminVersion', error });

      // Return graceful response with no update available on error
      const currentVersion = getAppVersion();
      res.json({
        updateAvailable: false,
        currentVersion,
        error: 'Failed to check for updates: ' + error.message
      });
    }
  });
}
