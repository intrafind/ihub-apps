// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * The user routes of personal apps (feature `userApps`): what a signed-in
 * user does with apps of their own under `/api/apps`.
 *
 * Registered before `registerGeneralRoutes`, so the `_`-segments are matched
 * before `GET /api/apps/:appId`. Reading an app and listing apps
 * (`GET /api/apps/:appId`, `GET /api/apps?scope=`) stay in
 * `routes/generalRoutes.js`.
 *
 * Every route needs a signed-in user and the feature; the first failing check
 * wins: 401 `AUTH_REQUIRED`, 403 `USER_APPS_DISABLED`, for a sign-in that
 * cannot hold personal apps 403 `PERMISSION_DENIED` on the routes without an
 * app ID and the 404 of an unknown ID on the routes of one app (design 14.2),
 * 503 `USER_APPS_UNAVAILABLE`.
 * `GET /api/apps/_config` is the exception: it answers with the feature off
 * and says so (`enabled: false`).
 *
 * Design: concepts/app-builder-rework-2026-11/02-personal-apps.md, sections
 * 8.1, 8.3, 9.1 and 10.
 *
 * @module routes/userAppRoutes
 */
import configCache from '../configCache.js';
import { requireFeature } from '../featureRegistry.js';
import { authenticatedOnly } from '../middleware/authRequired.js';
import { appGeneratorLimiter } from '../middleware/rateLimiting.js';
import { userAppAccessRequired } from '../middleware/userAppAccess.js';
import { generateAppDraft } from '../services/appGenerator.js';
import { loadAppTemplates } from '../services/appTemplates.js';
import { logAudit } from '../services/AuditLogService.js';
import { isLLMError } from '../services/loop/contracts/errors.js';
import { getUserAppRepository } from '../services/userApps/UserAppRepository.js';
import {
  assertChangeable,
  getUserAppService,
  requestedCapabilityIds
} from '../services/userApps/UserAppService.js';
import {
  canHoldUserApps,
  mayShareUserApps,
  satisfiesUserAppLevel
} from '../services/userApps/userAppAccess.js';
import { userAppResponse } from '../services/userApps/userAppResolution.js';
import {
  currentUserAppSettings,
  isUserAppsEnabled,
  logUserAppWarnings
} from '../services/userApps/userAppSettings.js';
import { revisionFromIfMatch } from '../services/userApps/userAppView.js';
import { enhanceUserWithPermissions, isAnonymousAccessAllowed } from '../utils/authorization.js';
import { buildServerPath } from '../utils/basePath.js';
import { segment } from '../utils/created.js';
import { getLocalizedString } from '../utils/localize.js';
import { ServiceError } from '../utils/ServiceError.js';
import { LANGUAGE_CODE_PATTERN } from '../../shared/validationPatterns.js';
import { parseDraftRequest } from './admin/appBuilder.js';
import registerUserAppPublishRoutes from './userAppPublishRoutes.js';

/** The feature that switches drafting with AI on and off (Admin → Features). */
const GENERATOR_FEATURE = 'appGenerator';

/**
 * ---------------------------------------------------------------------------
 * P12 REGISTRATION POINT (publish)
 * ---------------------------------------------------------------------------
 * `POST /api/apps/:appId/_publish` lives in `server/routes/userAppPublishRoutes.js`
 * (slice P12). To switch it off, replace the register function by `null`.
 *
 * It is called as `PUBLISH_ROUTES(app, { gate, sendApp, auditStamp, service })`
 * before the other `:appId` routes: `gate` is the middleware list every route
 * of one app starts with (signed in, feature on, store available; the 404 of
 * an unknown ID for a sign-in that cannot hold personal apps), `sendApp(res,
 * record, user)` answers with the app and its `ETag`, `auditStamp(record)` is
 * the `{ revision, contentHash }` every audit entry carries.
 *
 * While it is `null`, `GET /api/apps/_config` reports `canPublish: false`.
 *
 * @type {((app: import('express').Express, tools: Object) => void)|null}
 */
const PUBLISH_ROUTES = registerUserAppPublishRoutes;

/** A principal with resolved permissions, as the data routes build it. */
function ensurePrincipal(req, _res, next) {
  const platform = configCache.getPlatform() || {};
  const authConfig = platform.auth || {};
  if (req.user && !req.user.permissions) {
    req.user = enhanceUserWithPermissions(req.user, authConfig, platform);
  }
  if (!req.user && isAnonymousAccessAllowed(platform)) {
    req.user = enhanceUserWithPermissions(null, authConfig, platform);
  }
  next();
}

/**
 * The feature is on, the sign-in can hold personal apps, the store answers.
 *
 * A sign-in that cannot hold personal apps (an OAuth client, an agent, a
 * user-delegated token) gets 403 `PERMISSION_DENIED` on the routes without an
 * app ID. On the routes of one app it gets the 404 of an unknown ID (design
 * 14.2): to such a principal no personal app exists.
 *
 * @param {Object} [options]
 * @param {boolean} [options.perApp=false] - The route names one app (`:appId`).
 * @returns {import('express').RequestHandler}
 */
function userAppsAvailable({ perApp = false } = {}) {
  return function userAppsAvailableGate(req, _res, next) {
    if (!isUserAppsEnabled()) {
      throw new ServiceError('USER_APPS_DISABLED', 'Personal apps are switched off');
    }
    if (!canHoldUserApps(req.user)) {
      if (perApp) throw new ServiceError('NOT_FOUND', 'App not found');
      throw new ServiceError('PERMISSION_DENIED', 'This sign-in cannot hold personal apps', {
        status: 403,
        details: { required: 'userApps' }
      });
    }
    if (!getUserAppRepository().isAvailable()) {
      throw new ServiceError('USER_APPS_UNAVAILABLE', 'Personal apps are unavailable');
    }
    next();
  };
}

/** `{ revision, contentHash }`: what ties an audit entry to a content state. */
export function auditStamp(record) {
  return { revision: Number(record?.revision) || 1, contentHash: record?.contentHash || null };
}

/** The name of an app for an audit summary: its text in the content language. */
function appName(record) {
  const name = record?.content?.name;
  return getLocalizedString(name, record?.language || 'en', 'en', record?.id || '') || record?.id;
}

/**
 * Answer with a personal app as the caller may read it, and its `ETag`.
 *
 * @param {import('express').Response} res
 * @param {Object} record - Stored personal app.
 * @param {Object} user - `req.user`.
 * @param {number} [status=200]
 * @returns {Promise<void>}
 */
export async function sendUserApp(res, record, user, status = 200) {
  const { body, etag } = await userAppResponse(record, user);
  res.setHeader('ETag', etag);
  res.setHeader('Cache-Control', 'no-store');
  res.status(status).json(body);
}

/** The revision of an optional `If-Match`; null when the header is absent. */
function optionalRevision(req) {
  return revisionFromIfMatch(req.headers['if-match']);
}

/** The revision of a required `If-Match`. A missing header answers 400. */
function requiredRevision(req) {
  const revision = revisionFromIfMatch(req.headers['if-match']);
  if (revision === null) {
    const message = 'The If-Match header with the revision of the app is required';
    throw new ServiceError('VALIDATION_FAILED', message, {
      details: [{ path: 'If-Match', code: 'REQUIRED', message }]
    });
  }
  return revision;
}

/**
 * Require an access level on the app the gate loaded. An owner or editor
 * (for `offer`: the owner or a full admin) who is stopped only by the state
 * of the app gets 409 `CONFLICT` with `details.reason` `promoted` or
 * `disabled`; everyone else 403 `PERMISSION_DENIED` with `details.required`.
 *
 * @param {import('express').Request} req - After `userAppAccessRequired('view')`.
 * @param {'edit'|'share'|'offer'|'use'} level
 * @throws {ServiceError}
 */
function requireLevel(req, level) {
  const permissions = req.userAppPermissions;
  if (satisfiesUserAppLevel(permissions, level)) return;
  const role = permissions.role;
  const holdsRole =
    level === 'offer'
      ? role === 'owner' || role === 'admin'
      : (level === 'edit' || level === 'share') && (role === 'owner' || role === 'editor');
  if (holdsRole) assertChangeable(req.userApp, req.userAppContext);
  const details = { required: level };
  if (level === 'share' && holdsRole) {
    // Sharing needs the permission of the caller and of the owner.
    details.required = 'userAppSharing';
    if (mayShareUserApps(req.user)) details.reason = 'ownerMayNotShare';
  } else if (permissions.suspended) {
    details.reason = permissions.suspended;
  }
  throw new ServiceError('PERMISSION_DENIED', 'You do not have the required access to this app', {
    status: 403,
    details
  });
}

/** The keys of an admin draft a personal app has no use for. */
const ADMIN_ONLY_DRAFT_KEYS = ['id', 'category', 'order', 'enabled'];

/**
 * The draft of a personal app: the admin draft without the keys only an
 * admin app has. Its `id` is a free admin app ID, picked against every app
 * file including unpublished ones, so it would tell a non-admin which IDs
 * exist; a personal app never uses it.
 *
 * @param {Object} draft - The result of `generateAppDraft`.
 * @returns {Object}
 */
export function personalDraft(draft) {
  if (!draft?.app || typeof draft.app !== 'object') return draft;
  const app = { ...draft.app };
  for (const key of ADMIN_ONLY_DRAFT_KEYS) delete app[key];
  return { ...draft, app };
}

/** The registry code an error of the draft route is answered with, for the audit entry. */
function codeOf(error) {
  if (error instanceof ServiceError || isLLMError(error)) return error.code || 'INTERNAL_ERROR';
  return 'INTERNAL_ERROR';
}

/**
 * Register the user routes of personal apps.
 *
 * @param {import('express').Express} app
 * @param {Object} [dependencies]
 * @param {{ complete: Function }} [dependencies.llmClient] - The model client of the draft.
 * @param {import('../services/userApps/UserAppService.js').UserAppService} [dependencies.service]
 *   The service; the process-wide one by default.
 */
export default function registerUserAppRoutes(app, { llmClient, service: injected } = {}) {
  // What an admin should know at start-up: a config app with a personal-shaped
  // ID, an app with the ID `new` while the feature is on. Never throws.
  logUserAppWarnings();

  const service = () => injected || getUserAppService();
  const route = suffix => buildServerPath(`/api/apps${suffix}`);
  const signedIn = [ensurePrincipal, authenticatedOnly];
  const gate = [...signedIn, userAppsAvailable()];
  // The gate of the routes of one app: the same, but the 404 of an unknown ID
  // for a sign-in that cannot hold personal apps.
  const appGate = [...signedIn, userAppsAvailable({ perApp: true })];
  const view = userAppAccessRequired('view');
  const mayCreate = (req, _res, next) => {
    service().assertMayCreate(req.user, currentUserAppSettings());
    next();
  };

  /**
   * @swagger
   * /api/apps/_config:
   *   get:
   *     summary: What the caller may do with personal apps
   *     description: |
   *       Answers with the feature off too (`enabled: false`), so a client can ask
   *       before it shows anything. `capabilities` lists what a personal app of the
   *       caller may use on this installation: what an administrator allowed for
   *       personal apps and the caller's groups grant. The server enforces the same
   *       on every save.
   *     tags: [Apps]
   *     security:
   *       - bearerAuth: []
   *     parameters:
   *       - in: query
   *         name: language
   *         schema: { type: string }
   *         description: Language of the labels of connected systems (default is the platform's)
   *     responses:
   *       200:
   *         description: The settings for this caller
   *         content:
   *           application/json:
   *             schema:
   *               type: object
   *               required: [userApps]
   *               properties:
   *                 userApps:
   *                   type: object
   *                   required: [enabled, canCreate, canShare, canPublish, maxApps, used, generator, capabilities]
   *                   properties:
   *                     enabled: { type: boolean }
   *                     canCreate: { type: boolean }
   *                     canShare: { type: boolean }
   *                     canPublish: { type: boolean }
   *                     maxApps: { type: integer, description: "Apps per user; 0 means no limit" }
   *                     used: { type: integer, description: "Apps the caller owns, published ones included" }
   *                     generator: { type: boolean, description: "Whether the caller can have a draft prepared with AI" }
   *                     capabilities:
   *                       type: object
   *                       properties:
   *                         modelChoice: { type: boolean }
   *                         upload: { type: boolean }
   *                         webSearch: { type: boolean }
   *                         skills: { type: boolean }
   *                         integrations:
   *                           type: array
   *                           items:
   *                             type: object
   *                             properties:
   *                               id: { type: string }
   *                               label: { type: string }
   *                               actions:
   *                                 type: array
   *                                 items:
   *                                   type: object
   *                                   properties:
   *                                     name: { type: string }
   *                                     description: { type: string }
   *       401:
   *         description: Not signed in (`AUTH_REQUIRED`)
   */
  app.get(route('/_config'), ...signedIn, async (req, res) => {
    const requested = req.query.language;
    const language =
      typeof requested === 'string' && LANGUAGE_CODE_PATTERN.test(requested)
        ? requested
        : configCache.getPlatform()?.defaultLanguage || 'en';
    res.setHeader('Cache-Control', 'no-store');
    res.json({
      userApps: await service().configFor(req.user, {
        language,
        publishAvailable: Boolean(PUBLISH_ROUTES)
      })
    });
  });

  /**
   * @swagger
   * /api/apps/_templates:
   *   get:
   *     summary: The templates a personal app can start from
   *     description: The items of `GET /api/admin/app-templates`, for callers who may create personal apps.
   *     tags: [Apps]
   *     security:
   *       - bearerAuth: []
   *     responses:
   *       200:
   *         description: The templates, in the order of the gallery
   *         content:
   *           application/json:
   *             schema:
   *               type: object
   *               required: [items, nextCursor]
   *               properties:
   *                 items: { type: array, items: { type: object } }
   *                 nextCursor: { type: string, nullable: true, description: "Always null; the list is complete" }
   *       401:
   *         description: Not signed in (`AUTH_REQUIRED`)
   *       403:
   *         description: Personal apps are switched off (`USER_APPS_DISABLED`), or the caller may not create them (`PERMISSION_DENIED`)
   *       503:
   *         description: Personal apps are unavailable (`USER_APPS_UNAVAILABLE`)
   */
  app.get(route('/_templates'), ...gate, mayCreate, async (req, res) => {
    res.json({ items: await loadAppTemplates(), nextCursor: null });
  });

  // --- the AI draft ---------------------------------------------------------

  // The draft limiter of the admin route, the same instance: both routes count
  // against one budget per user.
  const draftLimiter = appGeneratorLimiter(configCache.getPlatform() || {});

  /** Validates the body before the draft limit counts, so only real drafts are counted. */
  const readDraftRequest = (req, _res, next) => {
    req.appDraft = { request: parseDraftRequest(req.body), record: {} };
    next();
  };

  /** One audit entry per draft request, whatever its outcome; never the description or the answer. */
  const auditDraft = (req, result, extra = {}) => {
    const { request, record = {} } = req.appDraft || {};
    logAudit({
      req,
      action: 'execute',
      resource: 'userApp',
      resourceId: '',
      summary:
        result === 'success'
          ? 'Prepared the draft of a personal app with AI'
          : 'The draft of a personal app with AI failed',
      result,
      details: {
        purpose: 'app-generator',
        ...(record.modelId ? { modelId: record.modelId } : {}),
        ...(record.usage ? { usage: record.usage } : {}),
        ...(request ? { descriptionLength: request.description.length } : {}),
        ...(record.brief ? { brief: record.brief } : {}),
        ...extra
      }
    });
  };

  /**
   * @swagger
   * /api/apps/_generate:
   *   post:
   *     summary: Prepare the draft of a personal app from a description
   *     description: |
   *       Request and response of `POST /api/admin/apps/_generate`, for callers who
   *       may create personal apps. Nothing is stored. `suggestions` holds only what
   *       personal apps may use on this installation and the caller may use: web
   *       search when it is allowed and a search engine is available to the caller,
   *       and connected systems an administrator allowed, each with named actions
   *       from the allowed list. `app` carries no `id`, `category`, `order` or
   *       `enabled`: a personal app gets its ID from the server when it is created.
   *       Counts against the draft limit of the admin route (30 per user per hour;
   *       failed drafts count).
   *     tags: [Apps]
   *     security:
   *       - bearerAuth: []
   *     requestBody:
   *       required: true
   *       content:
   *         application/json:
   *           schema:
   *             type: object
   *             required: [description]
   *             properties:
   *               description: { type: string, minLength: 1, maxLength: 2000 }
   *               language: { type: string, pattern: '^[a-z]{2}(-[A-Z]{2})?$' }
   *     responses:
   *       200:
   *         description: The draft (`app`, `suggestions`, `warnings`, `model`, `brief`)
   *       400:
   *         description: The body is invalid (`VALIDATION_FAILED`), or the model refused the request
   *       401:
   *         description: Not signed in (`AUTH_REQUIRED`)
   *       403:
   *         description: Personal apps are switched off (`USER_APPS_DISABLED`), the caller may not create them (`PERMISSION_DENIED`), or drafting with AI is switched off (`FEATURE_DISABLED`)
   *       429:
   *         description: More than 30 drafts in an hour (`RATE_LIMITED` with `details.limiter` `appGenerator`), or the caller's usage limit is reached (`QUOTA_EXCEEDED`)
   *       502:
   *         description: The answer of the model cannot become a draft (`APP_GENERATOR_INVALID_ANSWER`), or the model call failed
   *       503:
   *         description: No chat model the caller may use (`APP_GENERATOR_NO_MODEL`), or personal apps are unavailable (`USER_APPS_UNAVAILABLE`)
   */
  app.post(
    route('/_generate'),
    ...gate,
    mayCreate,
    requireFeature(GENERATOR_FEATURE),
    readDraftRequest,
    draftLimiter,
    async (req, res) => {
      const { request, record } = req.appDraft;

      // "Cancel" and a client timeout close the request; the paid model call stops with it.
      const controller = new AbortController();
      const onClose = () => {
        if (!res.writableEnded) controller.abort();
      };
      res.on('close', onClose);
      if (res.destroyed || req.socket?.destroyed) controller.abort();

      try {
        const draft = await generateAppDraft({
          description: request.description,
          language: request.language,
          user: req.user,
          signal: controller.signal,
          record,
          personal: { settings: currentUserAppSettings() },
          ...(llmClient ? { llmClient } : {})
        });
        auditDraft(req, 'success');
        res.json(personalDraft(draft));
      } finally {
        res.off('close', onClose);
      }
    },
    // The failure entry: without it the audit safety net would record the request, and at
    // the `request` verbosity that includes the body, which is the author's description.
    (error, req, _res, next) => {
      if (req.appDraft && req.user?.id && req.user.id !== 'anonymous') {
        auditDraft(req, 'failure', { code: codeOf(error) });
      }
      next(error);
    }
  );

  /**
   * @swagger
   * /api/apps/_share-targets:
   *   get:
   *     summary: Users and groups a personal app can be shared with or offered to
   *     description: |
   *       Users are found from two characters on, at most ten, never the caller.
   *       Groups never include `anonymous`. With `purpose=share` (the default) the
   *       caller needs the permission to share, and the answer holds only the
   *       audiences the settings allow. With `purpose=offer` the caller owns an app
   *       or is an administrator, and the answer holds users only.
   *     tags: [Apps]
   *     security:
   *       - bearerAuth: []
   *     parameters:
   *       - in: query
   *         name: q
   *         schema: { type: string, maxLength: 100 }
   *       - in: query
   *         name: purpose
   *         schema: { type: string, enum: [share, offer], default: share }
   *     responses:
   *       200:
   *         description: The targets
   *         content:
   *           application/json:
   *             schema:
   *               type: object
   *               required: [users, groups, everyone, allowed]
   *               properties:
   *                 allowed:
   *                   type: object
   *                   description: The kinds of audience that can be picked
   *                   properties:
   *                     user: { type: boolean }
   *                     group: { type: boolean }
   *                     everyone: { type: boolean }
   *                 users:
   *                   type: array
   *                   items:
   *                     type: object
   *                     properties:
   *                       id: { type: string }
   *                       name: { type: string }
   *                       email: { type: string, nullable: true }
   *                 groups:
   *                   type: array
   *                   items:
   *                     type: object
   *                     properties:
   *                       id: { type: string }
   *                       name: { type: string }
   *                       description: { type: string }
   *                 everyone: { type: boolean, description: "Whether \"everyone signed in\" can be picked" }
   *       400:
   *         description: Unknown `purpose` (`VALIDATION_FAILED`)
   *       401:
   *         description: Not signed in (`AUTH_REQUIRED`)
   *       403:
   *         description: Personal apps are switched off (`USER_APPS_DISABLED`), or the caller may not share (`PERMISSION_DENIED`)
   */
  app.get(route('/_share-targets'), ...gate, async (req, res) => {
    const purpose = req.query.purpose === undefined ? 'share' : req.query.purpose;
    if (purpose !== 'share' && purpose !== 'offer') {
      const message = 'purpose must be "share" or "offer"';
      throw new ServiceError('VALIDATION_FAILED', message, {
        details: [{ path: 'purpose', code: 'INVALID', message }]
      });
    }
    res.setHeader('Cache-Control', 'no-store');
    res.json(
      await service().shareTargets(req.user, {
        q: typeof req.query.q === 'string' ? req.query.q : '',
        purpose
      })
    );
  });

  /**
   * @swagger
   * /api/apps:
   *   post:
   *     summary: Create a personal app
   *     description: |
   *       The content keys at the top level, plus `language` and `origin`. The app
   *       is owned by the caller and visible to nobody else until it is shared. A
   *       capability the caller may not use is refused, not dropped.
   *     tags: [Apps]
   *     security:
   *       - bearerAuth: []
   *     requestBody:
   *       required: true
   *       content:
   *         application/json:
   *           schema:
   *             type: object
   *             required: [name, description, system]
   *             properties:
   *               language: { type: string }
   *               origin: { type: string, enum: [blank, template, generated, copy] }
   *               name: { type: object, additionalProperties: { type: string } }
   *               description: { type: object, additionalProperties: { type: string } }
   *               system: { type: object, additionalProperties: { type: string } }
   *               icon: { type: string }
   *               color: { type: string }
   *               prompt: { type: object, additionalProperties: { type: string } }
   *               messagePlaceholder: { type: object, additionalProperties: { type: string } }
   *               variables: { type: array, items: { type: object } }
   *               starterPrompts: { type: array, items: { type: object } }
   *               preferredModel: { type: string, nullable: true }
   *               capabilities:
   *                 type: object
   *                 properties:
   *                   upload: { type: boolean }
   *                   webSearch: { type: boolean }
   *                   skills: { type: boolean }
   *                   integrations:
   *                     type: array
   *                     items:
   *                       type: object
   *                       required: [id, actions]
   *                       properties:
   *                         id: { type: string }
   *                         actions: { type: array, items: { type: string } }
   *     responses:
   *       201:
   *         description: The app; `Location` and `ETag` are set
   *       400:
   *         description: The body is invalid (`VALIDATION_FAILED`)
   *       401:
   *         description: Not signed in (`AUTH_REQUIRED`)
   *       403:
   *         description: Personal apps are switched off (`USER_APPS_DISABLED`), the caller may not create them (`PERMISSION_DENIED`), or the body asks for a capability the caller may not use (`USER_APP_CAPABILITY_DENIED`)
   *       409:
   *         description: The caller's limit of personal apps is reached (`QUOTA_USER_APPS`)
   *       503:
   *         description: Personal apps are unavailable (`USER_APPS_UNAVAILABLE`)
   */
  app.post(route(''), ...gate, async (req, res) => {
    const record = await service().create(req.user, req.body);
    logAudit({
      req,
      action: 'create',
      resource: 'userApp',
      resourceId: record.id,
      summary: `Created personal app "${appName(record)}"`,
      details: {
        origin: record.origin,
        capabilities: requestedCapabilityIds(record.content),
        ...auditStamp(record)
      }
    });
    res.setHeader('Location', buildServerPath(`/api/apps/${segment(record.id)}`));
    await sendUserApp(res, record, req.user, 201);
  });

  if (PUBLISH_ROUTES) {
    PUBLISH_ROUTES(app, { gate: appGate, sendApp: sendUserApp, auditStamp, service: service() });
  }

  /**
   * @swagger
   * /api/apps/{appId}:
   *   patch:
   *     summary: Save a personal app
   *     description: |
   *       A JSON Merge Patch over the content keys of `POST /api/apps`, sent as
   *       `application/json`: a key that is `null` is removed. The save
   *       check runs on the whole app, whatever the patch changes: an editor who
   *       may not use something the app uses can only take capabilities away.
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
   *         schema: { type: string }
   *         description: The `ETag` of the app the caller read; optional
   *     requestBody:
   *       required: true
   *       content:
   *         application/json:
   *           schema: { type: object }
   *     responses:
   *       200:
   *         description: The app; `ETag` is set
   *       400:
   *         description: The patch or the merged app is invalid (`VALIDATION_FAILED`)
   *       401:
   *         description: Not signed in (`AUTH_REQUIRED`)
   *       403:
   *         description: Not allowed to edit (`PERMISSION_DENIED`), a capability is not available (`USER_APP_CAPABILITY_DENIED`), access changed meanwhile (`USER_APP_ACCESS_CHANGED`), or personal apps are switched off (`USER_APPS_DISABLED`)
   *       404:
   *         description: No app the caller can see (`NOT_FOUND`)
   *       409:
   *         description: Changed by someone else (`ETAG_MISMATCH`), or the app is published or switched off (`CONFLICT` with `details.reason`)
   *   delete:
   *     summary: Delete a personal app
   *     description: For the owner. A published company app is not affected.
   *     tags: [Apps]
   *     security:
   *       - bearerAuth: []
   *     parameters:
   *       - in: path
   *         name: appId
   *         required: true
   *         schema: { type: string }
   *     responses:
   *       204:
   *         description: Deleted
   *       401:
   *         description: Not signed in (`AUTH_REQUIRED`)
   *       403:
   *         description: Not the owner (`PERMISSION_DENIED`), or personal apps are switched off (`USER_APPS_DISABLED`)
   *       404:
   *         description: No app the caller can see (`NOT_FOUND`)
   */
  app.patch(route('/:appId'), ...appGate, view, async (req, res) => {
    requireLevel(req, 'edit');
    const before = req.userApp;
    const { record, changedKeys, capabilitiesChanged } = await service().update(before, req.body, {
      user: req.user,
      context: req.userAppContext,
      expectedRevision: optionalRevision(req)
    });
    if (changedKeys.length > 0) {
      logAudit({
        req,
        action: 'update',
        resource: 'userApp',
        resourceId: record.id,
        summary: `Changed personal app "${appName(record)}": ${changedKeys.join(', ')}`,
        details: {
          changed: changedKeys,
          role: req.userAppPermissions.role,
          ...(capabilitiesChanged ? { capabilities: requestedCapabilityIds(record.content) } : {}),
          ...auditStamp(record)
        }
      });
    }
    await sendUserApp(res, record, req.user);
  });

  app.delete(route('/:appId'), ...appGate, userAppAccessRequired('own'), async (req, res) => {
    const removed = await service().remove(req.userApp, { context: req.userAppContext });
    logAudit({
      req,
      action: 'delete',
      resource: 'userApp',
      resourceId: removed.id,
      summary: `Deleted personal app "${appName(removed)}" of ${removed.owner?.name || removed.owner?.id}`,
      details: { ownerId: removed.owner?.id ?? null, ...auditStamp(removed) }
    });
    res.status(204).end();
  });

  /**
   * @swagger
   * /api/apps/{appId}/_duplicate:
   *   post:
   *     summary: Duplicate a personal app
   *     description: |
   *       A new app owned by the caller, with the content of this one and no
   *       members. A capability the caller may not use in an app of their own is
   *       left out of the copy. The owner may duplicate their app also when it is
   *       published and they use the company app; everyone else must be able to use it.
   *     tags: [Apps]
   *     security:
   *       - bearerAuth: []
   *     parameters:
   *       - in: path
   *         name: appId
   *         required: true
   *         schema: { type: string }
   *     responses:
   *       201:
   *         description: The new app; `Location` and `ETag` are set
   *       403:
   *         description: The caller may not use the app or may not create apps (`PERMISSION_DENIED`)
   *       404:
   *         description: No app the caller can see (`NOT_FOUND`)
   *       409:
   *         description: The app is switched off (`CONFLICT`, `details.reason` `disabled`), or the caller's limit is reached (`QUOTA_USER_APPS`)
   */
  app.post(route('/:appId/_duplicate'), ...appGate, view, async (req, res) => {
    // A duplicate of a switched-off app would undo the admin's decision in one click.
    if (req.userApp.disabled) assertChangeable({ disabled: req.userApp.disabled });
    // The owner may always copy their own instructions, also once the app is
    // published and retired for them (design 8.2). Everyone else needs `use`.
    if (!req.userAppPermissions.isOwner) requireLevel(req, 'use');
    const { record, dropped } = await service().duplicate(req.userApp, { user: req.user });
    logAudit({
      req,
      action: 'create',
      resource: 'userApp',
      resourceId: record.id,
      summary: `Created personal app "${appName(record)}" as a copy`,
      details: {
        origin: record.origin,
        copiedFrom: req.userApp.id,
        capabilities: requestedCapabilityIds(record.content),
        ...(dropped.length > 0 ? { dropped } : {}),
        ...auditStamp(record)
      }
    });
    res.setHeader('Location', buildServerPath(`/api/apps/${segment(record.id)}`));
    await sendUserApp(res, record, req.user, 201);
  });

  /**
   * @swagger
   * /api/apps/{appId}/members:
   *   put:
   *     summary: Replace the members of a personal app
   *     description: |
   *       For the owner and for "Can edit" members. The caller and the owner both
   *       need the permission to share. The list replaces the stored one and holds
   *       at most 100 entries.
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
   *         schema: { type: string }
   *     requestBody:
   *       required: true
   *       content:
   *         application/json:
   *           schema:
   *             type: object
   *             required: [members]
   *             properties:
   *               members:
   *                 type: array
   *                 maxItems: 100
   *                 items:
   *                   type: object
   *                   required: [type]
   *                   properties:
   *                     type: { type: string, enum: [user, group, everyone] }
   *                     id: { type: string, nullable: true }
   *                     role: { type: string, enum: [editor, user] }
   *     responses:
   *       200:
   *         description: The app; `ETag` is set
   *       400:
   *         description: The body is invalid (`VALIDATION_FAILED`), or a target is unknown (`SHARE_TARGET_INVALID`)
   *       403:
   *         description: The caller or the owner may not share (`PERMISSION_DENIED`), or the audience is not allowed (`SHARE_TARGET_NOT_ALLOWED`)
   *       404:
   *         description: No app the caller can see (`NOT_FOUND`)
   *       409:
   *         description: Changed by someone else (`ETAG_MISMATCH`), or the app is published or switched off (`CONFLICT`)
   */
  app.put(route('/:appId/members'), ...appGate, view, async (req, res) => {
    requireLevel(req, 'share');
    const result = await service().setMembers(req.userApp, req.body, {
      user: req.user,
      context: req.userAppContext,
      expectedRevision: optionalRevision(req)
    });
    const { record, added, removed, changed } = result;
    if (added.length || removed.length || changed.length) {
      const everyone = record.members.some(member => member.type === 'everyone');
      logAudit({
        req,
        action: 'share',
        resource: 'userAppShare',
        resourceId: record.id,
        summary:
          `Changed members of personal app "${appName(record)}": ` +
          `${added.length} added, ${removed.length} removed, ` +
          `${changed.length} role${changed.length === 1 ? '' : 's'} changed` +
          `${everyone ? ' (shared with everyone)' : ''}`,
        details: {
          added: added.length,
          removed: removed.length,
          changed: changed.length,
          everyone,
          ...auditStamp(record)
        }
      });
    }
    await sendUserApp(res, record, req.user);
  });

  /**
   * @swagger
   * /api/apps/{appId}/_leave:
   *   post:
   *     summary: Leave a personal app that was shared with the caller
   *     description: Removes the caller's own direct share.
   *     tags: [Apps]
   *     security:
   *       - bearerAuth: []
   *     parameters:
   *       - in: path
   *         name: appId
   *         required: true
   *         schema: { type: string }
   *     responses:
   *       204:
   *         description: The share is removed
   *       404:
   *         description: No app the caller can see (`NOT_FOUND`)
   *       409:
   *         description: The caller is the owner, or has access only through a group (`CONFLICT`, `details.reason` `owner` or `noDirectShare`)
   */
  app.post(route('/:appId/_leave'), ...appGate, view, async (req, res) => {
    const record = await service().leave(req.userApp, { user: req.user });
    logAudit({
      req,
      action: 'share',
      resource: 'userAppShare',
      resourceId: record.id,
      summary: `A member left personal app "${appName(record)}": 0 added, 1 removed, 0 roles changed`,
      details: { added: 0, removed: 1, changed: 0, left: true, ...auditStamp(record) }
    });
    res.status(204).end();
  });

  /**
   * @swagger
   * /api/apps/{appId}/owner-offer:
   *   put:
   *     summary: Offer a personal app to a new owner
   *     description: |
   *       For the owner and for administrators. The app keeps its owner until the
   *       receiver accepts; a second call replaces the offer. An offer lapses after
   *       30 days.
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
   *         schema: { type: string }
   *     requestBody:
   *       required: true
   *       content:
   *         application/json:
   *           schema:
   *             type: object
   *             required: [ownerId]
   *             properties:
   *               ownerId: { type: string }
   *     responses:
   *       200:
   *         description: The app with `pendingOwner`; `ETag` is set
   *       400:
   *         description: The new owner is unknown, inactive or the current owner (`VALIDATION_FAILED`)
   *       403:
   *         description: Not the owner or an administrator (`PERMISSION_DENIED`)
   *       404:
   *         description: No app the caller can see (`NOT_FOUND`)
   *       409:
   *         description: Too many open offers (`QUOTA_USER_APP_OFFERS`), changed by someone else (`ETAG_MISMATCH`), or the app is published or switched off (`CONFLICT`)
   *   delete:
   *     summary: Withdraw or decline the offer of a personal app
   *     description: For the owner and administrators (withdraw) and the receiver (decline).
   *     tags: [Apps]
   *     security:
   *       - bearerAuth: []
   *     parameters:
   *       - in: path
   *         name: appId
   *         required: true
   *         schema: { type: string }
   *     responses:
   *       204:
   *         description: The offer is removed
   *       403:
   *         description: Not the owner, the receiver or an administrator (`PERMISSION_DENIED`)
   *       404:
   *         description: No app the caller can see, or the app is not offered (`NOT_FOUND`)
   */
  app.put(route('/:appId/owner-offer'), ...appGate, view, async (req, res) => {
    requireLevel(req, 'offer');
    const { record, replaced, lapsed } = await service().offer(req.userApp, req.body, {
      user: req.user,
      context: req.userAppContext,
      expectedRevision: optionalRevision(req)
    });
    const from = record.owner;
    const stamp = auditStamp(record);
    if (lapsed) {
      logAudit({
        req,
        action: 'update',
        resource: 'userAppShare',
        resourceId: record.id,
        summary: `The offer of personal app "${appName(record)}" to ${replaced.name || replaced.id} lapsed`,
        details: { offer: 'lapsed', from: from.id, to: replaced.id, by: req.user.id, ...stamp }
      });
    }
    logAudit({
      req,
      action: 'update',
      resource: 'userAppShare',
      resourceId: record.id,
      summary: `Offered personal app "${appName(record)}" of ${from.name || from.id} to ${record.pendingOwner.name || record.pendingOwner.id}`,
      details: {
        offer: 'made',
        from: from.id,
        to: record.pendingOwner.id,
        by: req.user.id,
        ...stamp
      }
    });
    await sendUserApp(res, record, req.user);
  });

  app.delete(route('/:appId/owner-offer'), ...appGate, view, async (req, res) => {
    const { record, offer, outcome } = await service().clearOffer(req.userApp, { user: req.user });
    logAudit({
      req,
      action: 'update',
      resource: 'userAppShare',
      resourceId: record.id,
      summary: `The offer of personal app "${appName(record)}" to ${offer.name || offer.id} was ${outcome === 'lapsed' ? 'removed after it lapsed' : outcome}`,
      details: {
        offer: outcome,
        from: record.owner.id,
        to: offer.id,
        by: req.user.id,
        ...auditStamp(record)
      }
    });
    res.status(204).end();
  });

  /**
   * @swagger
   * /api/apps/{appId}/owner-offer/_accept:
   *   post:
   *     summary: Accept the offer of a personal app
   *     description: |
   *       For the receiver. The caller becomes the owner; every "Can edit" member
   *       becomes "Can use", and the previous owner keeps no role. `If-Match` is
   *       required: the accept applies to the state the receiver read.
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
   *     responses:
   *       200:
   *         description: The app, owned by the caller; `ETag` is set
   *       400:
   *         description: The `If-Match` header is missing (`VALIDATION_FAILED`)
   *       403:
   *         description: The caller may not create personal apps (`PERMISSION_DENIED`, `details.required` `userApps`), or the owner is blocked or may not share, so the caller cannot read the instructions (`PERMISSION_DENIED`, `details.reason`)
   *       404:
   *         description: No open offer for the caller (`NOT_FOUND`)
   *       409:
   *         description: Changed since the caller read it (`ETAG_MISMATCH`), the caller's limit is reached (`QUOTA_USER_APPS`), or the app is published or switched off (`CONFLICT`)
   */
  app.post(
    route('/:appId/owner-offer/_accept'),
    ...appGate,
    async (req, res, next) => {
      // Before the app is looked up: a missing header says nothing about the app.
      requiredRevision(req);
      next();
    },
    view,
    async (req, res) => {
      const { record, previousOwner, downgraded } = await service().acceptOffer(req.userApp, {
        user: req.user,
        context: req.userAppContext,
        expectedRevision: requiredRevision(req)
      });
      logAudit({
        req,
        action: 'update',
        resource: 'userAppShare',
        resourceId: record.id,
        summary:
          `${record.owner.name || record.owner.id} accepted personal app "${appName(record)}" ` +
          `from ${previousOwner?.name || previousOwner?.id}; ` +
          `${downgraded} editor${downgraded === 1 ? '' : 's'} became "Can use"`,
        details: {
          offer: 'accepted',
          from: previousOwner?.id ?? null,
          to: record.owner.id,
          downgraded,
          ...auditStamp(record)
        }
      });
      await sendUserApp(res, record, req.user);
    }
  );
}
