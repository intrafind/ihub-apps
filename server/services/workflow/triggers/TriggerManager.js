/**
 * TriggerManager
 *
 * Central registry that owns all active workflow triggers (schedules and webhooks).
 * It connects triggers to the WorkflowEngine so that fired triggers automatically
 * start a new workflow execution.
 *
 * Uses a singleton pattern via getTriggerManager() / resetTriggerManager().
 *
 * @module services/workflow/triggers/TriggerManager
 */

import { ScheduleTrigger } from './ScheduleTrigger.js';
import { WebhookTrigger } from './WebhookTrigger.js';
import logger from '../../../utils/logger.js';

/** @type {TriggerManager|null} */
let triggerManagerInstance = null;

/**
 * Returns the singleton TriggerManager instance, creating it if needed.
 *
 * @returns {TriggerManager}
 */
export function getTriggerManager() {
  if (!triggerManagerInstance) {
    triggerManagerInstance = new TriggerManager();
  }
  return triggerManagerInstance;
}

/**
 * Tears down the singleton instance, stopping all active triggers.
 * Useful for tests and graceful shutdown.
 */
export function resetTriggerManager() {
  if (triggerManagerInstance) {
    triggerManagerInstance.unregisterAll();
  }
  triggerManagerInstance = null;
}

/**
 * Manages the lifecycle of all workflow triggers.
 *
 * Responsibilities:
 * - Register / unregister triggers when workflows are created, updated, or deleted
 * - Fire triggers by starting a new workflow execution via the WorkflowEngine
 * - Maintain a lookup map for webhook triggers so incoming HTTP requests can be routed
 *
 * @example
 * const manager = getTriggerManager();
 * manager.setEngine(engine);
 * manager.setWorkflowLoader(loadWorkflows);
 * manager.registerWorkflowTriggers(workflow);
 */
export class TriggerManager {
  constructor() {
    /** @type {Map<string, Array<ScheduleTrigger|WebhookTrigger>>} workflowId -> trigger instances */
    this.triggers = new Map();
    /** @type {Map<string, {trigger: WebhookTrigger, workflowId: string}>} triggerId -> ref */
    this.webhookTriggers = new Map();
    /** @type {import('../WorkflowEngine.js').WorkflowEngine|null} */
    this.engine = null;
    /** @type {Function|null} Async function that returns workflow definitions */
    this.workflowLoader = null;
  }

  /**
   * Connects this manager to a WorkflowEngine instance so fired triggers
   * can start workflow executions.
   *
   * @param {import('../WorkflowEngine.js').WorkflowEngine} engine
   */
  setEngine(engine) {
    this.engine = engine;
  }

  /**
   * Sets the function used to reload workflow definitions from disk.
   *
   * @param {Function} loader - Async function (includeDisabled: boolean) => Workflow[]
   */
  setWorkflowLoader(loader) {
    this.workflowLoader = loader;
  }

  /**
   * Registers all triggers defined in a workflow's `triggers` array.
   * Any previously registered triggers for the same workflow are stopped first.
   *
   * @param {Object} workflow - Workflow definition with an optional `triggers` array
   * @param {string} workflow.id - Unique workflow identifier
   * @param {Object[]} [workflow.triggers] - Trigger configurations
   */
  registerWorkflowTriggers(workflow) {
    if (!workflow.triggers?.length) return;

    // Unregister existing triggers for this workflow first
    this.unregisterWorkflowTriggers(workflow.id);

    const instances = [];

    for (const triggerConfig of workflow.triggers) {
      try {
        if (triggerConfig.type === 'schedule') {
          const trigger = new ScheduleTrigger(triggerConfig, () => {
            this.fireTrigger(workflow.id, triggerConfig);
          });
          instances.push(trigger);
        } else if (triggerConfig.type === 'webhook') {
          const trigger = new WebhookTrigger(triggerConfig);
          instances.push(trigger);
          this.webhookTriggers.set(triggerConfig.id, {
            trigger,
            workflowId: workflow.id
          });
        }
      } catch (error) {
        logger.error({
          component: 'TriggerManager',
          message: `Failed to register trigger '${triggerConfig.id}' for workflow '${workflow.id}'`,
          error: error.message
        });
      }
    }

    if (instances.length > 0) {
      this.triggers.set(workflow.id, instances);
      logger.info({
        component: 'TriggerManager',
        message: `Registered ${instances.length} triggers for workflow '${workflow.id}'`,
        workflowId: workflow.id
      });
    }
  }

  /**
   * Stops and removes all triggers associated with a given workflow.
   *
   * @param {string} workflowId - The workflow whose triggers should be removed
   */
  unregisterWorkflowTriggers(workflowId) {
    const instances = this.triggers.get(workflowId);
    if (instances) {
      instances.forEach(t => t.stop?.());
      // Clean up webhook trigger references
      for (const [triggerId, ref] of this.webhookTriggers) {
        if (ref.workflowId === workflowId) {
          this.webhookTriggers.delete(triggerId);
        }
      }
      this.triggers.delete(workflowId);
    }
  }

  /**
   * Stops and removes ALL registered triggers across all workflows.
   * Called during shutdown or reset.
   */
  unregisterAll() {
    for (const [workflowId] of this.triggers) {
      this.unregisterWorkflowTriggers(workflowId);
    }
  }

  /**
   * Fires a trigger by starting a new workflow execution.
   * Reloads the workflow definition from disk to ensure the latest version is used.
   *
   * @param {string} workflowId - ID of the workflow to execute
   * @param {Object} trigger - Trigger metadata
   * @param {string} trigger.id - Trigger identifier
   * @param {string} trigger.type - Trigger type ('schedule', 'webhook', 'manual')
   * @param {Object} [trigger.initialData] - Data to pass as initial workflow input
   */
  async fireTrigger(workflowId, trigger) {
    if (!this.engine) {
      logger.error({
        component: 'TriggerManager',
        message: 'Cannot fire trigger: engine not set',
        workflowId
      });
      return;
    }

    try {
      let workflow;
      if (this.workflowLoader) {
        const workflows = await this.workflowLoader(false);
        workflow = workflows.find(w => w.id === workflowId);
      }

      if (!workflow) {
        logger.error({
          component: 'TriggerManager',
          message: `Workflow not found: ${workflowId}`,
          workflowId
        });
        return;
      }

      logger.info({
        component: 'TriggerManager',
        message: `Firing trigger for workflow '${workflowId}'`,
        triggerId: trigger.id,
        triggerType: trigger.type
      });

      await this.engine.start(workflow, trigger.initialData || {}, {
        user: { id: 'system', name: 'System Trigger', groups: ['admin'] },
        chatId: `trigger-${Date.now()}`
      });
    } catch (error) {
      logger.error({
        component: 'TriggerManager',
        message: `Failed to fire trigger for workflow '${workflowId}'`,
        error: error.message
      });
    }
  }

  /**
   * Looks up a registered webhook trigger by its ID.
   *
   * @param {string} triggerId - The trigger ID to look up
   * @returns {{trigger: WebhookTrigger, workflowId: string}|undefined}
   */
  getWebhookTrigger(triggerId) {
    return this.webhookTriggers.get(triggerId);
  }

  /**
   * Returns a snapshot of all active triggers across all workflows.
   *
   * @returns {Object[]} Array of trigger info objects with workflowId, type, config, and nextRun
   */
  getActiveTriggers() {
    const result = [];
    for (const [workflowId, instances] of this.triggers) {
      for (const instance of instances) {
        result.push({
          workflowId,
          type: instance instanceof ScheduleTrigger ? 'schedule' : 'webhook',
          config: instance.config,
          nextRun: instance.getNextRun?.() || null
        });
      }
    }
    return result;
  }
}

export default TriggerManager;
