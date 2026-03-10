import { adminAuth } from '../../middleware/adminAuth.js';
import { buildServerPath } from '../../utils/basePath.js';
import logger from '../../utils/logger.js';
import {
  checkForUpdate,
  downloadUpdate,
  applyUpdate,
  rollback,
  getUpdateStatus,
  isBinaryInstallation,
  checkDiskSpace,
  checkWritePermissions,
  UPDATE_RESTART_CODE
} from '../../services/updateService.js';

export default function registerAdminUpdateRoutes(app) {
  /**
   * GET /api/admin/update/status
   * Returns the current update status and capabilities
   */
  app.get(buildServerPath('/api/admin/update/status'), adminAuth, (req, res) => {
    res.json(getUpdateStatus());
  });

  /**
   * GET /api/admin/update/check
   * Check for available updates with platform-specific asset info
   */
  app.get(buildServerPath('/api/admin/update/check'), adminAuth, async (req, res) => {
    try {
      const result = await checkForUpdate();
      res.json(result);
    } catch (error) {
      logger.error('Update check failed:', error);
      res.status(500).json({ error: error.message });
    }
  });

  /**
   * POST /api/admin/update/download
   * Download and stage an update
   */
  app.post(buildServerPath('/api/admin/update/download'), adminAuth, async (req, res) => {
    if (!isBinaryInstallation()) {
      return res.status(400).json({
        error: 'In-place updates are only available for binary installations'
      });
    }

    // Pre-flight checks
    const hasPermissions = await checkWritePermissions();
    if (!hasPermissions) {
      return res.status(403).json({
        error: 'Insufficient write permissions on the installation directory'
      });
    }

    const diskSpace = await checkDiskSpace();
    if (!diskSpace.sufficient) {
      return res.status(507).json({
        error: 'Insufficient disk space for update. At least 500MB required.'
      });
    }

    try {
      // Always fetch update info server-side to prevent SSRF via client-supplied URLs
      const updateInfo = await checkForUpdate();
      if (!updateInfo.updateAvailable) {
        return res.json({ success: false, message: 'No update available' });
      }

      const result = await downloadUpdate(updateInfo);
      res.json(result);
    } catch (error) {
      logger.error('Update download failed:', error);
      res.status(500).json({ error: error.message });
    }
  });

  /**
   * POST /api/admin/update/apply
   * Apply a previously downloaded update and trigger server restart
   */
  app.post(buildServerPath('/api/admin/update/apply'), adminAuth, async (req, res) => {
    if (!isBinaryInstallation()) {
      return res.status(400).json({
        error: 'In-place updates are only available for binary installations'
      });
    }

    try {
      const result = await applyUpdate();
      res.json(result);

      // Schedule restart after response is sent
      logger.info('Scheduling server restart for update...');
      setTimeout(() => {
        process.exit(UPDATE_RESTART_CODE);
      }, 1000);
    } catch (error) {
      logger.error('Update apply failed:', error);
      res.status(500).json({ error: error.message });
    }
  });

  /**
   * POST /api/admin/update/rollback
   * Rollback to the previous version
   */
  app.post(buildServerPath('/api/admin/update/rollback'), adminAuth, async (req, res) => {
    if (!isBinaryInstallation()) {
      return res.status(400).json({
        error: 'In-place updates are only available for binary installations'
      });
    }

    try {
      const result = await rollback();
      res.json(result);

      // Schedule restart after response is sent
      logger.info('Scheduling server restart for rollback...');
      setTimeout(() => {
        process.exit(UPDATE_RESTART_CODE);
      }, 1000);
    } catch (error) {
      logger.error('Rollback failed:', error);
      res.status(500).json({ error: error.message });
    }
  });
}
