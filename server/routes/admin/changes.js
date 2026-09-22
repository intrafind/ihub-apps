import { adminAuth } from '../../middleware/adminAuth.js';
import { buildServerPath } from '../../utils/basePath.js';
import { listSnapshots, getSnapshot } from '../../services/ChangeHistoryService.js';
import { sendNotFound, sendBadRequest, sendInternalError } from '../../utils/responseHelpers.js';
import { validateIdForPath } from '../../utils/pathSecurity.js';
import configCache from '../../configCache.js';
import configStore from '../../services/config/ConfigStore.js';
import { logAudit } from '../../services/AuditLogService.js';
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

        const beforeState = snapshot.before;

        // Rollback based on resource type. Per-resource files are addressed
        // through resolveIdToPath: a file whose name diverges from the id
        // inside it must be rolled back in place, not forked into `<id>.json`.
        switch (resource) {
          case 'app': {
            await configStore.writeJson(await configStore.resolveIdToPath('apps', id), beforeState);
            await configCache.refreshAppsCache();
            break;
          }
          case 'prompt': {
            await configStore.writeJson(
              await configStore.resolveIdToPath('prompts', id),
              beforeState
            );
            await configCache.refreshPromptsCache();
            break;
          }
          case 'model': {
            await configStore.writeJson(
              await configStore.resolveIdToPath('models', id),
              beforeState
            );
            await configCache.refreshModelsCache();
            break;
          }
          case 'group': {
            // The authored file, not `configCache.getGroups()`. The cache holds
            // groups with inheritance already resolved — every child carries the
            // union of its parents' permissions — so writing the cache back
            // replaces the authored `groups.json` with its own expansion. The
            // rolled-back group is not the damage: every *other* group in the
            // file has its inherited permissions baked in as its own, and from
            // then on editing a parent no longer reaches its children. Granting
            // or revoking a permission at the top of the hierarchy would appear
            // to work and change nothing, which is the wrong way for a
            // permission system to fail.
            //
            // `beforeState` comes from a snapshot the groups routes take from
            // this same authored file, so it merges back into it unchanged.
            const config = (await configStore.readJsonStrict('config/groups.json')) || {
              groups: {}
            };
            if (!config.groups || typeof config.groups !== 'object') config.groups = {};
            config.groups[id] = beforeState;
            await configStore.writeJson('config/groups.json', config);
            await configCache.refreshCacheEntry('config/groups.json');
            break;
          }
          case 'platform': {
            await configStore.writeJson('config/platform.json', beforeState);
            await configCache.refreshCacheEntry('config/platform.json');
            break;
          }
          case 'feature': {
            await configStore.writeJson('config/features.json', beforeState);
            await configCache.refreshCacheEntry('config/features.json');
            break;
          }
          default:
            return sendBadRequest(res, `Rollback not supported for: ${resource}`);
        }

        await logAudit({
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
