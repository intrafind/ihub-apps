// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * The admin side of publishing personal apps, under `/api/admin/user-apps`:
 *
 * - `GET /_waiting` — the published apps that are not switched on. The one
 *   route of personal apps a content admin may call. It returns the company
 *   app's ID and name, the former owner's name and the date, and nothing of
 *   the personal app.
 * - `POST /{appId}/_promote` — a full admin takes a personal app over as an
 *   admin app, without the owner. It does not depend on
 *   `sharing.allowPublish`, and the app always starts switched off.
 * - `POST /{appId}/_release` — a full admin gives a published app back to its
 *   owner. The company app stays.
 *
 * All three work with the feature off. Registering them also adds
 * `membersWithoutCompanyApp` and `takeOverPreview` to the admin view of one
 * app (`routes/admin/userApps.js`).
 *
 * Design: concepts/app-builder-rework-2026-11/02-personal-apps.md, sections
 * 8.2, 8.4, 9.2 and 10.
 *
 * @module routes/admin/userAppPublish
 */
import { z } from 'zod';
import { adminAuth } from '../../middleware/adminAuth.js';
import { contentAdminAuth } from '../../middleware/contentAdminAuth.js';
import { logAudit } from '../../services/AuditLogService.js';
import { getUserAppRepository } from '../../services/userApps/UserAppRepository.js';
import {
  companyAppOf,
  membersWithoutCompanyApp,
  promoteUserApp,
  publishedAppAuditDetails,
  releaseUserApp,
  takeOverPreview,
  userAppName,
  waitingCompanyApps
} from '../../services/userApps/publishUserApp.js';
import {
  effectiveUserAppState,
  lookupUserAppOwner
} from '../../services/userApps/userAppAccess.js';
import { isConfigAppId } from '../../services/userApps/userAppResolution.js';
import { currentUserAppSettings } from '../../services/userApps/userAppSettings.js';
import {
  adminUserAppView,
  revisionFromIfMatch,
  userAppEtag
} from '../../services/userApps/userAppView.js';
import { buildServerPath } from '../../utils/basePath.js';
import { sendCreated, segment } from '../../utils/created.js';
import { ServiceError } from '../../utils/ServiceError.js';
import { isUserAppId } from '../../../shared/userAppContent.js';
import { APP_ID_MAX_LENGTH, APP_ID_PATTERN } from '../../../shared/validationPatterns.js';
import { registerAdminUserAppViewExtension } from './userApps.js';

/** The body of `POST …/{appId}/_promote`. Both keys are optional; no other key passes. */
const promoteBodySchema = z
  .object({
    // The allow-list of an app ID at the source: the value becomes part of a
    // file name (apps/<id>.json). promoteUserApp checks the reserved names.
    id: z
      .string()
      .trim()
      .min(1)
      .max(APP_ID_MAX_LENGTH)
      .regex(APP_ID_PATTERN)
      .refine(value => !value.includes('..') && value !== '.', 'No path segments'),
    category: z.string().trim().min(1).max(64)
  })
  .partial()
  .strict();

const notFound = () => new ServiceError('NOT_FOUND', 'App not found');

/** What every audit entry about a personal app carries (design 10). */
function auditStamp(record) {
  return { revision: Number(record.revision) || 1, contentHash: record.contentHash || null };
}

function availableRepository() {
  const repo = getUserAppRepository();
  if (!repo.isAvailable()) {
    throw new ServiceError('USER_APPS_UNAVAILABLE', 'Personal apps cannot be stored at the moment');
  }
  return repo;
}

async function loadRecord(req) {
  if (!isUserAppId(req.params.appId)) throw notFound();
  const record = await availableRepository().get(req.params.appId);
  if (!record) throw notFound();
  return record;
}

/**
 * What this module adds to the admin view of one app: for a published app
 * how many members cannot use the company app, for any other app what a
 * take-over by this admin would write.
 *
 * @param {{record: Object, user: Object, settings: Object}} context
 * @returns {Promise<{membersWithoutCompanyApp?: number, takeOverPreview?: Object}>}
 */
async function adminUserAppViewExtras({ record, user, settings }) {
  const company = companyAppOf(record);
  const state = effectiveUserAppState(record, { publishedAppExists: company.exists });
  if (state === 'promoted') return { membersWithoutCompanyApp: membersWithoutCompanyApp(record) };
  return { takeOverPreview: await takeOverPreview(record, { admin: user, settings }) };
}

/**
 * Register `_waiting`, `_promote` and `_release`.
 *
 * @param {import('express').Application} app
 */
export default function registerAdminUserAppPublishRoutes(app) {
  const route = suffix => buildServerPath(`/api/admin/user-apps${suffix}`);
  registerAdminUserAppViewExtension(adminUserAppViewExtras);

  /**
   * @swagger
   * /api/admin/user-apps/_waiting:
   *   get:
   *     summary: Published apps that are not switched on
   *     description: |
   *       The apps users published from a personal app that an administrator
   *       has not switched on yet, oldest first. For content admins and full
   *       admins. Each item is about the company app: its ID and name, who
   *       published it and when. Nothing of the personal app is returned.
   *       Works with the personal apps feature off.
   *     tags: [Admin Personal Apps]
   *     responses:
   *       200:
   *         description: The waiting apps
   *         content:
   *           application/json:
   *             schema:
   *               type: object
   *               required: [items, nextCursor]
   *               properties:
   *                 items:
   *                   type: array
   *                   items:
   *                     type: object
   *                     properties:
   *                       appId: { type: string, description: The ID of the company app }
   *                       name: { type: object, description: The name of the company app, per language }
   *                       publishedAt: { type: string, format: date-time, nullable: true }
   *                       publishedBy:
   *                         type: object
   *                         nullable: true
   *                         properties:
   *                           name: { type: string }
   *                 nextCursor: { type: string, nullable: true, description: Always null }
   *       403: { description: Not a content admin or full admin }
   */
  app.get(route('/_waiting'), contentAdminAuth, async (req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    res.json({ items: await waitingCompanyApps(), nextCursor: null });
  });

  /**
   * @swagger
   * /api/admin/user-apps/{appId}/_promote:
   *   post:
   *     summary: Take a personal app over as an admin app
   *     description: |
   *       For full admins, without the owner and whatever
   *       `sharing.allowPublish` says. Writes a new admin app that is not
   *       switched on. It holds only what the owner and the calling admin may
   *       both use at this moment. The personal app becomes read-only. The
   *       server makes the ID from the name unless `id` is sent.
   *     tags: [Admin Personal Apps]
   *     parameters:
   *       - in: path
   *         name: appId
   *         required: true
   *         schema: { type: string }
   *       - in: header
   *         name: If-Match
   *         required: true
   *         schema: { type: string }
   *         description: The `ETag` of the admin view the admin read
   *     requestBody:
   *       content:
   *         application/json:
   *           schema:
   *             type: object
   *             additionalProperties: false
   *             properties:
   *               id: { type: string, description: The ID of the new app }
   *               category: { type: string }
   *     responses:
   *       201:
   *         description: The new admin app; `Location` is `/api/admin/apps/{id}`
   *       400:
   *         description: The `If-Match` header is missing, the body or the ID is invalid, or the app fails the app schema (`VALIDATION_FAILED`)
   *       403: { description: Not a full admin }
   *       404: { description: No personal app has this ID (`NOT_FOUND`) }
   *       409:
   *         description: The ID is taken or the app is published already (`CONFLICT` with `details.reason` `idTaken` or `promoted`), or the app changed (`ETAG_MISMATCH`)
   *       503: { description: The store cannot hold personal apps (`USER_APPS_UNAVAILABLE`) }
   */
  app.post(route('/:appId/_promote'), adminAuth, async (req, res) => {
    const body = promoteBodySchema.parse(req.body ?? {});
    const expectedRevision = revisionFromIfMatch(req.headers['if-match']);
    if (expectedRevision === null) {
      const message = 'The If-Match header with the revision of the app is required';
      throw new ServiceError('VALIDATION_FAILED', message, {
        details: [{ path: 'If-Match', code: 'REQUIRED', message }]
      });
    }
    const before = await loadRecord(req);
    const company = companyAppOf(before);
    if (effectiveUserAppState(before, { publishedAppExists: company.exists }) === 'promoted') {
      throw new ServiceError('CONFLICT', 'The app is published already', {
        details: { reason: 'promoted', appId: company.app.id }
      });
    }

    const { app: created, projected } = await promoteUserApp(before, {
      admin: req.user,
      expectedRevision,
      id: body.id,
      category: body.category
    });

    const name = userAppName(before);
    const ownerName = before.owner?.name || before.owner?.id || 'unknown';
    logAudit({
      req,
      action: 'share',
      resource: 'userAppShare',
      resourceId: before.id,
      summary: `Published personal app "${name}" as ${created.id}`,
      details: { appId: created.id, enabled: false, by: 'admin', ...auditStamp(before) }
    });
    logAudit({
      req,
      action: 'create',
      resource: 'app',
      resourceId: created.id,
      summary: `Took over personal app "${name}" of ${ownerName} as ${created.id}`,
      details: { ...publishedAppAuditDetails(before, created, projected), ...auditStamp(before) }
    });
    sendCreated(res, `/api/admin/apps/${segment(created.id)}`, created);
  });

  /**
   * @swagger
   * /api/admin/user-apps/{appId}/_release:
   *   post:
   *     summary: Give a published personal app back to its owner
   *     description: |
   *       For full admins. The personal app is editable again; the company
   *       app stays. Refused while the company app is visible to users:
   *       unpublish or delete that app first. An app that is not published is
   *       answered as it is. Takes no body.
   *     tags: [Admin Personal Apps]
   *     parameters:
   *       - in: path
   *         name: appId
   *         required: true
   *         schema: { type: string }
   *     responses:
   *       200: { description: 'The admin view of the app; `ETag` is set' }
   *       403: { description: Not a full admin }
   *       404: { description: No personal app has this ID (`NOT_FOUND`) }
   *       409: { description: 'The company app is visible (`CONFLICT` with `details.reason` `published`)' }
   *       503: { description: The store cannot hold personal apps (`USER_APPS_UNAVAILABLE`) }
   */
  app.post(route('/:appId/_release'), adminAuth, async (req, res) => {
    const before = await loadRecord(req);
    const { record, released, appId } = await releaseUserApp(before);
    if (released) {
      logAudit({
        req,
        action: 'update',
        resource: 'userApp',
        resourceId: record.id,
        summary: `Released personal app "${userAppName(record)}" from ${appId}`,
        details: {
          released: true,
          appId,
          ownerId: record.owner?.id ?? null,
          by: req.user?.id ?? null,
          ...auditStamp(record)
        }
      });
    }
    const settings = currentUserAppSettings();
    const company = companyAppOf(record);
    const extras = await adminUserAppViewExtras({ record, user: req.user, settings }).catch(
      () => ({})
    );
    res.setHeader('ETag', userAppEtag(record));
    res.setHeader('Cache-Control', 'no-store');
    res.json(
      adminUserAppView(record, {
        owner: lookupUserAppOwner(record, { settings }),
        clash: isConfigAppId(record.id),
        publishedAppExists: record.state === 'promoted' ? company.exists : true,
        publishedAppEnabled: company.app ? company.app.enabled !== false : null,
        ...extras
      })
    );
  });
}
