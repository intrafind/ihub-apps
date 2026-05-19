/**
 * PlannerNodeExecutor
 *
 * Executes 'planner' type nodes in the workflow DAG. A planner node uses an
 * LLM to decompose a high-level goal into a structured plan of tasks, then
 * materializes that plan into a sub-workflow and executes it via the engine.
 *
 * Flow:
 * 1. Resolve the goal string from config (supports variable substitution)
 * 2. Call LLM to generate a structured task plan (JSON)
 * 3. Validate the plan (unique IDs, dependency integrity, cycle detection)
 * 4. Materialize the plan into a workflow definition via SubWorkflowMaterializer
 * 5. Execute the sub-workflow via context.engine.executeSubWorkflow()
 * 6. Poll for child completion and return aggregated results
 *
 * @module services/workflow/executors/PlannerNodeExecutor
 */

import { BaseNodeExecutor } from './BaseNodeExecutor.js';
import WorkflowLLMHelper from '../WorkflowLLMHelper.js';
import { SubWorkflowMaterializer } from '../SubWorkflowMaterializer.js';
import configCache from '../../../configCache.js';
import { actionTracker } from '../../../actionTracker.js';

export class PlannerNodeExecutor extends BaseNodeExecutor {
  /**
   * Create a new PlannerNodeExecutor
   * @param {Object} options - Executor options
   * @param {WorkflowLLMHelper} [options.llmHelper] - LLM helper instance for API calls
   */
  constructor(options = {}) {
    super(options);
    this.llmHelper = options.llmHelper || new WorkflowLLMHelper();
  }

  /**
   * Execute the planner node: generate a plan and optionally run it as a sub-workflow.
   *
   * @param {Object} node - The planner node configuration
   * @param {Object} node.config - Node-specific config
   * @param {string} node.config.goal - The high-level goal to decompose (supports variable refs)
   * @param {number} [node.config.maxTasks=10] - Maximum number of tasks in the plan
   * @param {number} [node.config.maxDepth=3] - Maximum sub-workflow nesting depth
   * @param {boolean} [node.config.synthesize] - Whether to add a synthesizer node
   * @param {Object} [node.config.taskTemplate] - Default config applied to each task node
   * @param {string} [node.config.modelId] - Model ID for the planning LLM call
   * @param {string} [node.config.system] - Custom system prompt for the planner
   * @param {string} [node.config.outputVariable] - State key to store the final result
   * @param {Object} state - Current workflow execution state
   * @param {Object} context - Execution context with engine, user, chatId, etc.
   * @returns {Promise<Object>} Execution result with plan and optional sub-workflow results
   */
  async execute(node, state, context) {
    const { config = {} } = node;
    const maxDepth = config.maxDepth ?? 3;
    const currentDepth = context.depth || 0;

    // Guard against excessive sub-workflow nesting
    if (currentDepth >= maxDepth) {
      return this.createErrorResult(`Sub-workflow depth limit (${maxDepth}) exceeded`, {
        nodeId: node.id,
        currentDepth,
        maxDepth
      });
    }

    try {
      // Resolve goal with template variables from state
      const goal = this.resolveVariables(config.goal, state);
      if (!goal) {
        return this.createErrorResult('Planner goal is required', { nodeId: node.id });
      }

      // Generate structured plan via LLM
      const plan = await this._generatePlan(goal, config, state, context);

      // Validate plan structure and dependencies
      const validationError = this._validatePlan(plan, config.maxTasks || 10);
      if (validationError) {
        return this.createErrorResult(`Invalid plan: ${validationError}`, { nodeId: node.id });
      }

      // Emit SSE event so the UI can display the plan
      actionTracker.emit('fire-sse', {
        event: 'workflow.plan.created',
        chatId: context.chatId,
        data: { plan: { tasks: plan.tasks, reasoning: plan.reasoning }, nodeId: node.id }
      });

      // Materialize the plan into a runnable workflow definition
      const workflowDef = SubWorkflowMaterializer.materialize(plan, config, currentDepth);

      // Execute sub-workflow if the engine reference is available
      if (context.engine) {
        const parentExecutionId = state.executionId;
        const childExecutionId = await context.engine.executeSubWorkflow(
          parentExecutionId,
          workflowDef,
          { ...state.data, _planGoal: goal },
          {
            depth: currentDepth + 1,
            maxDepth,
            user: context.user,
            chatId: context.chatId,
            appConfig: context.appConfig,
            language: context.language
          }
        );

        // Wait for child workflow to complete
        const childResult = await this._waitForChildCompletion(childExecutionId, context);

        if (childResult.status === 'failed') {
          return this.createErrorResult('Sub-workflow failed', {
            nodeId: node.id,
            childExecutionId,
            errors: childResult.errors
          });
        }

        return this.createSuccessResult(
          {
            plan,
            childExecutionId,
            results: childResult.data?.nodeResults || {},
            synthesizedResult: childResult.data?.synthesized_result
          },
          {
            stateUpdates: {
              planCreated: { tasks: plan.tasks, reasoning: plan.reasoning },
              ...(config.outputVariable
                ? {
                    [config.outputVariable]:
                      childResult.data?.synthesized_result || childResult.data?.nodeResults
                  }
                : {})
            }
          }
        );
      }

      // No engine available - return plan only (useful for dry-run or testing)
      return this.createSuccessResult(
        { plan },
        {
          stateUpdates: {
            planCreated: { tasks: plan.tasks, reasoning: plan.reasoning }
          }
        }
      );
    } catch (error) {
      return this.createErrorResult(`Planner failed: ${error.message}`, {
        nodeId: node.id,
        error: error.message
      });
    }
  }

  /**
   * Generate a structured task plan by calling the LLM.
   *
   * @param {string} goal - The resolved goal string
   * @param {Object} config - Planner node config
   * @param {Object} state - Current workflow state
   * @param {Object} context - Execution context
   * @returns {Promise<Object>} Parsed plan with tasks array and reasoning
   * @throws {Error} If no model is available or LLM response cannot be parsed
   * @private
   */
  async _generatePlan(goal, config, state, context) {
    const { language = 'en' } = context;

    // Resolve which model to use for planning
    const { data: models } = configCache.getModels();
    const model =
      models?.find(m => m.id === config.modelId) || models?.find(m => m.default) || models?.[0];

    if (!model) {
      throw new Error('No model available for planning');
    }

    // Verify API key before making the request
    const apiKeyResult = await this.llmHelper.verifyApiKey(model, language);
    if (!apiKeyResult.success) {
      throw new Error(apiKeyResult.error?.message || 'API key verification failed');
    }

    const systemPrompt =
      config.system ||
      `You are a task planner. Given a goal, break it down into concrete, actionable tasks.
Each task should be independently executable by an AI agent.
Return a structured JSON plan.`;

    // Build context summary from state data (exclude internal keys)
    const contextData = Object.entries(state.data || {})
      .filter(([k]) => !k.startsWith('_'))
      .map(([k, v]) => `${k}: ${typeof v === 'object' ? JSON.stringify(v) : v}`)
      .join('\n');

    const userPrompt = `Goal: ${goal}

${contextData ? `Available context:\n${contextData}\n` : ''}
Create a plan with up to ${config.maxTasks || 10} tasks. Return JSON:
{
  "tasks": [
    {
      "id": "unique-task-id",
      "title": "Task title",
      "description": "Detailed description of what this task should accomplish",
      "tools": [],
      "dependsOn": []
    }
  ],
  "reasoning": "Brief explanation of the plan"
}`;

    const messages = [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: userPrompt }
    ];

    const response = await this.llmHelper.executeStreamingRequest({
      model,
      messages,
      apiKey: apiKeyResult.apiKey,
      options: { temperature: 0.7 },
      language
    });

    // Extract and parse JSON from the LLM response
    const content = response.content || '';
    try {
      const jsonMatch = content.match(/\{[\s\S]*\}/);
      if (jsonMatch) {
        return JSON.parse(jsonMatch[0]);
      }
      throw new Error('No JSON found in LLM response');
    } catch (e) {
      throw new Error(`Failed to parse plan: ${e.message}`);
    }
  }

  /**
   * Validate a plan for structural correctness.
   *
   * Checks:
   * - tasks array exists and is non-empty
   * - task count does not exceed maxTasks
   * - all task IDs are unique
   * - all dependency references point to existing tasks
   * - no circular dependencies exist
   *
   * @param {Object} plan - The plan to validate
   * @param {number} maxTasks - Maximum allowed number of tasks
   * @returns {string|null} Error message if invalid, null if valid
   * @private
   */
  _validatePlan(plan, maxTasks) {
    if (!plan || !Array.isArray(plan.tasks)) {
      return 'Plan must contain a tasks array';
    }
    if (plan.tasks.length === 0) {
      return 'Plan must contain at least one task';
    }
    if (plan.tasks.length > maxTasks) {
      return `Plan exceeds max tasks limit (${plan.tasks.length} > ${maxTasks})`;
    }

    // Check unique task IDs
    const ids = new Set();
    for (const task of plan.tasks) {
      if (!task.id) return 'All tasks must have an id';
      if (ids.has(task.id)) return `Duplicate task ID: ${task.id}`;
      ids.add(task.id);
    }

    // Check that all dependency references point to existing tasks
    for (const task of plan.tasks) {
      if (task.dependsOn) {
        for (const dep of task.dependsOn) {
          if (!ids.has(dep)) return `Task ${task.id} depends on non-existent task: ${dep}`;
        }
      }
    }

    // DFS cycle detection on task dependencies
    const visited = new Set();
    const recursionStack = new Set();

    const hasCycle = taskId => {
      visited.add(taskId);
      recursionStack.add(taskId);

      const task = plan.tasks.find(t => t.id === taskId);
      for (const dep of task?.dependsOn || []) {
        if (!visited.has(dep)) {
          if (hasCycle(dep)) return true;
        } else if (recursionStack.has(dep)) {
          return true;
        }
      }

      recursionStack.delete(taskId);
      return false;
    };

    for (const task of plan.tasks) {
      if (!visited.has(task.id)) {
        if (hasCycle(task.id)) return 'Circular dependency detected in task plan';
      }
    }

    return null; // valid
  }

  /**
   * Poll the StateManager until the child sub-workflow reaches a terminal state.
   *
   * @param {string} childExecutionId - The execution ID of the child workflow
   * @param {Object} context - Execution context (for abort signal and deadline checks)
   * @returns {Promise<Object>} The final child execution state
   * @throws {Error} If aborted, deadline exceeded, or timeout reached
   * @private
   */
  async _waitForChildCompletion(childExecutionId, context) {
    const { getStateManager } = await import('../StateManager.js');
    const stateManager = getStateManager();

    const pollInterval = 1000; // 1 second
    const maxWait = 30 * 60 * 1000; // 30 minutes
    const startTime = Date.now();

    while (true) {
      // Check abort signal
      if (context.abortSignal?.aborted) {
        throw new Error('Planner aborted');
      }

      // Check parent execution deadline
      if (
        context.initialData?._executionDeadline &&
        Date.now() > context.initialData._executionDeadline
      ) {
        throw new Error('Parent execution deadline exceeded');
      }

      const childState = await stateManager.get(childExecutionId);
      if (childState) {
        if (
          childState.status === 'completed' ||
          childState.status === 'failed' ||
          childState.status === 'cancelled'
        ) {
          return childState;
        }
      }

      if (Date.now() - startTime > maxWait) {
        throw new Error('Sub-workflow timed out');
      }

      await new Promise(resolve => setTimeout(resolve, pollInterval));
    }
  }
}

export default PlannerNodeExecutor;
