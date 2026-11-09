// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * The integrations of the signed-in user, and the one connect flow of every
 * protocol (#2917; concept `2026-10-20 Unified Integrations/04-architecture.md` §4):
 *
 *   GET  /api/integrations                    the installations the user's groups allow,
 *                                             with capabilities, actions and connection status
 *   GET  /api/integrations/:id                one of them
 *   POST /api/integrations/:id/_connect        { returnUrl? }           → { url }
 *   POST /api/integrations/:id/_reconnect      { returnUrl?, scopes? }  → { url }
 *   POST /api/integrations/:id/_disconnect     → { removed, revoked }
 *   GET  /api/integrations/picker?app=        the chat picker's rows for an app (#2923)
 *   GET  /api/integrations/preferences?app=   what a new chat of the app starts with
 *   PUT  /api/integrations/preferences?app=   save that default
 *
 * `url` is the vendor's authorization URL: the browser goes there, the user
 * consents, and the one callback (`GET /api/integrations/oauth/callback`, or
 * one of its vendor-registered aliases) sends it back to `returnUrl` with
 * `integration_connected=<id>` or `integration_error=<code>&integration=<id>`.
 *
 * Security:
 * - The installation id is checked against the registry and the user's
 *   groups (`permissions.integrations`); an installation the user may not use
 *   answers like one that does not exist (404), so ids cannot be probed.
 *   Disconnect only needs the installation to exist: it removes the caller's
 *   own tokens, which a user whose group lost the installation must still be
 *   able to do.
 * - `returnUrl` must be a same-origin path or an http(s) URL on this host;
 *   anything else is refused (400), never silently replaced.
 * - `state` and the PKCE verifier stay server-side, single-use, bound to the
 *   user and the installation (`oauthFlowStore`). The POST routes require a
 *   JSON body, so a cross-site form cannot start a flow (it would need a CORS
 *   preflight), and the session cookie is `SameSite=Lax`.
 * - Delegated callers (OAuth clients, agents, API keys including personal
 *   ones) cannot connect or disconnect, and never get the admin bypass.
 * - `GET /:id` does not look an id up for an anonymous caller: it hands the
 *   request on, so an installed id and an unknown one get the same answer.
 *
 * The routes are mounted on `/api/integrations` before the per-provider
 * routers. `GET /:id` hands requests for ids that are not installations on
 * (`next()`), so `/api/integrations/connections`, `/api-keys`, … keep working.
 *
 * @module routes/integrations/userIntegrations
 */
import express from 'express';
import rateLimit from 'express-rate-limit';
import { authRequired } from '../../middleware/authRequired.js';
import { requireFeature } from '../../featureRegistry.js';
import { ServiceError } from '../../utils/ServiceError.js';
import logger from '../../utils/logger.js';
import { isValidReturnUrl } from '../../utils/oauthReturnUrl.js';
import { SAFE_ID_PATTERN, isValidId, sanitizeLanguageCode } from '../../utils/pathSecurity.js';
import configCache from '../../configCache.js';
import installedIntegrationService from '../../services/integrations/InstalledIntegrationService.js';
import { mayUseIntegration } from '../../services/integrations/integrationAccess.js';
import {
  isAdmin,
  isAdminEligiblePrincipal,
  canUserAccessResource
} from '../../utils/authorization.js';
import { describeInstallation } from '../../services/integrations/auth/connectionProviders.js';
import { getIntegrationConnectionService } from '../../services/integrations/auth/IntegrationConnectionService.js';
import {
  OAUTH_FLOW_ERROR_CODES,
  OAuthFlowError,
  parseScope
} from '../../services/integrations/auth/OAuthUserClient.js';
import {
  getUserIntegration,
  listUserIntegrations
} from '../../services/integrations/userIntegrations.js';
import {
  appCandidateRefs,
  appIntegrationDefaults,
  pickerRowsForApp
} from '../../services/integrations/integrationPicker.js';
import {
  effectivePreferences,
  getIntegrationPreferencesRepository
} from '../../services/integrations/IntegrationPreferencesRepository.js';
import { findByIdCaseInsensitive } from '../../utils/resourceLookup.js';

const COMPONENT = 'UserIntegrations';

const router = express.Router();

/** Installation ids: the safe id characters, at most 64 long. */
const MAX_ID_LENGTH = 64;

/** Scopes a reconnect may ask for: a bounded list of plain scope tokens (RFC 6749 §3.3). */
const SCOPE_TOKEN = /^[\x21\x23-\x5B\x5D-\x7E]{1,200}$/;
const MAX_SCOPES = 50;

/**
 * Starting a sign-in reaches the vendor's authorization server (and, for MCP,
 * discovery and client registration); bound it per signed-in user, 20 a
 * minute. Runs after `authRequired`, so the user is known; a shared NAT does
 * not make colleagues share one budget. Exported for tests (`resetKey`).
 */
export const connectLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 20,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: req => `user:${req.user?.id || 'anonymous'}`
});

/** HTTP status per flow error code (everything else is 400). */
const FLOW_ERROR_STATUS = {
  [OAUTH_FLOW_ERROR_CODES.INTEGRATION_NOT_FOUND]: 404,
  [OAUTH_FLOW_ERROR_CODES.USER_MISMATCH]: 401,
  [OAUTH_FLOW_ERROR_CODES.DISCOVERY_FAILED]: 502,
  [OAUTH_FLOW_ERROR_CODES.REGISTRATION_FAILED]: 502,
  [OAUTH_FLOW_ERROR_CODES.PUBLIC_URL_MISMATCH]: 409
};

/** Whether a path segment can be an installation id at all. */
export function isInstallationId(value) {
  return typeof value === 'string' && value.length <= MAX_ID_LENGTH && SAFE_ID_PATTERN.test(value);
}

/** The language of the response (`?lang=`, else the request, else the platform default). */
function languageOf(req) {
  return sanitizeLanguageCode(
    req.query.lang || req.headers['accept-language']?.split(',')[0]?.split(';')[0],
    configCache.getPlatform()?.defaultLanguage || 'en'
  );
}

function isAnonymous(user) {
  return !user?.id || user.id === 'anonymous';
}

/**
 * Delegated callers act on behalf of someone; they may not change that
 * person's connections. The same principals that can never be admins: OAuth
 * clients, agents, and the bearer-token auth modes (client credentials, static
 * and personal API keys, authorization-code delegation).
 */
function isDelegated(user) {
  return !isAdminEligiblePrincipal(user);
}

/**
 * The scopes a reconnect asks for: an array or a space-separated string of
 * scope tokens; invalid tokens are dropped, at most {@link MAX_SCOPES}.
 *
 * @param {unknown} value
 * @returns {string[]}
 */
export function parseRequestedScopes(value) {
  const raw = Array.isArray(value) ? value.join(' ') : typeof value === 'string' ? value : '';
  return parseScope(raw)
    .filter(scope => SCOPE_TOKEN.test(scope))
    .slice(0, MAX_SCOPES);
}

/**
 * Common checks of the POST routes; throws a ServiceError when the request
 * cannot go on.
 *
 * @returns {{installationId: string}}
 */
function checkPost(req) {
  if (isAnonymous(req.user)) {
    throw new ServiceError('AUTH_REQUIRED', 'Authentication required');
  }
  if (isDelegated(req.user)) {
    throw new ServiceError(
      'INTERACTIVE_SESSION_REQUIRED',
      'Only an interactive session can manage integration connections'
    );
  }
  // A JSON body (even `{}`) is required: a cross-site HTML form cannot send
  // one without a CORS preflight.
  if (!req.is('application/json')) {
    throw new ServiceError('JSON_REQUIRED', 'Send a JSON body');
  }
  const installationId = req.params.id;
  if (!isInstallationId(installationId)) {
    throw new ServiceError('INTEGRATION_NOT_FOUND', 'Integration not found');
  }
  return { installationId };
}

/**
 * Start (or restart) the sign-in to an installation for the caller.
 *
 * @param {import('express').Request} req
 * @param {import('express').Response} res
 * @param {{reconnect: boolean}} options
 */
async function startConnect(req, res, { reconnect }) {
  const { installationId } = checkPost(req);
  const body = req.body && typeof req.body === 'object' ? req.body : {};

  if (body.returnUrl !== undefined && !isValidReturnUrl(body.returnUrl, req)) {
    throw new ServiceError(
      'INVALID_RETURN_URL',
      'returnUrl must be a path or an http(s) URL on this site'
    );
  }

  const instance = installedIntegrationService.get(installationId);
  // The user's groups decide; admins may always connect (they configure and
  // test the integrations). The installation's own rule (an MCP server's app
  // bindings, a storage provider's grant) is checked again when the flow starts.
  const allowed = Boolean(instance) && (mayUseIntegration(instance, req.user) || isAdmin(req.user));
  if (!instance || instance.enabled === false || !allowed) {
    throw new ServiceError('INTEGRATION_NOT_FOUND', 'Integration not found');
  }
  const descriptor = await describeInstallation(installationId).catch(() => null);
  if (!descriptor || descriptor.kind !== 'oauth-user') {
    throw new ServiceError(
      'NOT_CONNECTABLE',
      'This integration does not take a personal connection'
    );
  }

  const scopes = reconnect ? parseRequestedScopes(body.scopes) : [];
  const connections = getIntegrationConnectionService();
  const params = {
    installationId,
    user: req.user,
    req,
    ...(body.returnUrl !== undefined ? { returnUrl: String(body.returnUrl) } : {}),
    ...(scopes.length ? { scopes } : {})
  };
  try {
    const { authorizationUrl } = reconnect
      ? await connections.reconnect(params)
      : await connections.beginConnect(params);
    res.setHeader('Cache-Control', 'no-store');
    return res.json({ url: authorizationUrl.href });
  } catch (error) {
    if (error instanceof OAuthFlowError) {
      logger.warn('Integration sign-in could not start', {
        component: COMPONENT,
        integration: installationId,
        userId: req.user.id,
        code: error.code,
        error: error.message
      });
      if (error.code === OAUTH_FLOW_ERROR_CODES.INTEGRATION_NOT_FOUND) {
        throw new ServiceError('INTEGRATION_NOT_FOUND', 'Integration not found');
      }
      // `details.reason` carries the flow's own code (`discovery_failed`, ...).
      throw new ServiceError('INTEGRATION_CONNECT_FAILED', 'The sign-in could not be started', {
        status: FLOW_ERROR_STATUS[error.code] || 400,
        details: { reason: error.code }
      });
    }
    throw error;
  }
}

/**
 * @swagger
 * /api/integrations:
 *   get:
 *     summary: The integrations the signed-in user may use
 *     description: |
 *       Every enabled installation the user's groups allow (never another
 *       one), with capabilities, enabled actions and their side effects, and
 *       the connection status for this user (`connected` with the account,
 *       `sso`, `service_account`, `shared_key`, `not_connected`,
 *       `needs_reconnect` with a reason, `none`).
 *     tags:
 *       - Integrations
 *     parameters:
 *       - name: lang
 *         in: query
 *         schema: { type: string }
 *     responses:
 *       200:
 *         description: "{ integrations: [...] }"
 *       401:
 *         description: Not signed in
 */
router.get('/', requireFeature('integrations'), authRequired, async (req, res) => {
  if (isAnonymous(req.user)) throw new ServiceError('AUTH_REQUIRED', 'Authentication required');
  const integrations = await listUserIntegrations({ user: req.user, language: languageOf(req) });
  res.setHeader('Cache-Control', 'no-store');
  return res.json({ integrations });
});

/**
 * The app a picker or preferences request is about (`?app=`), or null with
 * the response sent. An app the user may not open answers like one that does
 * not exist, so app ids cannot be probed.
 *
 * @returns {Object} The app; throws a ServiceError otherwise
 */
function appOfRequest(req) {
  const appId = req.query.app;
  if (typeof appId !== 'string' || !isValidId(appId)) {
    throw new ServiceError('INVALID_APP', 'A valid app is required');
  }
  const app = findByIdCaseInsensitive(configCache.getApps()?.data || [], appId);
  if (!app || app.enabled === false || !canUserAccessResource(req.user, 'apps', app.id)) {
    throw new ServiceError('APP_NOT_FOUND', 'App not found');
  }
  return app;
}

/**
 * @swagger
 * /api/integrations/picker:
 *   get:
 *     summary: The rows of the chat's integrations picker for an app
 *     description: |
 *       One row per integration, MCP server, remote agent or tool the app
 *       offers this user — never one per action — with the tool references
 *       that switch it on (`refs`), the other references that keep it on
 *       (`coveredBy`), the side effects of its actions (`effects`) and, for
 *       an installed integration, its connection status.
 *     tags:
 *       - Integrations
 *     parameters:
 *       - { name: app, in: query, required: true, schema: { type: string } }
 *       - { name: lang, in: query, schema: { type: string } }
 *     responses:
 *       200:
 *         description: "{ app, rows: [...] }"
 *       404:
 *         description: Not an app the user may open
 */
router.get('/picker', authRequired, async (req, res) => {
  const app = appOfRequest(req);
  const rows = await pickerRowsForApp({ app, user: req.user, language: languageOf(req) });
  res.setHeader('Cache-Control', 'private, no-store');
  return res.json({ app: app.id, rows });
});

/**
 * @swagger
 * /api/integrations/preferences:
 *   get:
 *     summary: What a new chat of an app starts with, for the signed-in user
 *     description: |
 *       The integrations switched on (`enabledTools`, tool references), web
 *       search and the scope per integration. `stored` says whether the user
 *       saved a default; without one, the app's own defaults are answered.
 *       A chat keeps its own copy; scheduled tasks and workflows keep theirs.
 *     tags:
 *       - Integrations
 *     parameters:
 *       - { name: app, in: query, required: true, schema: { type: string } }
 *     responses:
 *       200:
 *         description: "{ app, stored, available, preferences: { enabledTools, websearchEnabled, integrationScopes } }"
 *       404:
 *         description: Not an app the user may open
 *   put:
 *     summary: Save what new chats of an app start with
 *     description: |
 *       Replaces the default. With `import: true` it is written only when the
 *       user has none yet (the one-time carry-over of what the browser kept).
 *     tags:
 *       - Integrations
 *     parameters:
 *       - { name: app, in: query, required: true, schema: { type: string } }
 *     requestBody:
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             properties:
 *               enabledTools: { type: array, items: { type: string } }
 *               websearchEnabled: { type: boolean }
 *               integrationScopes: { type: object, additionalProperties: { type: string } }
 *               import: { type: boolean }
 *     responses:
 *       200:
 *         description: Same shape as the GET
 *       401:
 *         description: Not signed in
 *       503:
 *         description: No storage to keep it in
 */
router.get('/preferences', authRequired, async (req, res) => {
  const app = appOfRequest(req);
  const defaults = appIntegrationDefaults(app);
  res.setHeader('Cache-Control', 'private, no-store');
  // A guest has no default of their own: new chats start with the app's.
  if (isAnonymous(req.user)) {
    return res.json({
      app: app.id,
      stored: false,
      available: false,
      preferences: effectivePreferences(null, defaults)
    });
  }
  const repository = getIntegrationPreferencesRepository();
  const available = repository.isAvailable();
  const stored = available ? await repository.get(String(req.user.id), app.id) : null;
  return res.json({
    app: app.id,
    stored: Boolean(stored),
    available,
    preferences: effectivePreferences(stored, defaults)
  });
});

router.put('/preferences', authRequired, async (req, res) => {
  if (isAnonymous(req.user)) throw new ServiceError('AUTH_REQUIRED', 'Authentication required');
  if (isDelegated(req.user)) {
    throw new ServiceError(
      'INTERACTIVE_SESSION_REQUIRED',
      'Only an interactive session can change these preferences'
    );
  }
  if (!req.is('application/json')) {
    throw new ServiceError('JSON_REQUIRED', 'Send a JSON body');
  }
  const app = appOfRequest(req);
  const body = req.body && typeof req.body === 'object' && !Array.isArray(req.body) ? req.body : {};
  const repository = getIntegrationPreferencesRepository();
  if (!repository.isAvailable()) {
    throw new ServiceError('PREFERENCES_UNAVAILABLE', 'Preferences cannot be stored here');
  }
  // Preferences are bookkeeping, not content: keep them out of the audit log.
  req._auditLogged = true;
  const { stored } = await repository.set(String(req.user.id), app.id, body, {
    knownRefs: appCandidateRefs(app),
    onlyIfAbsent: body.import === true
  });
  return res.json({
    app: app.id,
    stored: Boolean(stored),
    available: true,
    preferences: effectivePreferences(stored, appIntegrationDefaults(app))
  });
});

/**
 * @swagger
 * /api/integrations/{id}:
 *   get:
 *     summary: One integration the signed-in user may use
 *     tags:
 *       - Integrations
 *     parameters:
 *       - name: id
 *         in: path
 *         required: true
 *         schema: { type: string }
 *     responses:
 *       200:
 *         description: "{ integration: {...} }"
 *       404:
 *         description: |
 *           Not an installation the user may use. Anonymous callers are handed
 *           on to the other `/api/integrations/*` routes without a lookup.
 */
router.get('/:id', async (req, res, next) => {
  // An anonymous caller may use none of them, and answering it 401 for an
  // installed id but handing an unknown one on would tell which ids exist.
  // Hand every anonymous request on, before the registry lookup: the routers
  // after this one answer it by path alone.
  if (isAnonymous(req.user)) return next();
  // Not an installation id at all: one of the other `/api/integrations/*` routes.
  if (!isInstallationId(req.params.id) || !installedIntegrationService.get(req.params.id)) {
    return next();
  }
  return requireFeature('integrations')(req, res, () =>
    authRequired(req, res, async () => {
      // A callback cannot throw into Express: hand any error to `next`.
      try {
        if (isAnonymous(req.user)) {
          throw new ServiceError('AUTH_REQUIRED', 'Authentication required');
        }
        const integration = await getUserIntegration({
          user: req.user,
          installationId: req.params.id,
          language: languageOf(req)
        });
        if (!integration) {
          throw new ServiceError('INTEGRATION_NOT_FOUND', 'Integration not found');
        }
        res.setHeader('Cache-Control', 'no-store');
        return res.json({ integration });
      } catch (error) {
        return next(error);
      }
    })
  );
});

/**
 * @swagger
 * /api/integrations/{id}/_connect:
 *   post:
 *     summary: Start the sign-in to an integration
 *     description: |
 *       Answers the vendor's authorization URL. The browser goes there and
 *       comes back to `returnUrl` (same origin) with
 *       `integration_connected=<id>` or `integration_error=<code>&integration=<id>`.
 *     tags:
 *       - Integrations
 *     parameters:
 *       - name: id
 *         in: path
 *         required: true
 *         schema: { type: string }
 *     requestBody:
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             properties:
 *               returnUrl: { type: string }
 *     responses:
 *       200:
 *         description: "{ url }"
 *       400:
 *         description: Invalid returnUrl, or the integration takes no personal connection
 *       404:
 *         description: Not an installation the user may use
 *       415:
 *         description: No JSON body
 */
router.post(
  '/:id/_connect',
  requireFeature('integrations'),
  authRequired,
  connectLimiter,
  (req, res) => startConnect(req, res, { reconnect: false })
);

/**
 * @swagger
 * /api/integrations/{id}/_reconnect:
 *   post:
 *     summary: Sign in to an integration again, optionally with more scopes
 *     description: |
 *       Like `connect`; `scopes` (step-up) are added to what the user already
 *       granted. The connection keeps its id.
 *     tags:
 *       - Integrations
 *     parameters:
 *       - name: id
 *         in: path
 *         required: true
 *         schema: { type: string }
 *     requestBody:
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             properties:
 *               returnUrl: { type: string }
 *               scopes: { type: array, items: { type: string } }
 *     responses:
 *       200:
 *         description: "{ url }"
 */
router.post(
  '/:id/_reconnect',
  requireFeature('integrations'),
  authRequired,
  connectLimiter,
  (req, res) => startConnect(req, res, { reconnect: true })
);

/**
 * @swagger
 * /api/integrations/{id}/_disconnect:
 *   post:
 *     summary: Disconnect the caller from an integration
 *     description: |
 *       Revokes the grant at the vendor where it supports revocation, deletes
 *       the caller's tokens and records `connection.revoke` in the audit log.
 *     tags:
 *       - Integrations
 *     parameters:
 *       - name: id
 *         in: path
 *         required: true
 *         schema: { type: string }
 *     responses:
 *       200:
 *         description: "{ removed, revoked }"
 *       404:
 *         description: No such installation
 */
router.post('/:id/_disconnect', requireFeature('integrations'), authRequired, async (req, res) => {
  const { installationId } = checkPost(req);
  const descriptor = await describeInstallation(installationId).catch(() => null);
  if (!descriptor || descriptor.kind !== 'oauth-user') {
    throw new ServiceError('INTEGRATION_NOT_FOUND', 'Integration not found');
  }
  const result = await getIntegrationConnectionService().disconnect({
    installationId,
    userId: String(req.user.id),
    req
  });
  return res.json(result);
});

export default router;
