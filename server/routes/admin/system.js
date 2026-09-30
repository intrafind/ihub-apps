import configCache from '../../configCache.js';
import { adminAuth } from '../../middleware/adminAuth.js';
import { buildServerPath } from '../../utils/basePath.js';
import { sendInternalError } from '../../utils/responseHelpers.js';
import {
  collectSystemResources,
  getLogFilePath,
  getMonitoredPaths,
  getStorageSnapshot,
  summarizeStorage
} from '../../services/systemResources.js';

export default function registerAdminSystemRoutes(app) {
  /**
   * GET /api/admin/system/resources
   * CPU, memory and disk usage of this host, plus per-process numbers for the
   * primary and every cluster worker (or the single standalone process).
   *
   * In cluster mode the serving worker asks the others over the cluster bus
   * and waits briefly for stragglers; workers that do not answer are listed in
   * `cluster.missingWorkers` rather than silently omitted.
   */
  app.get(buildServerPath('/api/admin/system/resources'), adminAuth, async (req, res) => {
    try {
      const platform = configCache.getPlatform() || {};
      const snapshot = await collectSystemResources({ logFile: getLogFilePath(platform) });
      res.set('Cache-Control', 'no-store');
      res.json(snapshot);
    } catch (error) {
      return sendInternalError(res, error, 'collect system resources');
    }
  });

  /**
   * GET /api/admin/system/storage
   * Status of the fullest volume iHub writes to, for the low-disk banner shown
   * on every admin page. Cheap (a few `statfs` calls, no cross-worker
   * gather), so the admin layout can poll it. `null` when no volume could be
   * read.
   */
  app.get(buildServerPath('/api/admin/system/storage'), adminAuth, async (req, res) => {
    try {
      const platform = configCache.getPlatform() || {};
      const storage = await getStorageSnapshot(
        getMonitoredPaths({ logFile: getLogFilePath(platform) })
      );
      res.set('Cache-Control', 'no-store');
      res.json({ storage: summarizeStorage(storage) });
    } catch (error) {
      return sendInternalError(res, error, 'check disk space');
    }
  });
}
