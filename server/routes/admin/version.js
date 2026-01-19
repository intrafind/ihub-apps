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
  app.get(
    buildServerPath('/api/admin/version/check-update', basePath),
    adminAuth,
    async (req, res) => {
      try {
        const currentVersion = getAppVersion();

        // Fetch latest release from GitHub
        const response = await fetch(
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
        console.error('Error checking for updates:', error);

        // Return graceful response with no update available on error
        const currentVersion = getAppVersion();
        res.json({
          updateAvailable: false,
          currentVersion,
          error: 'Failed to check for updates: ' + error.message
        });
      }
    }
  );
}

/**
 * Compare two semantic versions
 * Returns: 1 if v1 > v2, -1 if v1 < v2, 0 if equal
 */
function compareVersions(v1, v2) {
  const parts1 = v1.split('.').map(Number);
  const parts2 = v2.split('.').map(Number);

  for (let i = 0; i < Math.max(parts1.length, parts2.length); i++) {
    const part1 = parts1[i] || 0;
    const part2 = parts2[i] || 0;

    if (part1 > part2) return 1;
    if (part1 < part2) return -1;
  }

  return 0;
}
