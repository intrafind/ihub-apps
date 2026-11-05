// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * Users request catalog integrations (#2926):
 *
 *   GET  /api/integrations/requests    the catalog entries not available to the
 *                                      caller yet, each with the caller's request
 *   POST /api/integrations/requests    { definition, reason? } → 201 { request }
 *
 * Mounted on `/api/integrations/requests` before the user integrations
 * router, so `GET /api/integrations/requests` is this list; an installation
 * whose id is `requests` keeps every other route of `/api/integrations/:id`.
 *
 * Security:
 * - Signed-in users only: `authRequired`, and the anonymous principal is
 *   refused even when anonymous access is on (a request needs someone to
 *   answer). Delegated callers (OAuth clients, agents, API keys including
 *   personal ones) cannot request.
 * - `definition` must match the definition id grammar and name an entry the
 *   caller could request; anything else answers 404, so hidden definitions
 *   and ones already available cannot be told apart from unknown ones.
 * - `reason` is optional, at most {@link MAX_REASON_LENGTH} characters;
 *   control characters are removed.
 * - POST requires a JSON body, so a cross-site form cannot send one.
 * - One open request per user and definition (409 `REQUEST_EXISTS`).
 * - Every request is audited (`integration` / `request`).
 *
 * @module routes/integrations/integrationRequests
 */
import express from 'express';
import { authRequired } from '../../middleware/authRequired.js';
import { isAdminEligiblePrincipal } from '../../utils/authorization.js';
import { requireFeature } from '../../featureRegistry.js';
import { sanitizeLanguageCode } from '../../utils/pathSecurity.js';
import { ServiceError } from '../../utils/ServiceError.js';
import { logAudit } from '../../services/AuditLogService.js';
import configCache from '../../configCache.js';
import integrationRegistry from '../../services/integrations/definitions/IntegrationRegistry.js';
import installedIntegrationService from '../../services/integrations/InstalledIntegrationService.js';
import {
  MAX_REASON_LENGTH,
  getIntegrationRequestService,
  isDefinitionId
} from '../../services/integrations/IntegrationRequestService.js';
import {
  isRequestable,
  requestCatalogEntry
} from '../../services/integrations/integrationRequestCatalog.js';

const router = express.Router();

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
 * Delegated callers act on behalf of someone and may not file requests in
 * their name: the principals that can never be admins (OAuth clients, agents,
 * and the bearer-token auth modes, personal API keys included), as for the
 * connect routes.
 */
function isDelegated(user) {
  return !isAdminEligiblePrincipal(user);
}

/** What the requester sees of their own request. */
export function userRequestView(request) {
  if (!request) return null;
  return {
    id: request.id,
    status: request.status,
    reason: request.reason || null,
    createdAt: request.createdAt,
    decidedAt: request.decidedAt || null,
    note: request.note || null
  };
}

/** The requestable entries, with the caller's request for each. */
async function catalogFor(user, language) {
  await integrationRegistry.ensureLoaded();
  const installations = installedIntegrationService.list();
  const service = getIntegrationRequestService();
  // Close what the user can use by now (checked with their current groups).
  await service.closeFulfilled({ installations, user });
  const [mine, hidden] = await Promise.all([
    service.listForUser(user.id),
    service.hiddenDefinitions()
  ]);
  const byDefinition = new Map(mine.map(request => [request.definition, request]));
  return integrationRegistry
    .list()
    .filter(entry => isRequestable(entry, { installations, user, hidden }))
    .map(entry => ({
      ...requestCatalogEntry(entry, language),
      request: userRequestView(byDefinition.get(entry.definition.id))
    }))
    .sort((a, b) => a.name.localeCompare(b.name));
}

/**
 * @swagger
 * /api/integrations/requests:
 *   get:
 *     summary: Catalog integrations the signed-in user can request
 *     description: |
 *       The catalog entries no enabled installation makes available to the
 *       caller's groups (leaving out hidden, incompatible and always-installed
 *       ones), each with the caller's own request (`open`, `approved`,
 *       `declined`, `fulfilled`) or null.
 *     tags:
 *       - Integrations
 *     responses:
 *       200:
 *         description: "{ items: [{ definition, name, description, icon, publisher, categories, capabilities, actionCount, effects, request }] }"
 *       401:
 *         description: Not signed in
 */
router.get('/', requireFeature('integrations'), authRequired, async (req, res) => {
  if (isAnonymous(req.user)) throw new ServiceError('AUTH_REQUIRED', 'Authentication required');
  const items = await catalogFor(req.user, languageOf(req));
  res.setHeader('Cache-Control', 'no-store');
  return res.json({ items });
});

/**
 * @swagger
 * /api/integrations/requests:
 *   post:
 *     summary: Request a catalog integration
 *     tags:
 *       - Integrations
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [definition]
 *             properties:
 *               definition: { type: string }
 *               reason: { type: string, maxLength: 500 }
 *     responses:
 *       201:
 *         description: "{ request }"
 *       400:
 *         description: Invalid definition id or reason
 *       401:
 *         description: Not signed in
 *       403:
 *         description: Delegated callers cannot request
 *       404:
 *         description: Not a definition the caller can request
 *       409:
 *         description: The caller already has an open request for it (REQUEST_EXISTS)
 */
router.post('/', requireFeature('integrations'), authRequired, async (req, res) => {
  if (isAnonymous(req.user)) throw new ServiceError('AUTH_REQUIRED', 'Authentication required');
  if (isDelegated(req.user)) {
    throw new ServiceError(
      'INTERACTIVE_SESSION_REQUIRED',
      'Only an interactive session can request integrations'
    );
  }
  if (!req.is('application/json')) {
    throw new ServiceError('JSON_REQUIRED', 'Send a JSON body');
  }
  const body = req.body && typeof req.body === 'object' ? req.body : {};
  const { definition, reason } = body;
  if (!isDefinitionId(definition)) {
    throw new ServiceError('INVALID_DEFINITION', 'Invalid definition id');
  }
  if (reason !== undefined && reason !== null && typeof reason !== 'string') {
    throw new ServiceError('INVALID_REASON', 'reason must be a string');
  }
  if (typeof reason === 'string' && reason.length > MAX_REASON_LENGTH) {
    throw new ServiceError(
      'REASON_TOO_LONG',
      `reason must be at most ${MAX_REASON_LENGTH} characters`
    );
  }

  await integrationRegistry.ensureLoaded();
  {
    const service = getIntegrationRequestService();
    const entry = integrationRegistry.get(definition);
    const requestable =
      Boolean(entry) &&
      isRequestable(entry, {
        installations: installedIntegrationService.list(),
        user: req.user,
        hidden: await service.hiddenDefinitions()
      });
    if (!requestable) {
      throw new ServiceError('INTEGRATION_NOT_FOUND', 'Integration not found');
    }
    const request = await service.create({ user: req.user, definition, reason });
    logAudit({
      req,
      action: 'request',
      resource: 'integration',
      resourceId: definition,
      summary: `Requested integration "${definition}"${request.reason ? ' with a reason' : ''}`
    });
    return res.status(201).json({ request: userRequestView(request) });
  }
});

export default router;
