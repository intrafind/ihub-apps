// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * Workflow Trigger Routes
 *
 * Provides the public webhook endpoint for workflow triggers:
 * - POST /api/workflows/:workflowId/webhooks/:triggerId
 *
 * The webhook endpoint is intentionally public (no authRequired) but uses
 * HMAC-SHA256 signature verification when a secret is configured on the trigger.
 *
 * @module routes/workflow/triggerRoutes
 */

import express from 'express';
import { buildServerPath } from '../../utils/basePath.js';
import { assertValidId } from '../../utils/pathSecurity.js';
import { ServiceError } from '../../utils/ServiceError.js';
import { getTriggerManager } from '../../services/workflow/triggers/TriggerManager.js';
import { requireFeature } from '../../featureRegistry.js';
import logger from '../../utils/logger.js';

/** Middleware that gates requests behind the 'workflows' feature flag */
const checkWorkflowsFeature = requireFeature('workflows');

/**
 * Registers all trigger-related routes on the Express app.
 *
 * @param {import('express').Express} app - The Express application
 */
export function registerTriggerRoutes(app) {
  /**
   * POST /api/workflows/:workflowId/webhooks/:triggerId
   *
   * Public webhook endpoint. External systems (e.g. GitHub, CI pipelines)
   * call this URL to trigger a workflow execution.
   *
   * Authentication is enforced via HMAC-SHA256 signature verification
   * (headers: x-hub-signature-256 or x-signature). The trigger MUST have
   * a `secret` configured -- requests to a trigger without a secret are
   * rejected with 401, because otherwise anyone on the network could
   * fire workflows.
   *
   * The raw request body is captured for HMAC verification (parsing
   * + re-stringifying would change byte order and break valid
   * signatures from third-party services like GitHub).
   *
   * The parsed body is passed as initialData to the workflow.
   */
  app.post(
    buildServerPath('/api/workflows/:workflowId/webhooks/:triggerId'),
    // Capture the raw body for HMAC verification BEFORE JSON parsing.
    // This route bypasses the global body parser to keep byte fidelity.
    express.raw({ type: '*/*', limit: '1mb' }),
    checkWorkflowsFeature,
    async (req, res) => {
      assertValidId(req.params.workflowId, 'workflow');
      assertValidId(req.params.triggerId, 'trigger');

      const triggerManager = getTriggerManager();
      const webhookRef = triggerManager.getWebhookTrigger(
        req.params.workflowId,
        req.params.triggerId
      );

      if (!webhookRef) {
        throw new ServiceError('NOT_FOUND', 'Webhook trigger not found');
      }

      // Require a configured secret to prevent anonymous workflow execution
      if (!webhookRef.trigger.config.secret) {
        logger.warn({
          component: 'triggerRoutes',
          message: 'Webhook trigger has no secret configured; rejecting request',
          workflowId: req.params.workflowId,
          triggerId: req.params.triggerId
        });
        throw new ServiceError(
          'AUTH_REQUIRED',
          'Webhook trigger requires a secret. Configure one to enable.'
        );
      }

      // Verify HMAC over the raw body bytes (not re-stringified JSON)
      const rawBody = Buffer.isBuffer(req.body) ? req.body : Buffer.from('');
      const signature = req.headers['x-hub-signature-256'] || req.headers['x-signature'];
      if (!webhookRef.trigger.verifyRawSignature(rawBody, signature)) {
        throw new ServiceError('AUTH_REQUIRED', 'Invalid signature');
      }

      // Parse JSON now that the signature is verified
      let initialData = {};
      if (rawBody.length > 0) {
        try {
          initialData = JSON.parse(rawBody.toString('utf8'));
        } catch {
          throw new ServiceError('BAD_REQUEST', 'Invalid JSON body');
        }
      }

      await triggerManager.fireTrigger(req.params.workflowId, {
        id: req.params.triggerId,
        type: 'webhook',
        initialData
      });

      res.json({ success: true, message: 'Webhook processed' });
    }
  );
}

export default registerTriggerRoutes;
