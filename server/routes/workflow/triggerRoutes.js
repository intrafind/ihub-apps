import { authRequired } from '../../middleware/authRequired.js';
import { adminAuth } from '../../middleware/adminAuth.js';
import { getTriggerManager } from '../../services/workflow/triggers/TriggerManager.js';
import { sendNotFound, sendBadRequest } from '../../utils/responseHelpers.js';
import { requireFeature } from '../../featureRegistry.js';
import { validateIdForPath } from '../../utils/pathSecurity.js';
import { buildServerPath } from '../../utils/basePath.js';

const checkWorkflowsFeature = requireFeature('experimentalWorkflows');

export function registerTriggerRoutes(app, { basePath = '' } = {}) {
  // GET /api/workflows/triggers - list all active triggers
  app.get(
    buildServerPath('/api/workflows/triggers'),
    authRequired,
    checkWorkflowsFeature,
    adminAuth,
    (req, res) => {
      const manager = getTriggerManager();
      res.json({ triggers: manager.getTriggersInfo() });
    }
  );

  // POST /api/workflows/:id/trigger - fire a webhook trigger manually
  app.post(
    buildServerPath('/api/workflows/:id/trigger'),
    authRequired,
    checkWorkflowsFeature,
    async (req, res) => {
      const { id } = req.params;
      try {
        validateIdForPath(id);
      } catch {
        return sendBadRequest(res, 'Invalid workflow ID');
      }

      const manager = getTriggerManager();
      const triggerId = `${id}:webhook`;
      const trigger = manager.triggers.get(triggerId);

      if (!trigger) {
        return sendNotFound(res, `No webhook trigger found for workflow ${id}`);
      }

      await trigger.fire(req.body || {});
      res.json({ success: true, message: `Trigger ${triggerId} fired` });
    }
  );

  // POST /api/workflows/:workflowId/webhooks/:triggerId - public webhook endpoint
  app.post(buildServerPath('/api/workflows/:workflowId/webhooks/:triggerId'), async (req, res) => {
    const { workflowId, triggerId } = req.params;
    const manager = getTriggerManager();
    const fullTriggerId = `${workflowId}:${triggerId}`;
    const trigger = manager.triggers.get(fullTriggerId);

    if (!trigger || trigger.type !== 'webhook') {
      return sendNotFound(res, 'Webhook trigger not found');
    }

    // Verify signature if present
    const signature = req.headers['x-webhook-signature'];
    if (signature && !trigger.verifySignature(JSON.stringify(req.body), signature)) {
      return res.status(401).json({ error: 'Invalid signature' });
    }

    await trigger.fire(req.body || {});
    res.json({ success: true });
  });
}
