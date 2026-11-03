// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * The admin queue of integration requests (#2926):
 *
 *   GET    /api/admin/integrations/requests                       every request, the hidden list, the open count
 *   POST   /api/admin/integrations/requests/:id/_approve          { note? }        → { request }
 *   POST   /api/admin/integrations/requests/:id/_decline          { note?, hide? } → { request, alsoDeclined }
 *   DELETE /api/admin/integrations/requests/hidden/:definitionId  show a hidden definition again
 *
 * Approving marks the request `approved`; the admin page then opens the
 * install wizard for its definition. The request closes as `fulfilled` once
 * an enabled installation of the definition exists that the requester's
 * groups allow: after an install, update or enable ({@link closeRequestsFor}),
 * and whenever the queue is read (a later group change counts too).
 * "Decline and hide" also hides the definition from every user's catalog view
 * and declines the other open requests for it.
 *
 * Every decision is audited (`integration` / `requestDecision`).
 *
 * @module routes/admin/integrationRequests
 */
import { buildServerPath } from '../../utils/basePath.js';
import { adminAuth } from '../../middleware/adminAuth.js';
import { sendInternalError } from '../../utils/responseHelpers.js';
import { logAudit } from '../../services/AuditLogService.js';
import integrationRegistry from '../../services/integrations/definitions/IntegrationRegistry.js';
import installedIntegrationService from '../../services/integrations/InstalledIntegrationService.js';
import {
  IntegrationRequestError,
  MAX_NOTE_LENGTH,
  REQUEST_STATUSES,
  getIntegrationRequestService,
  isDefinitionId,
  isRequestId
} from '../../services/integrations/IntegrationRequestService.js';
import { definitionNameOf } from '../../services/integrations/integrationRequestCatalog.js';
import logger from '../../utils/logger.js';

const COMPONENT = 'AdminIntegrationRequestRoutes';

function languageOf(req) {
  const raw =
    req.query.lang || req.headers['accept-language']?.split(',')[0]?.split(';')[0] || 'en';
  return /^[a-z]{2}(-[A-Z]{2})?$/.test(raw) ? raw : 'en';
}

/** The request as the queue lists it. */
function adminRequestView(request, language, installations) {
  const entry = integrationRegistry.get(request.definition);
  return {
    ...request,
    definitionName: definitionNameOf(entry, request.definition, language),
    /** The definition is still in the catalog (Approve needs it). */
    definitionAvailable: Boolean(entry) && entry.status !== 'incompatible',
    /** Installations of the definition: approving may only need a group grant. */
    installedInstances: installations
      .filter(instance => instance.definition === request.definition)
      .map(instance => instance.id)
  };
}

/**
 * Close the requests an installation of `definition` now serves, and audit
 * each. Never throws: an install must not fail over its requests.
 *
 * @param {import('express').Request} req - The admin request that installed
 * @param {string} [definition] - Only requests for this definition
 * @returns {Promise<Object[]>} The closed requests
 */
export async function closeRequestsFor(req, definition) {
  try {
    const closed = await getIntegrationRequestService().closeFulfilled({
      installations: installedIntegrationService.list(),
      ...(definition ? { definition } : {})
    });
    for (const request of closed) {
      logAudit({
        req,
        action: 'requestDecision',
        resource: 'integration',
        resourceId: request.definition,
        summary: `Closed the request of ${request.requester.id} for "${request.definition}": installed as "${request.fulfilledBy}"`
      });
    }
    return closed;
  } catch (error) {
    logger.warn('Could not close the integration requests an installation serves', {
      component: COMPONENT,
      definition: definition || null,
      error: error.message
    });
    return [];
  }
}

/** The note an admin added: optional string of bounded length. Answers when invalid. */
function noteOf(req, res) {
  const note = req.body?.note;
  if (note === undefined || note === null) return { ok: true, note: null };
  if (typeof note !== 'string') {
    res.status(400).json({ error: 'note must be a string', code: 'INVALID_NOTE' });
    return { ok: false };
  }
  if (note.length > MAX_NOTE_LENGTH) {
    res.status(400).json({
      error: `note must be at most ${MAX_NOTE_LENGTH} characters`,
      code: 'NOTE_TOO_LONG'
    });
    return { ok: false };
  }
  return { ok: true, note };
}

function requestIdOf(req, res) {
  const id = req.params.id;
  if (!isRequestId(id)) {
    res.status(404).json({ error: 'Request not found', code: 'REQUEST_NOT_FOUND' });
    return null;
  }
  return id;
}

function sendRequestError(res, error, context) {
  if (error instanceof IntegrationRequestError) {
    return res.status(error.status).json({ error: error.message, code: error.code });
  }
  return sendInternalError(res, error, context);
}

export default function registerAdminIntegrationRequestRoutes(app) {
  /**
   * @swagger
   * /api/admin/integrations/requests:
   *   get:
   *     summary: The queue of integration requests
   *     tags:
   *       - Admin - Integrations
   *     responses:
   *       200:
   *         description: "{ requests, hidden: [{ definition, name, hiddenAt, hiddenBy }], openCount }"
   */
  app.get(buildServerPath('/api/admin/integrations/requests'), adminAuth, async (req, res) => {
    try {
      await integrationRegistry.ensureLoaded();
      await closeRequestsFor(req);
      const language = languageOf(req);
      const installations = installedIntegrationService.list();
      const service = getIntegrationRequestService();
      const [requests, hidden] = await Promise.all([service.list(), service.listHidden()]);
      res.setHeader('Cache-Control', 'no-store');
      res.json({
        success: true,
        requests: requests.map(request => adminRequestView(request, language, installations)),
        hidden: hidden.map(entry => ({
          ...entry,
          name: definitionNameOf(
            integrationRegistry.get(entry.definition),
            entry.definition,
            language
          )
        })),
        openCount: requests.filter(request => request.status === REQUEST_STATUSES.OPEN).length
      });
    } catch (error) {
      sendInternalError(res, error, 'list integration requests');
    }
  });

  /**
   * @swagger
   * /api/admin/integrations/requests/{id}/_approve:
   *   post:
   *     summary: Approve a request; the admin installs it next
   *     tags:
   *       - Admin - Integrations
   *     responses:
   *       200: { description: "{ request }" }
   *       404: { description: No such request, or its definition left the catalog }
   *       409: { description: The request is closed (REQUEST_CLOSED) or changed meanwhile }
   */
  app.post(
    buildServerPath('/api/admin/integrations/requests/:id/_approve'),
    adminAuth,
    async (req, res) => {
      const id = requestIdOf(req, res);
      if (!id) return;
      const { ok, note } = noteOf(req, res);
      if (!ok) return;
      try {
        await integrationRegistry.ensureLoaded();
        const service = getIntegrationRequestService();
        const current = await service.get(id);
        if (!current) {
          return res.status(404).json({ error: 'Request not found', code: 'REQUEST_NOT_FOUND' });
        }
        const entry = integrationRegistry.get(current.definition);
        if (!entry || entry.status === 'incompatible') {
          return res.status(404).json({
            error: 'The requested integration is no longer in the catalog',
            code: 'DEFINITION_NOT_FOUND'
          });
        }
        const { request } = await service.decide(id, {
          decision: REQUEST_STATUSES.APPROVED,
          admin: req.user,
          note
        });
        logAudit({
          req,
          action: 'requestDecision',
          resource: 'integration',
          resourceId: request.definition,
          summary: `Approved the request of ${request.requester.id} for "${request.definition}"`
        });
        res.json({
          success: true,
          request: adminRequestView(request, languageOf(req), installedIntegrationService.list())
        });
      } catch (error) {
        sendRequestError(res, error, 'approve an integration request');
      }
    }
  );

  /**
   * @swagger
   * /api/admin/integrations/requests/{id}/_decline:
   *   post:
   *     summary: Decline a request, optionally hiding its definition from every user
   *     tags:
   *       - Admin - Integrations
   *     responses:
   *       200: { description: "{ request, alsoDeclined }" }
   *       404: { description: No such request }
   *       409: { description: The request is closed (REQUEST_CLOSED) or changed meanwhile }
   */
  app.post(
    buildServerPath('/api/admin/integrations/requests/:id/_decline'),
    adminAuth,
    async (req, res) => {
      const id = requestIdOf(req, res);
      if (!id) return;
      const { ok, note } = noteOf(req, res);
      if (!ok) return;
      const hide = req.body?.hide;
      if (hide !== undefined && typeof hide !== 'boolean') {
        return res.status(400).json({ error: 'hide must be a boolean', code: 'INVALID_HIDE' });
      }
      try {
        await integrationRegistry.ensureLoaded();
        const { request, alsoDeclined } = await getIntegrationRequestService().decide(id, {
          decision: REQUEST_STATUSES.DECLINED,
          admin: req.user,
          note,
          hide: hide === true
        });
        logAudit({
          req,
          action: 'requestDecision',
          resource: 'integration',
          resourceId: request.definition,
          summary: `Declined the request of ${request.requester.id} for "${request.definition}"${
            hide === true
              ? ` and hid it from the catalog (${alsoDeclined.length} more declined)`
              : ''
          }`
        });
        res.json({
          success: true,
          request: adminRequestView(request, languageOf(req), installedIntegrationService.list()),
          alsoDeclined: alsoDeclined.length
        });
      } catch (error) {
        sendRequestError(res, error, 'decline an integration request');
      }
    }
  );

  /**
   * @swagger
   * /api/admin/integrations/requests/hidden/{definitionId}:
   *   delete:
   *     summary: Show a hidden definition in the users' catalog again
   *     tags:
   *       - Admin - Integrations
   *     responses:
   *       200: { description: "{ success: true }" }
   *       400: { description: Invalid definition id }
   *       404: { description: The definition is not hidden }
   */
  app.delete(
    buildServerPath('/api/admin/integrations/requests/hidden/:definitionId'),
    adminAuth,
    async (req, res) => {
      // Definition ids may carry one "/", so they travel URL-encoded.
      const definition = req.params.definitionId;
      if (!isDefinitionId(definition)) {
        return res.status(400).json({ error: 'Invalid definition id', code: 'INVALID_DEFINITION' });
      }
      try {
        const shown = await getIntegrationRequestService().unhide(definition);
        if (!shown) {
          return res.status(404).json({ error: 'Not hidden', code: 'NOT_HIDDEN' });
        }
        logAudit({
          req,
          action: 'update',
          resource: 'integration',
          resourceId: definition,
          summary: `Showed "${definition}" in the users' catalog again`
        });
        res.json({ success: true });
      } catch (error) {
        sendInternalError(res, error, 'show a hidden integration');
      }
    }
  );
}
