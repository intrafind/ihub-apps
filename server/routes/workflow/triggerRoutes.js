/**
 * Workflow Trigger Routes
 *
 * Provides endpoints for managing and invoking workflow triggers:
 * - GET  /api/workflows/triggers                          — list active triggers (admin)
 * - POST /api/workflows/:id/trigger                       — manually fire a trigger (admin)
 * - POST /api/workflows/:workflowId/webhooks/:triggerId   — public webhook endpoint
 *
 * The webhook endpoint is intentionally public (no authRequired) but uses
 * HMAC-SHA256 signature verification when a secret is configured on the trigger.
 *
 * @module routes/workflow/triggerRoutes
 */

import express from 'express';
import { buildServerPath } from '../../utils/basePath.js';
import { validateIdForPath } from '../../utils/pathSecurity.js';
import { getTriggerManager } from '../../services/workflow/triggers/TriggerManager.js';
import { requireFeature } from '../../featureRegistry.js';
import logger from '../../utils/logger.js';

/** Middleware that gates requests behind the 'workflows' feature flag */
const checkWorkflowsFeature = requireFeature('workflows');

/**
 * Registers all trigger-related routes on the Express app.
 *
 * @param {import('express').Express} app - The Express application
 * @param {Object} deps - Route dependencies (middleware)
 * @param {Function} deps.authRequired - Middleware that enforces authentication
 * @param {Function} deps.adminAuth - Middleware that enforces admin privileges
 */
export function registerTriggerRoutes(app, { authRequired, adminAuth }) {
  /**
   * GET /api/workflows/triggers
   *
   * Returns all currently active triggers across all workflows.
   * Admin-only. Useful for monitoring which schedules / webhooks are registered.
   */
  app.get(
    buildServerPath('/api/workflows/triggers'),
    authRequired,
    adminAuth,
    checkWorkflowsFeature,
    (req, res) => {
      try {
        const triggerManager = getTriggerManager();
        const triggers = triggerManager.getActiveTriggers();
        res.json({ triggers });
      } catch (error) {
        logger.error({
          component: 'triggerRoutes',
          message: `Failed to list triggers: ${error.message}`
        });
        res.status(500).json({ error: 'Failed to list triggers' });
      }
    }
  );

  /**
   * POST /api/workflows/:id/trigger
   *
   * Manually fires the trigger for a workflow, starting a new execution.
   * Admin-only. Accepts optional `initialData` in the request body.
   */
  app.post(
    buildServerPath('/api/workflows/:id/trigger'),
    authRequired,
    adminAuth,
    checkWorkflowsFeature,
    async (req, res) => {
      if (!validateIdForPath(req.params.id, 'workflow', res)) {
        return;
      }

      try {
        const triggerManager = getTriggerManager();
        await triggerManager.fireTrigger(
          req.params.id,
          {
            id: 'manual',
            type: 'manual',
            initialData: req.body?.initialData || {}
          },
          { user: req.user }
        );
        res.json({ success: true, message: 'Trigger fired' });
      } catch (error) {
        logger.error({
          component: 'triggerRoutes',
          message: `Failed to fire trigger: ${error.message}`
        });
        res.status(500).json({ error: 'Failed to fire trigger' });
      }
    }
  );

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
      if (!validateIdForPath(req.params.workflowId, 'workflow', res)) {
        return;
      }
      if (!validateIdForPath(req.params.triggerId, 'trigger', res)) {
        return;
      }

      try {
        const triggerManager = getTriggerManager();
        const webhookRef = triggerManager.getWebhookTrigger(
          req.params.workflowId,
          req.params.triggerId
        );

        if (!webhookRef) {
          return res.status(404).json({ error: 'Webhook trigger not found' });
        }

        // Require a configured secret to prevent anonymous workflow execution
        if (!webhookRef.trigger.config.secret) {
          logger.warn({
            component: 'triggerRoutes',
            message: 'Webhook trigger has no secret configured; rejecting request',
            workflowId: req.params.workflowId,
            triggerId: req.params.triggerId
          });
          return res
            .status(401)
            .json({ error: 'Webhook trigger requires a secret. Configure one to enable.' });
        }

        // Verify HMAC over the raw body bytes (not re-stringified JSON)
        const rawBody = Buffer.isBuffer(req.body) ? req.body : Buffer.from('');
        const signature = req.headers['x-hub-signature-256'] || req.headers['x-signature'];
        if (!webhookRef.trigger.verifyRawSignature(rawBody, signature)) {
          return res.status(401).json({ error: 'Invalid signature' });
        }

        // Parse JSON now that the signature is verified
        let initialData = {};
        if (rawBody.length > 0) {
          try {
            initialData = JSON.parse(rawBody.toString('utf8'));
          } catch {
            return res.status(400).json({ error: 'Invalid JSON body' });
          }
        }

        await triggerManager.fireTrigger(req.params.workflowId, {
          id: req.params.triggerId,
          type: 'webhook',
          initialData
        });

        res.json({ success: true, message: 'Webhook processed' });
      } catch (error) {
        logger.error({
          component: 'triggerRoutes',
          message: `Webhook processing failed: ${error.message}`
        });
        res.status(500).json({ error: 'Webhook processing failed' });
      }
    }
  );
}

export default registerTriggerRoutes;
