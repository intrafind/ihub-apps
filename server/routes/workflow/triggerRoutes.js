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
      const validation = validateIdForPath(req.params.id, 'workflow');
      if (!validation.valid) {
        return res.status(400).json({ error: 'Invalid workflow ID' });
      }

      try {
        const triggerManager = getTriggerManager();
        await triggerManager.fireTrigger(validation.sanitized, {
          id: 'manual',
          type: 'manual',
          initialData: req.body?.initialData || {}
        });
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
   * Authentication is handled via HMAC-SHA256 signature verification
   * (headers: x-hub-signature-256 or x-signature) when a secret is
   * configured on the trigger. If no secret is configured, any request
   * is accepted.
   *
   * The request body is passed as initialData to the workflow.
   */
  app.post(
    buildServerPath('/api/workflows/:workflowId/webhooks/:triggerId'),
    checkWorkflowsFeature,
    async (req, res) => {
      const wfValidation = validateIdForPath(req.params.workflowId, 'workflow');
      const triggerValidation = validateIdForPath(req.params.triggerId, 'trigger');

      if (!wfValidation.valid || !triggerValidation.valid) {
        return res.status(400).json({ error: 'Invalid ID' });
      }

      try {
        const triggerManager = getTriggerManager();
        const webhookRef = triggerManager.getWebhookTrigger(triggerValidation.sanitized);

        if (!webhookRef || webhookRef.workflowId !== wfValidation.sanitized) {
          return res.status(404).json({ error: 'Webhook trigger not found' });
        }

        // Verify HMAC signature if the trigger has a secret configured
        const signature = req.headers['x-hub-signature-256'] || req.headers['x-signature'];
        if (!webhookRef.trigger.verifySignature(req.body, signature)) {
          return res.status(401).json({ error: 'Invalid signature' });
        }

        await triggerManager.fireTrigger(wfValidation.sanitized, {
          id: triggerValidation.sanitized,
          type: 'webhook',
          initialData: req.body || {}
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
