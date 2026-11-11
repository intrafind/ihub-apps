// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * Admin API of the EU AI Act master switch (step 9 of epic #3324).
 *
 * - `GET  /api/admin/eu-ai-act/conformity`: the record (state, who, when, why, history)
 * - `POST /api/admin/eu-ai-act/conformity/_disable`: switch every EU AI Act feature off
 * - `POST /api/admin/eu-ai-act/conformity/_enable`: switch them on again
 *
 * Only an interactive admin session may switch: personal API keys, OAuth
 * client tokens and agents get `403 INTERACTIVE_SESSION_REQUIRED`. The actor is
 * taken from the session, never from the body. Every switch writes the record
 * first (the source of truth) and then one `toggle` audit entry.
 *
 * `conformity` is the technical name; the admin UI says "EU AI Act features"
 * because iHub cannot confer conformity.
 *
 * @module routes/admin/euAiActConformity
 */
import { adminAuth } from '../../middleware/adminAuth.js';
import { buildServerPath } from '../../utils/basePath.js';
import { ServiceError } from '../../utils/ServiceError.js';
import { isAdminEligiblePrincipal } from '../../utils/authorization.js';
import { logAudit } from '../../services/AuditLogService.js';
import { getConformity, setConformity } from '../../services/euAiAct/conformity.js';
import {
  disableBodySchema,
  enableBodySchema,
  STATEMENT_VERSION
} from '../../validators/euAiActConformitySchema.js';
import logger from '../../utils/logger.js';

/** The principal who switches: an interactive session, never a token or agent. */
function interactiveActor(req) {
  const user = req.user;
  if (
    !user?.id ||
    user.id === 'anonymous' ||
    user.isPersonalApiKey ||
    user.isOAuthClient ||
    user.isAgent === true ||
    user.clientId ||
    !isAdminEligiblePrincipal(user)
  ) {
    throw new ServiceError(
      'INTERACTIVE_SESSION_REQUIRED',
      'Only an interactive admin session can switch the EU AI Act features'
    );
  }
  return { id: String(user.id), name: String(user.name || user.username || user.id) };
}

export default function registerAdminEuAiActConformityRoutes(app) {
  /**
   * @swagger
   * /api/admin/eu-ai-act/conformity:
   *   get:
   *     summary: The EU AI Act master switch record
   *     description: >-
   *       `{ enabled, valid, changedAt, changedBy, reason, statementVersion, history }`. History is
   *       newest first (the last 100 switches; the audit log keeps more). `valid` is false when the
   *       stored record is incomplete or malformed; the features then stay on.
   *     tags: [Admin - EU AI Act]
   *     responses:
   *       200: { description: The record }
   *       401: { description: Not signed in }
   *       403: { description: Not an admin }
   */
  app.get(buildServerPath('/api/admin/eu-ai-act/conformity'), adminAuth, (req, res) => {
    res.set('Cache-Control', 'no-store');
    res.json(getConformity());
  });

  /**
   * @swagger
   * /api/admin/eu-ai-act/conformity/_disable:
   *   post:
   *     summary: Switch every EU AI Act feature off
   *     description: >-
   *       Turns the guardrail, first-turn notice, acknowledgement requirement, provenance records
   *       and response metadata, text watermarking, image marking and verification off. Stored
   *       data is kept. The caller, the time and the reason are recorded on the server and in the
   *       audit log. Switching off does not remove the deployer's legal duties.
   *     tags: [Admin - EU AI Act]
   *     requestBody:
   *       required: true
   *       content:
   *         application/json:
   *           schema:
   *             type: object
   *             required: [reason, acceptResponsibility]
   *             additionalProperties: false
   *             properties:
   *               reason: { type: string, minLength: 20, maxLength: 1000 }
   *               acceptResponsibility: { type: boolean, enum: [true] }
   *     responses:
   *       200: { description: The new record }
   *       400: { description: Reason too short or long, acceptance missing, unknown member }
   *       403: { description: Not an interactive admin session (INTERACTIVE_SESSION_REQUIRED) }
   *       409: { description: Already switched off (CONFLICT, details.enabled) }
   */
  app.post(
    buildServerPath('/api/admin/eu-ai-act/conformity/_disable'),
    adminAuth,
    async (req, res) => {
      const actor = interactiveActor(req);
      const body = disableBodySchema.parse(req.body ?? {});
      const { current } = await setConformity({
        enabled: false,
        reason: body.reason,
        actor,
        statementVersion: STATEMENT_VERSION
      });
      logger.warn('EU AI Act features switched off', {
        component: 'EuAiActConformity',
        actor: actor.id
      });
      logAudit({
        req,
        action: 'toggle',
        resource: 'euAiActConformity',
        resourceId: 'conformity',
        summary: 'EU AI Act features switched off',
        details: { from: true, to: false, reason: body.reason, statementVersion: STATEMENT_VERSION }
      });
      res.json(current);
    }
  );

  /**
   * @swagger
   * /api/admin/eu-ai-act/conformity/_enable:
   *   post:
   *     summary: Switch the EU AI Act features on again
   *     description: >-
   *       Everything resumes with the saved settings. Acknowledgements that are still valid stay
   *       valid; only users without a valid one are asked at their next message.
   *     tags: [Admin - EU AI Act]
   *     requestBody:
   *       content:
   *         application/json:
   *           schema:
   *             type: object
   *             additionalProperties: false
   *             properties:
   *               reason: { type: string, maxLength: 1000 }
   *     responses:
   *       200: { description: The new record }
   *       400: { description: Reason too long, unknown member }
   *       403: { description: Not an interactive admin session (INTERACTIVE_SESSION_REQUIRED) }
   *       409: { description: Already switched on (CONFLICT, details.enabled) }
   */
  app.post(
    buildServerPath('/api/admin/eu-ai-act/conformity/_enable'),
    adminAuth,
    async (req, res) => {
      const actor = interactiveActor(req);
      const body = enableBodySchema.parse(req.body ?? {});
      const { current } = await setConformity({ enabled: true, reason: body.reason, actor });
      logAudit({
        req,
        action: 'toggle',
        resource: 'euAiActConformity',
        resourceId: 'conformity',
        summary: 'EU AI Act features switched on',
        details: { from: false, to: true, reason: body.reason || null }
      });
      res.json(current);
    }
  );
}
