// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * `POST /api/apps/{appId}/_publish`: the owner of a personal app makes it a
 * company app.
 *
 * Registered by `userAppRoutes.js` before its other `{appId}` routes. The
 * owner needs the group permission `userAppSharing`, and an administrator
 * must have switched publishing on (`platform.userApps.sharing.allowPublish`,
 * off by default). An editor of the app never publishes.
 *
 * Registering the route also adds `publish` (what a publish would write) and
 * the readable `publishedAs` to the view of a personal app.
 *
 * Design: concepts/app-builder-rework-2026-11/02-personal-apps.md, sections
 * 8.2, 9.1 and 10.
 *
 * @module routes/userAppPublishRoutes
 */
import { userAppAccessRequired } from '../middleware/userAppAccess.js';
import { logAudit } from '../services/AuditLogService.js';
import {
  publishedAppAuditDetails,
  publishUserApp,
  userAppName,
  userAppViewExtras
} from '../services/userApps/publishUserApp.js';
import { assertChangeable } from '../services/userApps/UserAppService.js';
import { registerUserAppViewExtension } from '../services/userApps/userAppResolution.js';
import { revisionFromIfMatch } from '../services/userApps/userAppView.js';
import { buildServerPath } from '../utils/basePath.js';
import { ServiceError } from '../utils/ServiceError.js';

/** 403 with `details.required: 'publish'`, the answer projects give for their catalog. */
function mayNotPublish(reason) {
  return new ServiceError('PERMISSION_DENIED', 'You may not publish this app', {
    status: 403,
    details: { required: 'publish', ...(reason ? { reason } : {}) }
  });
}

/**
 * Register the publish route of personal apps.
 *
 * @param {import('express').Express} app
 * @param {Object} tools - What `userAppRoutes.js` hands over.
 * @param {import('express').RequestHandler[]} tools.gate - Signed in, feature
 *   on, store available.
 * @param {(res: import('express').Response, record: Object, user: Object) => Promise<void>}
 *   tools.sendApp - Answers with the app and its `ETag`.
 * @param {(record: Object) => {revision: number, contentHash: string|null}} tools.auditStamp
 */
export default function registerUserAppPublishRoutes(app, { gate, sendApp, auditStamp }) {
  registerUserAppViewExtension(userAppViewExtras);

  /**
   * @swagger
   * /api/apps/{appId}/_publish:
   *   post:
   *     summary: Publish a personal app as a company app
   *     description: |
   *       For the owner. Needs the group permission `userAppSharing` and the
   *       setting `platform.userApps.sharing.allowPublish`. Writes a new app
   *       that administrators manage, with an ID the server makes from the
   *       name. The copy holds only what the app may use at this moment. An
   *       app without web search, skills and connected systems is switched on
   *       at once; any other app, and every app when
   *       `publishing.adminEnables` is `always`, stays switched off until an
   *       administrator switches it on. The personal app becomes read-only
   *       and cannot be taken back by the owner. Takes no body.
   *     tags: [Apps]
   *     security:
   *       - bearerAuth: []
   *     parameters:
   *       - in: path
   *         name: appId
   *         required: true
   *         schema: { type: string }
   *       - in: header
   *         name: If-Match
   *         required: true
   *         schema: { type: string }
   *         description: The `ETag` of the app the owner read
   *     responses:
   *       200:
   *         description: |
   *           The personal app, now `promoted`, with
   *           `publishedAs: { appId, name, enabled, at }`. For an owner who can
   *           use the company app at once it is the reduced body with
   *           `publishedAs: { appId, name }`. `ETag` is set.
   *       400:
   *         description: The `If-Match` header is missing, or the app fails the app schema (`VALIDATION_FAILED`)
   *       401:
   *         description: Not signed in (`AUTH_REQUIRED`)
   *       403:
   *         description: Not the owner, publishing is switched off or the owner lacks `userAppSharing` (`PERMISSION_DENIED` with `details.required` `publish`), access changed meanwhile (`USER_APP_ACCESS_CHANGED`), or personal apps are switched off (`USER_APPS_DISABLED`)
   *       404:
   *         description: No app the caller can see (`NOT_FOUND`)
   *       409:
   *         description: Changed by someone else (`ETAG_MISMATCH`), or the app is published already or switched off (`CONFLICT` with `details.reason`)
   *       503:
   *         description: Personal apps are unavailable (`USER_APPS_UNAVAILABLE`)
   */
  app.post(
    buildServerPath('/api/apps/:appId/_publish'),
    ...gate,
    userAppAccessRequired('view'),
    async (req, res) => {
      const permissions = req.userAppPermissions;
      if (!permissions.isOwner) throw mayNotPublish();

      const expectedRevision = revisionFromIfMatch(req.headers['if-match']);
      if (expectedRevision === null) {
        const message = 'The If-Match header with the revision of the app is required';
        throw new ServiceError('VALIDATION_FAILED', message, {
          details: [{ path: 'If-Match', code: 'REQUIRED', message }]
        });
      }
      // Published already, or switched off by an administrator: 409.
      assertChangeable(req.userApp, req.userAppContext);
      if (!permissions.canPublish) throw mayNotPublish(permissions.suspended);

      const before = req.userApp;
      const { settings } = req.userAppContext;
      const {
        record,
        app: published,
        projected
      } = await publishUserApp(before, {
        user: req.user,
        expectedRevision,
        settings,
        // Still the owner, on the record as loaded under its lock.
        authorize: req.userAppContext.authorize('own')
      });

      const name = userAppName(before);
      const ownerName = req.user.name || req.user.id;
      logAudit({
        req,
        action: 'share',
        resource: 'userAppShare',
        resourceId: record.id,
        summary: `Published personal app "${name}" as ${published.id}`,
        details: {
          appId: published.id,
          enabled: published.enabled === true,
          by: 'owner',
          ...auditStamp(before)
        }
      });
      logAudit({
        req,
        action: 'create',
        resource: 'app',
        resourceId: published.id,
        summary: `Published personal app "${name}" by ${ownerName} as ${published.id}`,
        details: {
          ...publishedAppAuditDetails(before, published, projected),
          ...auditStamp(before)
        }
      });
      await sendApp(res, record, req.user);
    }
  );
}
