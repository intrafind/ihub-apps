// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * The admin API of personal apps — `/api/admin/user-apps`.
 *
 * Full admins list every personal app, read one with its content and its
 * earlier content states, switch one off and on, delete one, and edit the
 * block `platform.userApps`. An admin never edits a personal app here.
 *
 * Every route works with the feature `userApps` off, so an admin can set
 * everything up first. The path is outside `/api/admin/apps/`, so it shadows
 * no app ID.
 *
 * The routes that make a company app from a personal app (`_waiting`,
 * `_promote`, `_release`) are in `routes/admin/userAppPublish.js`. That module
 * adds its two fields to the admin view through
 * {@link registerAdminUserAppViewExtension}.
 *
 * Design: concepts/app-builder-rework-2026-11/02-personal-apps.md, sections
 * 8.4, 9.2 and 10.
 *
 * @module routes/admin/userApps
 */
import { z } from 'zod';
import configCache from '../../configCache.js';
import { adminAuth } from '../../middleware/adminAuth.js';
import { buildServerPath } from '../../utils/basePath.js';
import logger from '../../utils/logger.js';
import { updatePlatform } from '../../utils/platformConfigStore.js';
import { findByIdCaseInsensitive } from '../../utils/resourceLookup.js';
import { ServiceError } from '../../utils/ServiceError.js';
import { logAudit } from '../../services/AuditLogService.js';
import { membersWithoutCompanyApp } from '../../services/userApps/publishUserApp.js';
import { getUserAppRepository } from '../../services/userApps/UserAppRepository.js';
import { lookupUserAppOwner } from '../../services/userApps/userAppAccess.js';
import { isConfigAppId, userAppStanding } from '../../services/userApps/userAppResolution.js';
import {
  changedUserAppSettingKeys,
  currentUserAppSettings,
  mergeUserAppSettings,
  userAppSettings
} from '../../services/userApps/userAppSettings.js';
import {
  adminUserAppListItem,
  adminUserAppView,
  userAppEtag,
  userAppRevisionView
} from '../../services/userApps/userAppView.js';
import { stripHiddenCharacters, userAppSettingsSchema } from '../../validators/userAppSchema.js';
import { USER_APP_STATES, isUserAppId } from '../../../shared/userAppContent.js';

const COMPONENT = 'AdminUserApps';

/** The audit resource ID of a settings change (design 3.1 and 10). */
const USER_APP_SETTINGS_AUDIT_ID = 'user-apps';

/** Most apps one page of the list holds. */
const MAX_LIST_LIMIT = 200;

/** `true` or `false` in a query string. */
const queryFlag = z.enum(['true', 'false']).transform(value => value === 'true');

/**
 * The query of `GET /api/admin/user-apps`. Unknown parameters are refused, so
 * a misspelt filter does not silently list everything.
 */
const listQuerySchema = z
  .object({
    q: z.string().trim().max(200),
    ownerId: z.string().trim().min(1).max(200),
    state: z.enum(USER_APP_STATES),
    waiting: queryFlag,
    everyone: queryFlag,
    ownerActive: queryFlag,
    ownerStale: queryFlag,
    clash: queryFlag,
    limit: z.coerce.number().int().min(1).max(MAX_LIST_LIMIT),
    cursor: z.string().min(1).max(2000)
  })
  .partial()
  .strict();

/** The body of `POST …/{appId}/_disable`. The reason is shown to the owner and the members. */
const disableBodySchema = z
  .object({
    reason: z
      .string()
      .max(500)
      .transform(text => stripHiddenCharacters(text).trim())
      .optional()
  })
  .strict();

/** What `routes/admin/userAppPublish.js` adds to the admin view of one app. */
let adminViewExtension = null;

/**
 * Let the publish module add its two fields to the admin view of one app:
 * `membersWithoutCompanyApp` (for a promoted app, how many members cannot use
 * the company app) and `takeOverPreview` (what a take-over would write).
 * One extension; a later call replaces it, and `null` removes it.
 *
 * @param {((context: {record: Object, user: Object, settings: Object, owner: Object}) =>
 *   Promise<{membersWithoutCompanyApp?: number, takeOverPreview?: Object}|null|undefined>|
 *   {membersWithoutCompanyApp?: number, takeOverPreview?: Object}|null|undefined)|null} extension
 *
 * @example
 * registerAdminUserAppViewExtension(async ({ record, user }) => ({
 *   takeOverPreview: await takeOverPreviewOf(record, user)
 * }));
 */
export function registerAdminUserAppViewExtension(extension) {
  adminViewExtension = typeof extension === 'function' ? extension : null;
}

async function viewExtras(context) {
  if (!adminViewExtension) return {};
  try {
    const extras = (await adminViewExtension(context)) || {};
    return {
      ...(extras.membersWithoutCompanyApp !== undefined
        ? { membersWithoutCompanyApp: extras.membersWithoutCompanyApp }
        : {}),
      ...(extras.takeOverPreview ? { takeOverPreview: extras.takeOverPreview } : {})
    };
  } catch (error) {
    // The app stays readable without the two fields.
    logger.warn('Could not add the publish fields to the admin view of a personal app', {
      component: COMPONENT,
      appId: context.record?.id,
      error: error.message
    });
    return {};
  }
}

/**
 * What the admin views need beyond the record: the owner lookup, whether a
 * config app has the same ID, and the company app of a promoted app. Reads
 * the configuration and `users.json`, no store.
 */
function adminContext(record, settings) {
  const publishedId = record.state === 'promoted' ? record.publishedAs?.appId : null;
  const company = publishedId
    ? findByIdCaseInsensitive(configCache.getApps(true)?.data || [], publishedId) || null
    : null;
  return {
    owner: lookupUserAppOwner(record, { settings }),
    clash: isConfigAppId(record.id),
    publishedAppExists: publishedId ? Boolean(company) : true,
    publishedAppEnabled: company ? company.enabled !== false : null,
    // For a published app: how many of the people it is shared with by name cannot use the
    // company app, so an admin sees whom to grant it to.
    ...(company ? { membersWithoutCompanyApp: membersWithoutCompanyApp(record) } : {})
  };
}

/** Every text an admin may search an app by, in lower case. */
function searchText(record) {
  const name = record.content?.name;
  const names = typeof name === 'string' ? [name] : Object.values(name || {});
  return [record.id, record.owner?.id, record.owner?.name, ...names]
    .filter(value => typeof value === 'string' || typeof value === 'number')
    .join('\n')
    .toLowerCase();
}

/**
 * The filter of the list as one function of a stored record. The owner
 * lookup runs only when a filter asks about the owner.
 */
function listFilter(query, settings) {
  const needle = query.q ? query.q.toLowerCase() : '';
  return record => {
    if (query.ownerId !== undefined && String(record.owner?.id ?? '') !== query.ownerId) {
      return false;
    }
    if (needle && !searchText(record).includes(needle)) return false;
    if (query.everyone !== undefined) {
      const everyone = (record.members || []).some(member => member.type === 'everyone');
      if (everyone !== query.everyone) return false;
    }
    if (query.clash !== undefined && isConfigAppId(record.id) !== query.clash) return false;
    if (
      query.state === undefined &&
      query.waiting === undefined &&
      query.ownerActive === undefined &&
      query.ownerStale === undefined
    ) {
      return true;
    }
    const item = adminUserAppListItem(record, adminContext(record, settings));
    if (query.state !== undefined && item.state !== query.state) return false;
    if (query.waiting !== undefined) {
      // Published, and the company app is there and not switched on.
      const waiting = item.state === 'promoted' && item.publishedAs?.enabled === false;
      if (waiting !== query.waiting) return false;
    }
    if (query.ownerActive !== undefined && item.owner.active !== query.ownerActive) return false;
    if (query.ownerStale !== undefined && item.owner.stale !== query.ownerStale) return false;
    return true;
  };
}

/** The repository, or 503 while the store cannot hold personal apps. */
function availableRepository() {
  const repo = getUserAppRepository();
  if (!repo.isAvailable()) {
    throw new ServiceError('USER_APPS_UNAVAILABLE', 'Personal apps cannot be stored at the moment');
  }
  return repo;
}

const notFound = () => new ServiceError('NOT_FOUND', 'App not found');

/** The name of an app in its own language, for a summary. */
function nameOf(record) {
  const name = record.content?.name;
  if (typeof name === 'string') return name;
  return (
    name?.[record.language] || Object.values(name || {}).find(text => typeof text === 'string')
  );
}

/** What every audit entry about a personal app carries (design 10). */
function auditDetails(record, extra = {}) {
  return {
    revision: Number(record.revision) || 1,
    contentHash: record.contentHash || null,
    ownerId: record.owner?.id ?? null,
    ...extra
  };
}

const ownerLabel = record => record.owner?.name || record.owner?.id || 'unknown';

/**
 * Register the `/api/admin/user-apps` endpoints of slice P5.
 *
 * @param {import('express').Application} app
 */
export default function registerAdminUserAppRoutes(app) {
  const route = suffix => buildServerPath(`/api/admin/user-apps${suffix}`);

  /**
   * An `{appId}` segment that starts with `_` is an action on the collection.
   * This module has `_settings` only; any other one is left to the module
   * that owns it (`_waiting` of `userAppPublish.js`), whichever is registered
   * first.
   */
  const personalIdOnly = (req, res, next) => {
    const { appId } = req.params;
    if (typeof appId === 'string' && appId.startsWith('_')) return next('route');
    if (!isUserAppId(appId)) throw notFound();
    return next();
  };

  async function loadRecord(req) {
    const record = await availableRepository().get(req.params.appId);
    if (!record) throw notFound();
    return record;
  }

  async function sendAdminView(req, res, record) {
    const settings = currentUserAppSettings();
    const context = adminContext(record, settings);
    const extras = await viewExtras({ record, user: req.user, settings, owner: context.owner });
    res.setHeader('ETag', userAppEtag(record));
    res.setHeader('Cache-Control', 'no-store');
    res.json(adminUserAppView(record, { ...context, ...extras }));
  }

  /**
   * A read by an admin who is neither the owner nor a member is recorded:
   * nothing else would show that someone read instructions that were not
   * shared with them.
   */
  function auditForeignRead(req, record, what) {
    const { permissions } = userAppStanding(record, req.user);
    if (permissions.role !== 'admin') return;
    logAudit({
      req,
      action: 'read',
      resource: 'userApp',
      resourceId: record.id,
      summary: `Read ${what} of personal app "${nameOf(record) || record.id}" of ${ownerLabel(record)}`,
      details: auditDetails(record, { what })
    });
  }

  /**
   * @swagger
   * /api/admin/user-apps:
   *   get:
   *     summary: List every personal app
   *     description: |
   *       Walks the store with a cursor. Filters: `q` (name, owner or ID),
   *       `ownerId`, `state` (`active` or `promoted`), and the flags
   *       `waiting` (published and the company app is not switched on),
   *       `everyone` (shared with everyone signed in), `ownerActive`,
   *       `ownerStale` (the stored rights of the owner are too old) and
   *       `clash` (an app file has the same ID), each `true` or `false`.
   *       An unknown parameter answers 400. A page can hold fewer items than
   *       `limit` and still carry a `nextCursor`. No item contains the
   *       instructions. Full admins only; works with the feature off.
   *     tags: [Admin Personal Apps]
   *     parameters:
   *       - { in: query, name: q, schema: { type: string } }
   *       - { in: query, name: ownerId, schema: { type: string } }
   *       - { in: query, name: state, schema: { type: string, enum: [active, promoted] } }
   *       - { in: query, name: waiting, schema: { type: string, enum: ['true', 'false'] } }
   *       - { in: query, name: everyone, schema: { type: string, enum: ['true', 'false'] } }
   *       - { in: query, name: ownerActive, schema: { type: string, enum: ['true', 'false'] } }
   *       - { in: query, name: ownerStale, schema: { type: string, enum: ['true', 'false'] } }
   *       - { in: query, name: clash, schema: { type: string, enum: ['true', 'false'] } }
   *       - { in: query, name: limit, schema: { type: integer, minimum: 1, maximum: 200, default: 50 } }
   *       - { in: query, name: cursor, schema: { type: string } }
   *     responses:
   *       200: { description: '`{ items, nextCursor }`' }
   *       400: { description: Unknown parameter, bad value or a cursor the store did not issue }
   *       403: { description: Not a full admin }
   *       503: { description: The store cannot hold personal apps }
   */
  app.get(route(''), adminAuth, async (req, res) => {
    const query = listQuerySchema.parse(req.query || {});
    const settings = currentUserAppSettings();
    const { items, nextCursor } = await availableRepository().scan({
      filter: listFilter(query, settings),
      limit: query.limit ?? 50,
      cursor: query.cursor ?? null
    });
    res.setHeader('Cache-Control', 'no-store');
    res.json({
      items: items.map(record => adminUserAppListItem(record, adminContext(record, settings))),
      nextCursor
    });
  });

  /**
   * @swagger
   * /api/admin/user-apps/_settings:
   *   get:
   *     summary: The settings of personal apps
   *     description: |
   *       The effective block `platform.userApps`, every key present:
   *       `limits` (`maxAppsPerUser`, 0 for no limit; `maxOpenOffersPerUser`;
   *       `ownerSnapshotMaxAgeDays`), `sharing` (`allowUsers`, `allowGroups`,
   *       `allowEveryone`, `allowPublish`), `capabilities` (`modelChoice`,
   *       `upload`, `webSearch`, `skills`, and `integrations`: the
   *       installations personal apps may bind, each with its named
   *       actions), `publishing.adminEnables` (`withTools` or `always`) and
   *       `blockedOwners` (user IDs whose apps are switched off). Full admins
   *       only; works with the feature off.
   *     tags: [Admin Personal Apps]
   *     responses:
   *       200: { description: The settings block }
   *       403: { description: Not a full admin }
   *   put:
   *     summary: Change the settings of personal apps
   *     description: |
   *       Only the keys sent are written, key by key inside `limits`,
   *       `sharing`, `capabilities` and `publishing`; the lists
   *       `capabilities.integrations` and `blockedOwners` are replaced as a
   *       whole. An unknown key, the installation `ihub` and an installation
   *       without named actions are refused. A change applies at once,
   *       without a restart.
   *     tags: [Admin Personal Apps]
   *     responses:
   *       200: { description: The settings block after the change }
   *       400: { description: Validation failed }
   *       403: { description: Not a full admin }
   */
  app.get(route('/_settings'), adminAuth, (req, res) => {
    res.json(currentUserAppSettings());
  });

  app.put(route('/_settings'), adminAuth, async (req, res) => {
    const body = userAppSettingsSchema.parse(req.body ?? {});
    let blockedBefore = [];
    // Changed on the body as stored right now: another admin's save of a
    // different setting is not overwritten.
    const { data: platformConfig } = await updatePlatform(current => {
      if (!current || typeof current !== 'object') {
        throw new Error('Unable to read config/platform.json');
      }
      blockedBefore = userAppSettings(current).blockedOwners;
      return { ...current, userApps: mergeUserAppSettings(current.userApps, body) };
    });
    await configCache.refreshCacheEntry('config/platform.json');
    const settings = userAppSettings(configCache.getPlatform() || platformConfig);

    const keys = changedUserAppSettingKeys(body);
    const blocked = body.blockedOwners
      ? settings.blockedOwners.filter(id => !blockedBefore.includes(id))
      : [];
    const unblocked = body.blockedOwners
      ? blockedBefore.filter(id => !settings.blockedOwners.includes(id))
      : [];
    logAudit({
      req,
      action: 'update',
      resource: 'platform',
      resourceId: USER_APP_SETTINGS_AUDIT_ID,
      summary:
        `Updated personal app settings (${keys.join(', ') || 'no change'})` +
        (blocked.length > 0 ? `; switched off the apps of ${blocked.join(', ')}` : '') +
        (unblocked.length > 0 ? `; switched the apps of ${unblocked.join(', ')} on again` : ''),
      details: { keys, blockedOwners: { added: blocked, removed: unblocked } }
    });
    res.json(settings);
  });

  /**
   * @swagger
   * /api/admin/user-apps/{appId}:
   *   get:
   *     summary: Read one personal app
   *     description: |
   *       The admin view: the list item plus `content`, `members`,
   *       `language`, `origin` and `revision`, and for a take-over
   *       `takeOverPreview`. It never contains the owner's e-mail address or
   *       groups. A read by an admin who is neither the owner nor a member
   *       writes an audit entry. Sends `ETag`. Full admins only.
   *     tags: [Admin Personal Apps]
   *     responses:
   *       200: { description: The admin view }
   *       403: { description: Not a full admin }
   *       404: { description: No personal app has this ID }
   *       503: { description: The store cannot hold personal apps }
   *   delete:
   *     summary: Delete a personal app
   *     description: |
   *       Removes the record and its markers. The newest content state is
   *       kept for 90 days. A company app that was published from it is not
   *       touched. Full admins only.
   *     tags: [Admin Personal Apps]
   *     responses:
   *       204: { description: Deleted }
   *       403: { description: Not a full admin }
   *       404: { description: No personal app has this ID }
   *       503: { description: The store cannot hold personal apps }
   */
  app.get(route('/:appId'), adminAuth, personalIdOnly, async (req, res) => {
    const record = await loadRecord(req);
    auditForeignRead(req, record, 'the content');
    await sendAdminView(req, res, record);
  });

  app.delete(route('/:appId'), adminAuth, personalIdOnly, async (req, res) => {
    const removed = await availableRepository().delete(req.params.appId);
    if (!removed) throw notFound();
    logAudit({
      req,
      action: 'delete',
      resource: 'userApp',
      resourceId: removed.id,
      summary: `Deleted personal app "${nameOf(removed) || removed.id}" of ${ownerLabel(removed)}`,
      details: auditDetails(removed, { by: 'admin' })
    });
    res.status(204).end();
  });

  /**
   * @swagger
   * /api/admin/user-apps/{appId}/revisions:
   *   get:
   *     summary: The earlier content states of a personal app
   *     description: |
   *       The last 20 content states, each with its revision, its content
   *       hash, when it was saved and by whom. A read by an admin who is
   *       neither the owner nor a member writes an audit entry. Full admins
   *       only.
   *     tags: [Admin Personal Apps]
   *     responses:
   *       200: { description: '`{ items, nextCursor: null }`' }
   *       403: { description: Not a full admin }
   *       404: { description: No personal app has this ID }
   *       503: { description: The store cannot hold personal apps }
   */
  app.get(route('/:appId/revisions'), adminAuth, personalIdOnly, async (req, res) => {
    const record = await loadRecord(req);
    const states = await availableRepository().listRevisions(record.id);
    auditForeignRead(req, record, 'the earlier versions');
    res.setHeader('Cache-Control', 'no-store');
    res.json({
      items: [...states]
        .sort((a, b) => (Number(b.revision) || 0) - (Number(a.revision) || 0))
        .map(state => userAppRevisionView(state)),
      nextCursor: null
    });
  });

  /**
   * @swagger
   * /api/admin/user-apps/{appId}/_disable:
   *   post:
   *     summary: Switch a personal app off
   *     description: |
   *       Nobody but a full admin can chat with the app afterwards, and
   *       nobody can change or duplicate it. The owner and the members see
   *       the optional `reason`. Calling it again replaces the reason. Full
   *       admins only.
   *     tags: [Admin Personal Apps]
   *     requestBody:
   *       content:
   *         application/json:
   *           schema:
   *             type: object
   *             additionalProperties: false
   *             properties:
   *               reason: { type: string, maxLength: 500 }
   *     responses:
   *       200: { description: The admin view }
   *       400: { description: Validation failed }
   *       403: { description: Not a full admin }
   *       404: { description: No personal app has this ID }
   *       503: { description: The store cannot hold personal apps }
   */
  app.post(route('/:appId/_disable'), adminAuth, personalIdOnly, async (req, res) => {
    const { reason } = disableBodySchema.parse(req.body ?? {});
    const disabled = {
      at: new Date().toISOString(),
      by: { id: String(req.user.id), name: String(req.user.name || req.user.id) },
      reason: reason || null
    };
    const record = await availableRepository().mutate(req.params.appId, current => ({
      ...current,
      // The moment an app was switched off stays when only the reason changes.
      disabled: current.disabled
        ? { ...disabled, at: current.disabled.at || disabled.at }
        : disabled
    }));
    if (!record) throw notFound();
    logAudit({
      req,
      action: 'toggle',
      resource: 'userApp',
      resourceId: record.id,
      summary:
        `Switched off personal app "${nameOf(record) || record.id}" of ${ownerLabel(record)}` +
        (reason ? `: ${reason}` : ''),
      details: auditDetails(record, { disabled: true, reason: reason || null })
    });
    await sendAdminView(req, res, record);
  });

  /**
   * @swagger
   * /api/admin/user-apps/{appId}/_enable:
   *   post:
   *     summary: Switch a personal app on again
   *     description: Undoes `_disable`. An app that is not switched off is answered unchanged. Full admins only.
   *     tags: [Admin Personal Apps]
   *     responses:
   *       200: { description: The admin view }
   *       403: { description: Not a full admin }
   *       404: { description: No personal app has this ID }
   *       503: { description: The store cannot hold personal apps }
   */
  app.post(route('/:appId/_enable'), adminAuth, personalIdOnly, async (req, res) => {
    let wasDisabled = false;
    const record = await availableRepository().mutate(req.params.appId, current => {
      wasDisabled = Boolean(current.disabled);
      return wasDisabled ? { ...current, disabled: null } : null;
    });
    if (!record) throw notFound();
    if (wasDisabled) {
      logAudit({
        req,
        action: 'toggle',
        resource: 'userApp',
        resourceId: record.id,
        summary: `Switched on personal app "${nameOf(record) || record.id}" of ${ownerLabel(record)}`,
        details: auditDetails(record, { disabled: false })
      });
    }
    await sendAdminView(req, res, record);
  });
}
