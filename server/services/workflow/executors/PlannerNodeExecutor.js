/**
 * Executor for workflow planner nodes.
 *
 * Planner nodes use an LLM to decompose a high-level goal into a structured
 * set of tasks (a plan). The plan is then materialized into a child workflow
 * definition and executed as a sub-workflow.
 *
 * The planner supports:
 * - LLM-driven task decomposition with structured output
 * - Sub-workflow spawning and monitoring
 * - Result synthesis (optional)
 * - Depth limiting to prevent infinite recursion
 *
 * @module services/workflow/executors/PlannerNodeExecutor
 */

import { BaseNodeExecutor } from './BaseNodeExecutor.js';
import ChatService from '../../chat/ChatService.js';
import WorkflowLLMHelper from '../WorkflowLLMHelper.js';
import { SubWorkflowMaterializer } from '../SubWorkflowMaterializer.js';
import { getStateManager } from '../StateManager.js';
import { actionTracker } from '../../../actionTracker.js';
import configCache from '../../../configCache.js';

/**
 * Default maximum number of tasks a planner can generate
 * @constant {number}
 */
const DEFAULT_MAX_TASKS = 10;

/**
 * Default maximum sub-workflow nesting depth
 * @constant {number}
 */
const DEFAULT_MAX_DEPTH = 3;

/**
 * Timeout for polling child workflow completion (30 minutes)
 * @constant {number}
 */
const CHILD_COMPLETION_TIMEOUT = 30 * 60 * 1000;

/**
 * Polling interval when waiting for child workflow completion (ms)
 * @constant {number}
 */
const POLL_INTERVAL = 500;

/**
 * Executor for planner nodes.
 *
 * Planner nodes are responsible for:
 * - Building an LLM prompt that requests a structured task plan
 * - Validating the returned plan (IDs, dependencies, task count)
 * - Materializing the plan into a child workflow definition
 * - Spawning the child workflow via the engine
 * - Polling until the child workflow completes
 * - Returning the consolidated child output
 *
 * @extends BaseNodeExecutor
 *
 * @example
 * // Planner node configuration
 * {
 *   id: 'research-planner',
 *   type: 'planner',
 *   name: { en: 'Research Planner' },
 *   config: {
 *     goal: 'Research the topic: ${$.data.topic}',
 *     system: 'You are a research planning agent.',
 *     maxTasks: 5,
 *     synthesize: true,
 *     maxDepth: 2,
 *     taskTemplate: { tools: [] }
 *   }
 * }
 */
export class PlannerNodeExecutor extends BaseNodeExecutor {
  /**
   * Create a new PlannerNodeExecutor
   * @param {Object} options - Executor options
   */
  constructor(options = {}) {
    super(options);
    this.chatService = options.chatService || new ChatService();
    this.llmHelper = options.llmHelper || new WorkflowLLMHelper();
    this.materializer = options.materializer || new SubWorkflowMaterializer();
  }

  /**
   * Execute the planner node.
   *
   * @param {Object} node - The planner node configuration
   * @param {Object} state - Current workflow state
   * @param {Object} context - Execution context (must include context.engine)
   * @returns {Promise<Object>} Execution result with consolidated child output
   */
  async execute(node, state, context) {
    const { config = {} } = node;
    const {
      goal,
      system,
      maxTasks = DEFAULT_MAX_TASKS,
      executionMode = 'sequential',
      synthesize = false,
      taskTemplate = {},
      maxDepth = DEFAULT_MAX_DEPTH
    } = config;

    const currentDepth = context.depth || 0;
    const executionId = context.executionId;
    const language = context.language || 'en';

    this.logger.info({
      component: 'PlannerNodeExecutor',
      message: `Executing planner node '${node.id}'`,
      nodeId: node.id,
      currentDepth,
      maxDepth
    });

    // Check depth limit
    if (currentDepth >= maxDepth) {
      return this.createErrorResult(
        `Planner node '${node.id}' exceeded maximum depth (${maxDepth}). ` +
          `Current depth: ${currentDepth}.`,
        { nodeId: node.id, currentDepth, maxDepth }
      );
    }

    if (!goal) {
      return this.createErrorResult(`Planner node '${node.id}' requires a 'goal' in config`, {
        nodeId: node.id
      });
    }

    try {
      // Step 1: Resolve goal template variables
      const resolvedGoal = this.resolveTemplateVariables(goal, state);
      const resolvedSystem = system
        ? this.resolveTemplateVariables(system, state)
        : 'You are a task planning agent. Break down the goal into concrete, actionable tasks.';

      // Step 2: Get model
      const model = await this.getModel(config.modelId, context, state);
      if (!model) {
        return this.createErrorResult(
          `Planner node '${node.id}': model not found: ${config.modelId || 'default'}`,
          { nodeId: node.id }
        );
      }

      // Step 3: Call LLM to get structured plan
      const plan = await this.generatePlan({
        goal: resolvedGoal,
        system: resolvedSystem,
        maxTasks,
        executionMode,
        model,
        language,
        context
      });

      // Step 4: Validate plan
      const validationError = this.validatePlan(plan, maxTasks);
      if (validationError) {
        return this.createErrorResult(
          `Planner node '${node.id}': invalid plan - ${validationError}`,
          { nodeId: node.id }
        );
      }

      this.logger.info({
        component: 'PlannerNodeExecutor',
        message: `Plan generated with ${plan.tasks.length} tasks`,
        nodeId: node.id,
        taskCount: plan.tasks.length,
        reasoning: plan.reasoning
      });

      // Step 5: Emit SSE event for UI
      actionTracker.emit('fire-sse', {
        event: 'workflow.plan.created',
        chatId: executionId,
        executionId,
        plan: { tasks: plan.tasks, reasoning: plan.reasoning }
      });

      // Step 6: Materialize plan into workflow definition
      const childWorkflowDef = this.materializer.materialize(
        plan,
        { synthesize, taskTemplate },
        executionId,
        currentDepth
      );

      // Step 7: Spawn child workflow via engine
      if (!context.engine) {
        return this.createErrorResult(
          `Planner node '${node.id}': engine not available in context. ` +
            'Ensure WorkflowEngine passes engine: this in context.',
          { nodeId: node.id }
        );
      }

      const childInitialData = {
        ...state.data,
        _parentExecutionId: executionId,
        _planGoal: resolvedGoal,
        _planTasks: plan.tasks
      };

      const childExecutionId = await context.engine.executeSubWorkflow(
        executionId,
        childWorkflowDef,
        childInitialData,
        {
          depth: currentDepth + 1,
          user: context.user,
          language
        }
      );

      this.logger.info({
        component: 'PlannerNodeExecutor',
        message: `Child workflow spawned`,
        nodeId: node.id,
        childExecutionId
      });

      // Step 8: Poll until child completes
      const stateManager = getStateManager();
      const childFinalState = await this.waitForChildCompletion(
        childExecutionId,
        stateManager,
        context
      );

      if (!childFinalState) {
        return this.createErrorResult(
          `Planner node '${node.id}': child workflow '${childExecutionId}' timed out or disappeared`,
          { nodeId: node.id, childExecutionId }
        );
      }

      if (childFinalState.status === 'failed') {
        const errors = childFinalState.errors || [];
        const lastError = errors[errors.length - 1];
        return this.createErrorResult(
          `Planner node '${node.id}': child workflow failed - ${lastError?.message || 'unknown error'}`,
          { nodeId: node.id, childExecutionId, childErrors: errors }
        );
      }

      // Step 9: Extract and return child output
      const childOutput = this.extractChildOutput(childFinalState, plan);

      return this.createSuccessResult(
        {
          plan: { tasks: plan.tasks, reasoning: plan.reasoning },
          childExecutionId,
          output: childOutput
        },
        {
          stateUpdates: {
            plannerOutput: childOutput,
            [`${node.id}Output`]: childOutput
          }
        }
      );
    } catch (error) {
      this.logger.error({
        component: 'PlannerNodeExecutor',
        message: `Planner node '${node.id}' failed`,
        nodeId: node.id,
        error: error.message,
        stack: error.stack
      });

      return this.createErrorResult(`Planner execution failed: ${error.message}`, {
        nodeId: node.id,
        originalError: error.message
      });
    }
  }

  /**
   * Call the LLM to generate a structured task plan.
   *
   * @param {Object} params - Generation parameters
   * @returns {Promise<Object>} The generated plan { tasks, reasoning }
   * @private
   */
  async generatePlan({ goal, system, maxTasks, executionMode, model, language, context }) {
    const planOutputSchema = {
      type: 'object',
      properties: {
        tasks: {
          type: 'array',
          description: 'List of tasks to execute',
          items: {
            type: 'object',
            properties: {
              id: {
                type: 'string',
                description:
                  'Unique short identifier for this task (e.g., task1, research, analyze)'
              },
              title: { type: 'string', description: 'Short title for the task' },
              description: {
                type: 'string',
                description: 'Detailed description of what this task should do'
              },
              tools: {
                type: 'array',
                items: { type: 'string' },
                description: 'Tool IDs this task needs'
              },
              dependsOn: {
                type: 'array',
                items: { type: 'string' },
                description: 'IDs of tasks that must complete before this one'
              }
            },
            required: ['id', 'title', 'description']
          }
        },
        reasoning: {
          type: 'string',
          description: 'Brief explanation of the task decomposition approach'
        }
      },
      required: ['tasks', 'reasoning']
    };

    const messages = [
      {
        role: 'system',
        content: `${system}\n\nYou must respond with a valid JSON object following the provided schema. Break the goal into ${maxTasks} or fewer concrete tasks. Execution mode: ${executionMode}.`
      },
      {
        role: 'user',
        content: `Goal: ${goal}\n\nCreate a detailed task plan to accomplish this goal. Each task should be specific and actionable. Return a JSON plan with the tasks array and your reasoning.`
      }
    ];

    // Verify API key
    const apiKeyResult = await this.llmHelper.verifyApiKey(model, language);
    if (!apiKeyResult.success) {
      throw new Error(apiKeyResult.error?.message || 'API key verification failed');
    }

    const response = await this.llmHelper.executeStreamingRequest({
      model,
      messages,
      apiKey: apiKeyResult.apiKey,
      options: {
        temperature: 0.3,
        maxTokens: model.tokenLimit || 4096,
        responseSchema: planOutputSchema
      },
      language
    });

    // Parse the structured response
    return this.parsePlanResponse(response.content, planOutputSchema);
  }

  /**
   * Parse the LLM response into a plan object.
   *
   * @param {string} content - Raw LLM response
   * @param {Object} _schema - Expected schema (unused but kept for signature consistency)
   * @returns {Object} Parsed plan { tasks, reasoning }
   * @private
   */
  parsePlanResponse(content, _schema) {
    if (!content) {
      throw new Error('LLM returned empty response for plan generation');
    }

    try {
      // Try direct JSON parse
      if (content.trim().startsWith('{')) {
        return JSON.parse(content.trim());
      }

      // Try JSON in markdown code block
      const jsonBlockMatch = content.match(/```(?:json)?\s*([\s\S]*?)```/);
      if (jsonBlockMatch) {
        return JSON.parse(jsonBlockMatch[1].trim());
      }

      // Try to find JSON object in content
      const jsonMatch = content.match(/\{[\s\S]*\}/);
      if (jsonMatch) {
        return JSON.parse(jsonMatch[0]);
      }

      throw new Error('No JSON found in LLM response');
    } catch (error) {
      this.logger.error({
        component: 'PlannerNodeExecutor',
        message: 'Failed to parse plan response',
        error: error.message,
        content: content.slice(0, 500)
      });
      throw new Error(`Failed to parse plan from LLM: ${error.message}`);
    }
  }

  /**
   * Validate the generated plan.
   *
   * @param {Object} plan - The plan to validate
   * @param {number} maxTasks - Maximum allowed tasks
   * @returns {string|null} Error message or null if valid
   * @private
   */
  validatePlan(plan, maxTasks) {
    if (!plan || typeof plan !== 'object') {
      return 'Plan must be an object';
    }

    if (!Array.isArray(plan.tasks)) {
      return 'Plan must have a tasks array';
    }

    if (plan.tasks.length === 0) {
      return 'Plan must have at least one task';
    }

    if (plan.tasks.length > maxTasks) {
      return `Plan has ${plan.tasks.length} tasks but maximum is ${maxTasks}`;
    }

    // Check for unique IDs
    const ids = plan.tasks.map(t => t.id);
    const uniqueIds = new Set(ids);
    if (uniqueIds.size !== ids.length) {
      return 'Plan tasks must have unique IDs';
    }

    // Check for invalid dependencies
    for (const task of plan.tasks) {
      if (!task.id || typeof task.id !== 'string') {
        return 'Each task must have a string id';
      }
      if (!task.title || typeof task.title !== 'string') {
        return 'Each task must have a string title';
      }
      if (!task.description || typeof task.description !== 'string') {
        return 'Each task must have a string description';
      }
      if (task.dependsOn) {
        for (const depId of task.dependsOn) {
          if (!uniqueIds.has(depId)) {
            return `Task '${task.id}' depends on unknown task '${depId}'`;
          }
        }
      }
    }

    // Check for circular dependencies using DFS
    const tasks = plan.tasks;
    const visited = new Set();
    const inStack = new Set();

    const hasCycle = taskId => {
      if (inStack.has(taskId)) return true;
      if (visited.has(taskId)) return false;
      visited.add(taskId);
      inStack.add(taskId);
      const task = tasks.find(t => t.id === taskId);
      for (const depId of task.dependsOn || []) {
        if (hasCycle(depId)) return true;
      }
      inStack.delete(taskId);
      return false;
    };

    for (const taskId of uniqueIds) {
      if (hasCycle(taskId)) {
        return `Circular dependency detected in task plan involving task '${taskId}'`;
      }
    }

    return null;
  }

  /**
   * Poll the StateManager until the child workflow completes or times out.
   *
   * @param {string} childExecutionId - The child execution ID to poll
   * @param {Object} stateManager - The StateManager instance
   * @param {Object} [context={}] - Execution context (used for abort signal and deadline)
   * @returns {Promise<Object|null>} Final child state or null on timeout
   * @private
   */
  async waitForChildCompletion(childExecutionId, stateManager, context = {}) {
    const start = Date.now();
    const parentDeadline = context.state?.data?._executionDeadline || Infinity;

    while (Date.now() - start < CHILD_COMPLETION_TIMEOUT) {
      // Check parent abort signal
      if (context.abortSignal?.aborted) {
        throw new Error('Parent workflow was cancelled, aborting child wait');
      }

      // Check parent execution deadline
      if (Date.now() >= parentDeadline) {
        throw new Error('Parent workflow deadline exceeded, aborting child wait');
      }

      const childState = await stateManager.get(childExecutionId);

      if (!childState) {
        // State may not be ready yet, keep polling
        await new Promise(r => setTimeout(r, POLL_INTERVAL));
        continue;
      }

      if (childState.status === 'completed' || childState.status === 'failed') {
        return childState;
      }

      await new Promise(r => setTimeout(r, POLL_INTERVAL));
    }

    this.logger.warn({
      component: 'PlannerNodeExecutor',
      message: 'Child workflow polling timed out',
      childExecutionId,
      timeoutMs: CHILD_COMPLETION_TIMEOUT
    });

    return null;
  }

  /**
   * Extract the relevant output from the completed child workflow state.
   *
   * @param {Object} childState - The completed child workflow state
   * @param {Object} plan - The original plan
   * @returns {*} The extracted output
   * @private
   */
  extractChildOutput(childState, plan) {
    const data = childState.data || {};

    // Prefer synthesized output if available
    if (data.synthesizedOutput) {
      return data.synthesizedOutput;
    }

    // Collect all task outputs
    const taskOutputs = {};
    plan.tasks.forEach(task => {
      const varName = `task_${task.id}_output`;
      if (data[varName] !== undefined) {
        taskOutputs[task.id] = data[varName];
      }
    });

    if (Object.keys(taskOutputs).length > 0) {
      return taskOutputs;
    }

    // Fall back to raw node results
    return data.nodeResults || data;
  }

  /**
   * Get model configuration by ID or use default.
   * Mirrors AgentNodeExecutor.getModel() for consistency.
   *
   * @param {string} modelId - Model ID from node config or null
   * @param {Object} context - Execution context
   * @param {Object} state - Current workflow state
   * @returns {Promise<Object|null>} Model configuration or null
   * @private
   */
  async getModel(modelId, context, state) {
    const { data: models } = configCache.getModels();
    if (!models) {
      return null;
    }

    if (modelId) {
      return models.find(m => m.id === modelId);
    }

    const modelOverride = state?.data?._modelOverride;
    if (modelOverride) {
      const overrideModel = models.find(m => m.id === modelOverride);
      if (overrideModel) {
        return overrideModel;
      }
    }

    const workflowDefaultModelId = context.workflow?.config?.defaultModelId;
    if (workflowDefaultModelId) {
      const workflowModel = models.find(m => m.id === workflowDefaultModelId);
      if (workflowModel) {
        return workflowModel;
      }
    }

    if (context.modelId) {
      return models.find(m => m.id === context.modelId);
    }

    return models.find(m => m.default) || models[0];
  }

  /**
   * Resolve template variables in a string (delegates to resolveVariables base method).
   *
   * @param {string} template - Template string with ${...} or {{...}} variables
   * @param {Object} state - Workflow state
   * @returns {string} Resolved string
   * @private
   */
  resolveTemplateVariables(template, state) {
    if (typeof template !== 'string') {
      return template;
    }

    let result = template;

    // Handle ${$.path} style
    result = result.replace(/\$\{(\$\.[^}]+)\}/g, (match, varPath) => {
      const resolved = this.resolveVariable(varPath, state);
      return resolved !== undefined ? String(resolved) : match;
    });

    // Handle {{variable}} style using state.data
    result = result.replace(/\{\{([^#/@}][^}]*)\}\}/g, (match, variable) => {
      const trimmed = variable.trim();
      const parts = trimmed.split('.');
      let current = state.data || {};
      for (const part of parts) {
        if (current === undefined || current === null) {
          return match;
        }
        current = current[part];
      }
      return current !== undefined && current !== null ? String(current) : match;
    });

    return result;
  }
}

export default PlannerNodeExecutor;
