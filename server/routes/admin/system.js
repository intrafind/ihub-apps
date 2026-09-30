import configCache from '../../configCache.js';
import { adminAuth } from '../../middleware/adminAuth.js';
import { buildServerPath } from '../../utils/basePath.js';
import { sendInternalError } from '../../utils/responseHelpers.js';
import { collectSystemResources, getLogFilePath } from '../../services/systemResources.js';

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
}
