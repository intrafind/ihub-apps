import { adminAuth } from '../../middleware/adminAuth.js';
import { buildServerPath } from '../../utils/basePath.js';
import { getAppVersion } from '../../utils/versionHelper.js';
import {
  buildUpdateInfo,
  getVersionCheckEntry,
  isVersionCheckDisabled,
  startBackgroundVersionCheck
} from '../../services/versionCheckService.js';
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
   * Reports whether a newer version is available on GitHub.
   *
   * This handler never waits on the network (issue #2150). It answers from the
   * version-check cache and, when that cache is cold or stale, kicks off a
   * background refresh whose result the next request picks up. Installations
   * without outbound internet access therefore get an immediate response
   * instead of a request that hangs until the OS TCP timeout — which used to
   * leave the Admin Overview stuck on loading skeletons.
   *
   * Returns:
   * - updateAvailable: boolean
   * - currentVersion: string
   * - latestVersion: string (if a check has succeeded)
   * - releaseUrl: string (if a check has succeeded)
   * - checking: boolean — a check is running; re-request shortly for the result
   * - lastCheckedAt: ISO string | null — when the cached result was produced
   * - error: string (if the last check failed)
   */
  app.get(buildServerPath('/api/admin/version/check-update'), adminAuth, (req, res) => {
    try {
      const currentVersion = getAppVersion();

      if (isVersionCheckDisabled()) {
        return res.json({
          updateAvailable: false,
          currentVersion,
          versionCheckDisabled: true,
          checking: false,
          lastCheckedAt: null
        });
      }

      const entry = getVersionCheckEntry();
      const checking = startBackgroundVersionCheck();

      res.json(buildUpdateInfo(entry, currentVersion, { checking }));
    } catch (error) {
      return sendInternalError(res, error, 'check for updates');
    }
  });
}
