// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

import multer from 'multer';
import configCache from '../../configCache.js';
import { adminAuth } from '../../middleware/adminAuth.js';
import { buildServerPath } from '../../utils/basePath.js';
import logger from '../../utils/logger.js';
import { logAudit } from '../../services/AuditLogService.js';
import { requestServerRestart } from '../../utils/processRestart.js';
import {
  sendInternalError,
  sendBadRequest,
  sendErrorResponse
} from '../../utils/responseHelpers.js';
import {
  UpdateRequestError,
  applyUpdate,
  checkForUpdate,
  checkWritePermissions,
  createWorkDir,
  discardStaged,
  downloadUpdate,
  getUpdateSettings,
  getUpdateStatusAnywhere,
  isAcceptedUploadName,
  isBinaryInstallation,
  isContainerInstallation,
  listLocalCandidates,
  removeWorkDir,
  rollback,
  setUpdateSettingsProvider,
  stageLocalFile,
  stageUploadedFile
} from '../../services/updateService.js';

const CONTAINER_UPDATE_MESSAGE =
  'In-place updates are disabled when running in a container. ' +
  'Pull a new container image and restart the container to update.';

/**
 * Rejects the request unless in-place updates are possible here. Every
 * endpoint that changes anything goes through it.
 */
async function requireUpdatableInstallation(req, res, next) {
  if (isContainerInstallation()) {
    return sendBadRequest(res, CONTAINER_UPDATE_MESSAGE);
  }
  if (!isBinaryInstallation()) {
    return sendBadRequest(res, 'In-place updates are only available for binary installations');
  }
  if (!(await checkWritePermissions())) {
    return sendErrorResponse(
      res,
      403,
      'Insufficient write permissions on the installation directory'
    );
  }
  next();
}

function sendUpdateError(res, error, context) {
  if (error instanceof UpdateRequestError) {
    return sendErrorResponse(
      res,
      error.status,
      error.message,
      error.code ? { details: { code: error.code } } : {}
    );
  }
  return sendInternalError(res, error, context);
}

/** Staging result: 200 when staged, 422 with the summary when the archive was rejected. */
function sendStageResult(res, summary) {
  if (summary.accepted) return res.json(summary);
  return res.status(422).json({
    error: summary.problems.map(problem => problem.message).join('; '),
    summary
  });
}

function auditStage(req, summary, extra = '') {
  logAudit({
    req,
    action: 'import',
    resource: 'update',
    resourceId: summary.version || 'unknown',
    result: summary.accepted ? 'success' : 'failure',
    summary:
      `Staged update archive ${summary.fileName} from ${summary.source}${extra}: ` +
      `version ${summary.version}, ${summary.archiveSize} bytes, sha256 ${summary.archiveSha256}, ` +
      `signature ${summary.signature.status}, checksum ${summary.checksum}` +
      (summary.accepted ? '' : `; rejected: ${summary.problems.map(p => p.code).join(', ')}`)
  });
}

function auditFailure(req, action, resourceId, error) {
  logAudit({
    req,
    action,
    resource: 'update',
    resourceId,
    result: 'failure',
    summary: error.message
  });
}

export default function registerAdminUpdateRoutes(app) {
  setUpdateSettingsProvider(() => configCache.getPlatform()?.update);

  // Uploads are streamed to disk (an archive is 100+ MB), each into its own
  // private directory below .update-tmp/.
  const upload = multer({
    storage: multer.diskStorage({
      destination: (req, _file, cb) => {
        if (req.updateUploadDir) {
          cb(null, req.updateUploadDir);
          return;
        }
        createWorkDir('upload').then(dir => {
          req.updateUploadDir = dir;
          cb(null, dir);
        }, cb);
      },
      // Fixed names: the client-supplied name is never used as a path.
      filename: (_req, file, cb) => cb(null, file.fieldname)
    }),
    limits: {
      fileSize: getUpdateSettings().maxUploadSizeMB * 1024 * 1024,
      files: 3,
      fields: 5
    },
    fileFilter: (_req, file, cb) => {
      if (isAcceptedUploadName(file.originalname)) cb(null, true);
      else cb(new UpdateRequestError(`Not a release archive: ${file.originalname}`));
    }
  });
  const uploadFields = upload.fields([
    { name: 'archive', maxCount: 1 },
    { name: 'checksums', maxCount: 1 },
    { name: 'checksumsSig', maxCount: 1 }
  ]);

  /**
   * GET /api/admin/update/status
   * Current update status, capabilities, the staged release and the result of
   * the last apply. Independent of the GitHub check, so it answers offline.
   */
  app.get(buildServerPath('/api/admin/update/status'), adminAuth, async (req, res) => {
    // The update may be running on another cluster worker.
    try {
      res.json(await getUpdateStatusAnywhere());
    } catch (error) {
      return sendInternalError(res, error, 'get update status');
    }
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
   * Download the latest release from GitHub and stage it
   */
  app.post(
    buildServerPath('/api/admin/update/download'),
    adminAuth,
    requireUpdatableInstallation,
    async (req, res) => {
      try {
        // Always fetch update info server-side to prevent SSRF via client-supplied URLs
        const updateInfo = await checkForUpdate();
        if (!updateInfo.updateAvailable) {
          return res.json({ success: false, message: 'No update available' });
        }

        const summary = await downloadUpdate(updateInfo);
        auditStage(req, summary);
        return sendStageResult(res, summary);
      } catch (error) {
        auditFailure(req, 'import', 'github', error);
        return sendUpdateError(res, error, 'download update');
      }
    }
  );

  /**
   * POST /api/admin/update/stage-upload
   * multipart/form-data: `archive` (required), `checksums`, `checksumsSig` (optional)
   */
  app.post(
    buildServerPath('/api/admin/update/stage-upload'),
    adminAuth,
    requireUpdatableInstallation,
    (req, res, next) => {
      uploadFields(req, res, error => {
        if (!error) return next();
        removeWorkDir(req.updateUploadDir);
        if (error instanceof UpdateRequestError) return sendBadRequest(res, error.message);
        if (error.code === 'LIMIT_FILE_SIZE') {
          return sendErrorResponse(
            res,
            413,
            `The upload exceeds the limit of ${getUpdateSettings().maxUploadSizeMB} MB`,
            { details: { code: 'upload-too-large' } }
          );
        }
        return sendBadRequest(res, `Upload failed: ${error.message}`);
      });
    },
    async (req, res) => {
      try {
        const files = req.files || {};
        const summary = await stageUploadedFile(
          files.archive?.[0],
          files.checksums?.[0],
          files.checksumsSig?.[0]
        );
        auditStage(req, summary);
        return sendStageResult(res, summary);
      } catch (error) {
        auditFailure(req, 'import', 'upload', error);
        return sendUpdateError(res, error, 'stage uploaded update');
      } finally {
        removeWorkDir(req.updateUploadDir);
      }
    }
  );

  /**
   * POST /api/admin/update/stage-local
   * { "path": "<absolute path of an archive on the server>" }
   */
  app.post(
    buildServerPath('/api/admin/update/stage-local'),
    adminAuth,
    requireUpdatableInstallation,
    async (req, res) => {
      const requestedPath = req.body?.path;
      try {
        const summary = await stageLocalFile(requestedPath);
        auditStage(req, summary, ` (${summary.sourcePath})`);
        return sendStageResult(res, summary);
      } catch (error) {
        auditFailure(req, 'import', 'local', error);
        return sendUpdateError(res, error, 'stage update from file');
      }
    }
  );

  /**
   * GET /api/admin/update/local-candidates
   * Archives found in the installation's updates/ folder
   */
  app.get(buildServerPath('/api/admin/update/local-candidates'), adminAuth, async (req, res) => {
    try {
      res.json(await listLocalCandidates());
    } catch (error) {
      return sendInternalError(res, error, 'list update files');
    }
  });

  /**
   * DELETE /api/admin/update/staged
   * Discard the staged release
   */
  app.delete(
    buildServerPath('/api/admin/update/staged'),
    adminAuth,
    requireUpdatableInstallation,
    async (req, res) => {
      try {
        await discardStaged();
        logAudit({
          req,
          action: 'delete',
          resource: 'update',
          resourceId: 'staged',
          summary: 'Discarded the staged update'
        });
        res.json({ success: true });
      } catch (error) {
        return sendUpdateError(res, error, 'discard staged update');
      }
    }
  );

  /**
   * POST /api/admin/update/apply
   * { confirmDowngrade?: boolean, confirmUnsigned?: string, skipConfigSnapshot?: boolean }
   * Apply the staged release and restart the server
   */
  app.post(
    buildServerPath('/api/admin/update/apply'),
    adminAuth,
    requireUpdatableInstallation,
    async (req, res) => {
      const body = req.body || {};
      try {
        const result = await applyUpdate({
          confirmDowngrade: body.confirmDowngrade === true,
          confirmUnsigned:
            typeof body.confirmUnsigned === 'string' ? body.confirmUnsigned : undefined,
          skipConfigSnapshot: body.skipConfigSnapshot === true
        });
        logAudit({
          req,
          action: 'execute',
          resource: 'update',
          resourceId: result.newVersion,
          summary:
            `Applied update ${result.previousVersion} → ${result.newVersion} (${result.applyMode}` +
            `${result.configSnapshot ? ', configuration snapshot taken' : ', NO configuration snapshot'}` +
            `${body.confirmUnsigned ? ', unsigned archive confirmed' : ''})`
        });
        res.json(result);

        logger.info('Scheduling server restart for update', { component: 'AdminUpdate' });
        requestServerRestart();
      } catch (error) {
        auditFailure(req, 'execute', 'apply', error);
        return sendUpdateError(res, error, 'apply update');
      }
    }
  );

  /**
   * POST /api/admin/update/rollback
   * { restoreConfig?: boolean }
   * Roll back to the previous version and restart the server
   */
  app.post(
    buildServerPath('/api/admin/update/rollback'),
    adminAuth,
    requireUpdatableInstallation,
    async (req, res) => {
      const restoreConfig = req.body?.restoreConfig === true;
      try {
        const result = await rollback({ restoreConfig });
        logAudit({
          req,
          action: 'execute',
          resource: 'update',
          resourceId: result.restoredVersion || 'rollback',
          summary: `Rolled back to ${result.restoredVersion}${restoreConfig ? ' and restored the configuration snapshot' : ''}`
        });
        res.json(result);

        logger.info('Scheduling server restart for rollback', { component: 'AdminUpdate' });
        requestServerRestart();
      } catch (error) {
        auditFailure(req, 'execute', 'rollback', error);
        return sendUpdateError(res, error, 'rollback update');
      }
    }
  );
}
