import { adminAuth } from '../../middleware/adminAuth.js';
import { buildServerPath } from '../../utils/basePath.js';
import logger from '../../utils/logger.js';
import {
  sendInternalError,
  sendBadRequest,
  sendErrorResponse
} from '../../utils/responseHelpers.js';
import {
  checkForUpdate,
  downloadUpdate,
  applyUpdate,
  rollback,
  getUpdateStatus,
  isBinaryInstallation,
  isContainerInstallation,
  checkDiskSpace,
  checkWritePermissions,
  UPDATE_RESTART_CODE
} from '../../services/updateService.js';

const CONTAINER_UPDATE_MESSAGE =
  'In-place updates are disabled when running in a container. ' +
  'Pull a new container image and restart the container to update.';

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
      return sendInternalError(res, error, 'check for update');
    }
  });

  /**
   * POST /api/admin/update/download
   * Download and stage an update
   */
  app.post(buildServerPath('/api/admin/update/download'), adminAuth, async (req, res) => {
    if (isContainerInstallation()) {
      return sendBadRequest(res, CONTAINER_UPDATE_MESSAGE);
    }
    if (!isBinaryInstallation()) {
      return sendBadRequest(res, 'In-place updates are only available for binary installations');
    }

    // Pre-flight checks
    const hasPermissions = await checkWritePermissions();
    if (!hasPermissions) {
      return sendErrorResponse(
        res,
        403,
        'Insufficient write permissions on the installation directory'
      );
    }

    const diskSpace = await checkDiskSpace();
    if (!diskSpace.sufficient) {
      return sendErrorResponse(
        res,
        507,
        'Insufficient disk space for update. At least 500MB required.'
      );
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
      return sendInternalError(res, error, 'download update');
    }
  });

  /**
   * POST /api/admin/update/apply
   * Apply a previously downloaded update and trigger server restart
   */
  app.post(buildServerPath('/api/admin/update/apply'), adminAuth, async (req, res) => {
    if (isContainerInstallation()) {
      return sendBadRequest(res, CONTAINER_UPDATE_MESSAGE);
    }
    if (!isBinaryInstallation()) {
      return sendBadRequest(res, 'In-place updates are only available for binary installations');
    }

    try {
      const result = await applyUpdate();
      res.json(result);

      // Schedule restart after response is sent
      logger.info('Scheduling server restart for update', { component: 'AdminUpdate' });
      setTimeout(() => {
        process.exit(UPDATE_RESTART_CODE);
      }, 1000);
    } catch (error) {
      return sendInternalError(res, error, 'apply update');
    }
  });

  /**
   * POST /api/admin/update/rollback
   * Rollback to the previous version
   */
  app.post(buildServerPath('/api/admin/update/rollback'), adminAuth, async (req, res) => {
    if (isContainerInstallation()) {
      return sendBadRequest(res, CONTAINER_UPDATE_MESSAGE);
    }
    if (!isBinaryInstallation()) {
      return sendBadRequest(res, 'In-place updates are only available for binary installations');
    }

    try {
      const result = await rollback();
      res.json(result);

      // Schedule restart after response is sent
      logger.info('Scheduling server restart for rollback', { component: 'AdminUpdate' });
      setTimeout(() => {
        process.exit(UPDATE_RESTART_CODE);
      }, 1000);
    } catch (error) {
      return sendInternalError(res, error, 'rollback update');
    }
  });
}
