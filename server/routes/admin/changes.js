import { adminAuth } from '../../middleware/adminAuth.js';
import { buildServerPath } from '../../utils/basePath.js';
import { listSnapshots, getSnapshot } from '../../services/ChangeHistoryService.js';
import { sendNotFound, sendBadRequest, sendInternalError } from '../../utils/responseHelpers.js';
import { validateIdForPath } from '../../utils/pathSecurity.js';
import configCache from '../../configCache.js';
import { atomicWriteJSON } from '../../utils/atomicWrite.js';
import { join } from 'path';
import { getRootDir } from '../../pathUtils.js';
import { logAdminAction } from '../../services/AuditLogService.js';
import logger from '../../utils/logger.js';

const VALID_RESOURCES = [
  'app',
  'group',
  'prompt',
  'model',
  'platform',
  'feature',
  'source',
  'tool'
];

export default function registerAdminChangesRoutes(app) {
  /**
   * GET /api/admin/changes/:resource/:id
   * List snapshots for a resource (metadata only).
   */
  app.get(buildServerPath('/api/admin/changes/:resource/:id'), adminAuth, async (req, res) => {
    try {
      const { resource, id } = req.params;

      if (!VALID_RESOURCES.includes(resource)) {
        return sendBadRequest(res, `Invalid resource type: ${resource}`);
      }
      if (!validateIdForPath(id, resource, res)) {
        return;
      }

      const snapshots = await listSnapshots(resource, id);
      res.json(snapshots);
    } catch (error) {
      return sendInternalError(res, error, 'list change history');
    }
  });

  /**
   * GET /api/admin/changes/:resource/:id/:filename
   * Get a specific snapshot with full before/after data.
   */
  app.get(
    buildServerPath('/api/admin/changes/:resource/:id/:filename'),
    adminAuth,
    async (req, res) => {
      try {
        const { resource, id, filename } = req.params;

        if (!VALID_RESOURCES.includes(resource)) {
          return sendBadRequest(res, `Invalid resource type: ${resource}`);
        }
        if (!validateIdForPath(id, resource, res)) {
          return;
        }

        const snapshot = await getSnapshot(resource, id, filename);
        if (!snapshot) {
          return sendNotFound(res, 'Snapshot');
        }

        res.json(snapshot);
      } catch (error) {
        return sendInternalError(res, error, 'get change snapshot');
      }
    }
  );

  /**
   * POST /api/admin/changes/:resource/:id/:filename/rollback
   * Rollback a resource to the 'before' state of a snapshot.
   */
  app.post(
    buildServerPath('/api/admin/changes/:resource/:id/:filename/rollback'),
    adminAuth,
    async (req, res) => {
      try {
        const { resource, id, filename } = req.params;

        if (!VALID_RESOURCES.includes(resource)) {
          return sendBadRequest(res, `Invalid resource type: ${resource}`);
        }
        if (!validateIdForPath(id, resource, res)) {
          return;
        }

        const snapshot = await getSnapshot(resource, id, filename);
        if (!snapshot || !snapshot.before) {
          return sendNotFound(res, 'Snapshot or before state');
        }

        const rootDir = getRootDir();
        const beforeState = snapshot.before;

        // Rollback based on resource type
        switch (resource) {
          case 'app': {
            const appFilePath = join(rootDir, 'contents', 'apps', `${id}.json`);
            await atomicWriteJSON(appFilePath, beforeState);
            await configCache.refreshAppsCache();
            break;
          }
          case 'prompt': {
            const promptFilePath = join(rootDir, 'contents', 'prompts', `${id}.json`);
            await atomicWriteJSON(promptFilePath, beforeState);
            await configCache.refreshPromptsCache();
            break;
          }
          case 'model': {
            const modelFilePath = join(rootDir, 'contents', 'models', `${id}.json`);
            await atomicWriteJSON(modelFilePath, beforeState);
            await configCache.refreshModelsCache();
            break;
          }
          case 'group': {
            const groupsPath = join(rootDir, 'contents', 'config', 'groups.json');
            const { data: groupsConfig } = configCache.getGroups();
            const config = groupsConfig || { groups: {} };
            config.groups[id] = beforeState;
            await atomicWriteJSON(groupsPath, config);
            await configCache.refreshCacheEntry('config/groups.json');
            break;
          }
          case 'platform': {
            const platformPath = join(rootDir, 'contents', 'config', 'platform.json');
            await atomicWriteJSON(platformPath, beforeState);
            await configCache.refreshCacheEntry('config/platform.json');
            break;
          }
          case 'feature': {
            const featuresPath = join(rootDir, 'contents', 'config', 'features.json');
            await atomicWriteJSON(featuresPath, beforeState);
            await configCache.refreshCacheEntry('config/features.json');
            break;
          }
          default:
            return sendBadRequest(res, `Rollback not supported for: ${resource}`);
        }

        await logAdminAction({
          req,
          action: 'update',
          resource,
          resourceId: id,
          summary: `Rolled back ${resource} ${id} to snapshot ${snapshot.ts}`
        });

        logger.info('Rollback completed', {
          component: 'ChangeHistory',
          resource,
          id,
          snapshotTs: snapshot.ts
        });

        res.json({ message: `Rolled back ${resource} ${id} to ${snapshot.ts}` });
      } catch (error) {
        return sendInternalError(res, error, 'rollback change');
      }
    }
  );
}
