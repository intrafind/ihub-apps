// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

import { adminAuth } from '../../middleware/adminAuth.js';
import { buildServerPath } from '../../utils/basePath.js';
import { ServiceError } from '../../utils/ServiceError.js';
import { listSnapshots, getSnapshot } from '../../services/ChangeHistoryService.js';
import { assertValidId } from '../../utils/pathSecurity.js';
import configCache from '../../configCache.js';
import configStore from '../../services/config/ConfigStore.js';
import { logAudit } from '../../services/AuditLogService.js';
import logger from '../../utils/logger.js';
import { updatePlatform } from '../../utils/platformConfigStore.js';
import {
  assertGroupChangeKeepsAdmin,
  assertGroupsResolvable,
  assertPlatformChangeKeepsAccess
} from '../../utils/adminGuards.js';
import {
  PLATFORM_SECRET_PATHS,
  assertNoMarkers,
  redactForRead,
  restoreRedacted
} from '../../utils/redactedSecrets.js';
import { withAdminInvariantLock } from '../../utils/adminInvariantLock.js';

const VALID_RESOURCES = new Set([
  'app',
  'group',
  'prompt',
  'model',
  'platform',
  'feature',
  'source',
  'tool',
  'project'
]);

export default function registerAdminChangesRoutes(app) {
  /**
   * GET /api/admin/changes/:resource/:id
   * List snapshots for a resource (metadata only).
   */
  app.get(buildServerPath('/api/admin/changes/:resource/:id'), adminAuth, async (req, res) => {
    const { resource, id } = req.params;

    if (!VALID_RESOURCES.has(resource)) {
      throw new ServiceError('BAD_REQUEST', `Invalid resource type: ${resource}`);
    }
    assertValidId(id, resource);

    const snapshots = await listSnapshots(resource, id);
    res.json(snapshots);
  });

  /**
   * GET /api/admin/changes/:resource/:id/:filename
   * Get a specific snapshot with full before/after data.
   */
  app.get(
    buildServerPath('/api/admin/changes/:resource/:id/:filename'),
    adminAuth,
    async (req, res) => {
      const { resource, id, filename } = req.params;

      if (!VALID_RESOURCES.has(resource)) {
        throw new ServiceError('BAD_REQUEST', `Invalid resource type: ${resource}`);
      }
      assertValidId(id, resource);

      const snapshot = await getSnapshot(resource, id, filename);
      if (!snapshot) {
        throw new ServiceError('NOT_FOUND', 'Snapshot not found');
      }

      // A platform snapshot holds the file as stored, JWT secrets included.
      // It shows them as the platform read does: redacted.
      if (resource === 'platform') {
        res.json({
          ...snapshot,
          before: redactForRead(snapshot.before, PLATFORM_SECRET_PATHS),
          after: redactForRead(snapshot.after, PLATFORM_SECRET_PATHS)
        });
        return;
      }

      res.json(snapshot);
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
      const { resource, id, filename } = req.params;

      if (!VALID_RESOURCES.has(resource)) {
        throw new ServiceError('BAD_REQUEST', `Invalid resource type: ${resource}`);
      }
      assertValidId(id, resource);

      const snapshot = await getSnapshot(resource, id, filename);
      if (!snapshot || !snapshot.before) {
        throw new ServiceError('NOT_FOUND', 'Snapshot or before state not found');
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
          await configStore.writeJson(await configStore.resolveIdToPath('models', id), beforeState);
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
          //
          // The rolled-back body must resolve (a snapshot can name a parent
          // deleted since) and must leave an administrator who can sign in.
          await withAdminInvariantLock(() =>
            configStore.updateJson('config/groups.json', async current => {
              const config = current || { groups: {} };
              if (!config.groups || typeof config.groups !== 'object') config.groups = {};
              const previous = structuredClone(config);
              config.groups[id] = beforeState;
              assertGroupsResolvable(config, previous);
              await assertGroupChangeKeepsAdmin(previous, config, { groupId: id });
              return config;
            })
          );
          await configCache.refreshCacheEntry('config/groups.json');
          break;
        }
        case 'platform': {
          // A rollback replaces the whole file by design; it still goes through
          // the platform update lock so it cannot interleave with another save.
          // It is refused, like any platform save, when it would lock the
          // caller or every administrator out (409 AUTH_LOCKOUT).
          // Secrets are not rolled back: the current ones stay (a rollback must
          // not bring back a rotated, possibly leaked secret, nor write the
          // marker an older snapshot may hold), and a marker that is left is
          // refused rather than stored.
          await updatePlatform(async stored => {
            const next = restoreRedacted(
              structuredClone(beforeState),
              stored,
              PLATFORM_SECRET_PATHS,
              { mode: 'rollback' }
            );
            assertNoMarkers(next);
            await assertPlatformChangeKeepsAccess(req.user, stored, next);
            return next;
          });
          await configCache.refreshCacheEntry('config/platform.json');
          break;
        }
        case 'feature': {
          await configStore.writeJson('config/features.json', beforeState);
          await configCache.refreshCacheEntry('config/features.json');
          break;
        }
        default:
          throw new ServiceError('BAD_REQUEST', `Rollback not supported for: ${resource}`);
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

      res.json({ resource, id, snapshotTs: snapshot.ts });
    }
  );
}
