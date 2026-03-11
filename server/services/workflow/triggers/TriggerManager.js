import logger from '../../../utils/logger.js';
import { ScheduleTrigger } from './ScheduleTrigger.js';
import { WebhookTrigger } from './WebhookTrigger.js';

export class TriggerManager {
  constructor() {
    this.triggers = new Map(); // triggerId -> trigger instance
    this.engine = null; // set via setEngine()
  }

  setEngine(engine) {
    this.engine = engine;
  }

  // Register triggers from a workflow definition
  async registerWorkflowTriggers(workflow) {
    if (!workflow.triggers || !Array.isArray(workflow.triggers)) return;

    for (const triggerConfig of workflow.triggers) {
      await this.registerTrigger(workflow.id, triggerConfig);
    }
  }

  // Unregister all triggers for a workflow
  async unregisterWorkflowTriggers(workflowId) {
    for (const [triggerId, trigger] of this.triggers.entries()) {
      if (trigger.workflowId === workflowId) {
        await trigger.stop();
        this.triggers.delete(triggerId);
      }
    }
  }

  async registerTrigger(workflowId, triggerConfig) {
    const triggerId = `${workflowId}:${triggerConfig.id}`;

    // Stop existing trigger if any
    if (this.triggers.has(triggerId)) {
      await this.triggers.get(triggerId).stop();
    }

    let trigger;
    if (triggerConfig.type === 'schedule') {
      trigger = new ScheduleTrigger(triggerId, workflowId, triggerConfig, this);
    } else if (triggerConfig.type === 'webhook') {
      trigger = new WebhookTrigger(triggerId, workflowId, triggerConfig, this);
    } else {
      logger.warn({
        component: 'TriggerManager',
        message: `Unknown trigger type: ${triggerConfig.type}`
      });
      return;
    }

    this.triggers.set(triggerId, trigger);
    await trigger.start();
    logger.info({ component: 'TriggerManager', message: `Registered trigger ${triggerId}` });
  }

  // Called by triggers when they fire - executes the workflow
  async fireTrigger(triggerId, initialData = {}) {
    const trigger = this.triggers.get(triggerId);
    if (!trigger) return;

    if (!this.engine) {
      logger.error({
        component: 'TriggerManager',
        message: 'No engine set, cannot fire trigger',
        triggerId
      });
      return;
    }

    // Load workflow definition (via workflowRoutes loadWorkflows)
    try {
      const { loadWorkflows } = await import('../../../routes/workflow/workflowRoutes.js');
      const workflows = await loadWorkflows();
      const workflow = workflows.find(w => w.id === trigger.workflowId);

      if (!workflow) {
        logger.error({
          component: 'TriggerManager',
          message: 'Workflow not found for trigger',
          triggerId,
          workflowId: trigger.workflowId
        });
        return;
      }

      await this.engine.start(
        workflow,
        {
          ...initialData,
          _trigger: { id: triggerId, type: trigger.type, firedAt: new Date().toISOString() }
        },
        { user: { id: 'trigger-system', role: 'system' } }
      );

      logger.info({ component: 'TriggerManager', message: `Fired trigger ${triggerId}` });
    } catch (error) {
      logger.error({
        component: 'TriggerManager',
        message: 'Failed to fire trigger',
        triggerId,
        error: error.message
      });
    }
  }

  // Get all triggers info
  getTriggersInfo() {
    const result = [];
    for (const [id, trigger] of this.triggers.entries()) {
      result.push({
        id,
        workflowId: trigger.workflowId,
        type: trigger.type,
        active: trigger.active
      });
    }
    return result;
  }

  async stopAll() {
    for (const trigger of this.triggers.values()) {
      await trigger.stop();
    }
    this.triggers.clear();
  }
}

// Singleton
let _instance = null;
export function getTriggerManager() {
  if (!_instance) _instance = new TriggerManager();
  return _instance;
}

export default TriggerManager;
