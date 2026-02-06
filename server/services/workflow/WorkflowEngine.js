import { v4 as uuidv4 } from 'uuid';
import { DAGScheduler } from './DAGScheduler.js';
import { StateManager, WorkflowStatus } from './StateManager.js';
import { actionTracker } from '../../actionTracker.js';
import logger from '../../utils/logger.js';

/**
 * Default timeout for node execution in milliseconds (5 minutes)
 * @constant {number}
 */
const DEFAULT_NODE_TIMEOUT = 5 * 60 * 1000;

/**
 * Maximum number of execution iterations to prevent infinite loops
 * @constant {number}
 */
const MAX_EXECUTION_ITERATIONS = 100;

/**
 * WorkflowEngine is the main orchestrator for executing workflow definitions.
 * It coordinates between the DAGScheduler for dependency resolution and
 * StateManager for state persistence, while executing nodes through
 * registered type-specific executors.
 *
 * The engine supports:
 * - Sequential node execution (MVP)
 * - Pause/resume capabilities
 * - Checkpointing for recovery
 * - Event emission for monitoring
 *
 * @example
 * const engine = new WorkflowEngine();
 *
 * // Register executors for different node types
 * engine.registerExecutor('llm', new LLMExecutor());
 * engine.registerExecutor('tool', new ToolExecutor());
 *
 * // Start workflow execution
 * const state = await engine.start(workflowDefinition, { userInput: 'Hello' });
 * console.log('Execution ID:', state.executionId);
 */
export class WorkflowEngine {
  /**
   * Creates a new WorkflowEngine instance
   * @param {Object} options - Configuration options
   * @param {StateManager} [options.stateManager] - Custom state manager instance
   * @param {DAGScheduler} [options.scheduler] - Custom scheduler instance
   * @param {number} [options.defaultTimeout] - Default node execution timeout in ms
   */
  constructor(options = {}) {
    /**
     * State manager for execution state and checkpoints
     * @type {StateManager}
     */
    this.stateManager = options.stateManager || new StateManager();

    /**
     * DAG scheduler for dependency resolution
     * @type {DAGScheduler}
     */
    this.scheduler = options.scheduler || new DAGScheduler();

    /**
     * Registered node executors by type
     * @type {Map<string, Object>}
     * @private
     */
    this.nodeExecutors = new Map();

    /**
     * Default timeout for node execution
     * @type {number}
     */
    this.defaultTimeout = options.defaultTimeout || DEFAULT_NODE_TIMEOUT;

    /**
     * Active abort controllers for cancellation
     * @type {Map<string, AbortController>}
     * @private
     */
    this.abortControllers = new Map();
  }

  /**
   * Registers a node executor for a specific node type.
   * Executors must implement an execute(node, context) method.
   *
   * @param {string} nodeType - The node type identifier (e.g., 'llm', 'tool', 'decision')
   * @param {Object} executor - The executor instance
   * @param {Function} executor.execute - Async function that executes the node
   *
   * @example
   * engine.registerExecutor('llm', {
   *   execute: async (node, context) => {
   *     const result = await callLLM(node.config.prompt, context.data);
   *     return { output: result };
   *   }
   * });
   */
  registerExecutor(nodeType, executor) {
    if (!executor || typeof executor.execute !== 'function') {
      throw new Error(`Executor for type '${nodeType}' must have an execute method`);
    }

    this.nodeExecutors.set(nodeType, executor);

    logger.info({
      component: 'WorkflowEngine',
      message: 'Registered node executor',
      nodeType
    });
  }

  /**
   * Gets a registered executor by node type
   * @param {string} nodeType - The node type identifier
   * @returns {Object|null} The executor or null if not registered
   */
  getExecutor(nodeType) {
    return this.nodeExecutors.get(nodeType) || null;
  }

  /**
   * Starts a new workflow execution
   *
   * @param {Object} workflowDefinition - The workflow definition
   * @param {string} workflowDefinition.id - Workflow identifier
   * @param {Object[]} workflowDefinition.nodes - Array of workflow nodes
   * @param {Object[]} workflowDefinition.edges - Array of workflow edges
   * @param {Object} [initialData={}] - Initial data/context for the workflow
   * @param {Object} [options={}] - Execution options
   * @param {string} [options.executionId] - Custom execution ID (auto-generated if not provided)
   * @param {boolean} [options.checkpointOnNode=false] - Whether to checkpoint after each node
   * @param {number} [options.timeout] - Override default node timeout
   * @param {Object} [options.user] - User context for the execution
   * @returns {Promise<Object>} The initial execution state
   *
   * @example
   * const state = await engine.start(workflowDef, {
   *   userInput: 'Analyze this document',
   *   documentId: 'doc-123'
   * }, {
   *   checkpointOnNode: true
   * });
   */
  async start(workflowDefinition, initialData = {}, options = {}) {
    const executionId = options.executionId || `wf-exec-${uuidv4()}`;
    const workflowId = workflowDefinition.id || 'unknown';

    logger.info({
      component: 'WorkflowEngine',
      message: 'Starting workflow execution',
      executionId,
      workflowId,
      nodeCount: workflowDefinition.nodes?.length || 0
    });

    // 1. Validate workflow has no cycles
    const cycleResult = this.scheduler.detectCycles(
      workflowDefinition.nodes || [],
      workflowDefinition.edges || []
    );

    if (cycleResult.hasCycle) {
      const error = new Error(
        `Workflow contains cycles involving nodes: ${cycleResult.cycleNodes.join(', ')}`
      );
      error.code = 'WORKFLOW_CYCLE_DETECTED';
      throw error;
    }

    // 2. Find start node(s)
    const startNodes = this.scheduler.findStartNodes(workflowDefinition);

    if (startNodes.length === 0) {
      const error = new Error('Workflow has no start nodes');
      error.code = 'WORKFLOW_NO_START_NODE';
      throw error;
    }

    // 3. Create execution state
    const state = await this.stateManager.create({
      executionId,
      workflowId,
      data: {
        ...initialData,
        _workflow: {
          startedBy: options.user?.id || 'anonymous',
          startedAt: new Date().toISOString()
        }
      },
      currentNodes: startNodes
    });

    // 4. Set up abort controller for cancellation
    const abortController = new AbortController();
    this.abortControllers.set(executionId, abortController);

    // 5. Emit workflow start event
    this._emitEvent('workflow.start', {
      executionId,
      workflowId,
      startNodes
    });

    // 6. Begin execution loop (non-blocking)
    this._runExecutionLoop(workflowDefinition, executionId, options, abortController.signal).catch(
      error => {
        logger.error({
          component: 'WorkflowEngine',
          message: 'Workflow execution failed',
          executionId,
          error: error.message,
          stack: error.stack
        });
      }
    );

    // 7. Return initial state (execution continues in background)
    return state;
  }

  /**
   * Main execution loop (sequential for MVP)
   * @param {Object} workflow - The workflow definition
   * @param {string} executionId - The execution identifier
   * @param {Object} options - Execution options
   * @param {AbortSignal} signal - Abort signal for cancellation
   * @private
   */
  async _runExecutionLoop(workflow, executionId, options, signal) {
    let iterationCount = 0;

    try {
      // Update state to running
      await this.stateManager.update(executionId, {
        status: WorkflowStatus.RUNNING,
        startedAt: new Date().toISOString()
      });

      while (iterationCount < MAX_EXECUTION_ITERATIONS) {
        iterationCount++;

        // Check for cancellation
        if (signal.aborted) {
          logger.info({
            component: 'WorkflowEngine',
            message: 'Workflow execution cancelled',
            executionId
          });
          break;
        }

        // Get current state
        const state = await this.stateManager.get(executionId);

        if (!state) {
          throw new Error(`Execution state lost: ${executionId}`);
        }

        // Check if workflow should continue
        if (state.status !== WorkflowStatus.RUNNING) {
          logger.info({
            component: 'WorkflowEngine',
            message: 'Workflow execution stopped',
            executionId,
            status: state.status
          });
          break;
        }

        // Get executable nodes
        const executableNodes = this.scheduler.getExecutableNodes(
          workflow,
          state.currentNodes,
          state.completedNodes
        );

        // If no nodes to execute, check if workflow is complete
        if (executableNodes.length === 0) {
          if (state.currentNodes.length === 0) {
            // Workflow complete
            await this._completeWorkflow(executionId, state);
          } else {
            // Nodes are blocked (shouldn't happen in valid workflow)
            logger.warn({
              component: 'WorkflowEngine',
              message: 'Workflow has blocked nodes',
              executionId,
              blockedNodes: state.currentNodes
            });
          }
          break;
        }

        // Execute nodes sequentially (MVP)
        for (const nodeId of executableNodes) {
          if (signal.aborted) break;

          const node = workflow.nodes.find(n => n.id === nodeId);

          if (!node) {
            logger.error({
              component: 'WorkflowEngine',
              message: 'Node not found in workflow',
              executionId,
              nodeId
            });
            continue;
          }

          try {
            const result = await this.executeNode(node, workflow, executionId, options);

            // Determine next nodes based on result
            const currentState = await this.stateManager.get(executionId);
            const nextNodes = this.scheduler.getNextNodes(nodeId, result, workflow, currentState);

            // Update current nodes (remove completed, add next)
            const newCurrentNodes = [
              ...currentState.currentNodes.filter(id => id !== nodeId),
              ...nextNodes
            ];

            await this.stateManager.update(executionId, {
              currentNodes: newCurrentNodes
            });

            // Checkpoint if configured
            if (options.checkpointOnNode) {
              await this.stateManager.checkpoint(executionId, `after_node_${nodeId}`);
              this._emitEvent('workflow.checkpoint.saved', {
                executionId,
                checkpointId: `after_node_${nodeId}`,
                nodeId
              });
            }
          } catch (nodeError) {
            // Handle node execution error
            await this._handleNodeError(executionId, node, nodeError, options);

            // Check if we should continue or fail the workflow
            const errorState = await this.stateManager.get(executionId);
            if (errorState.status === WorkflowStatus.FAILED) {
              break;
            }
          }
        }
      }

      // Check for max iterations
      if (iterationCount >= MAX_EXECUTION_ITERATIONS) {
        logger.error({
          component: 'WorkflowEngine',
          message: 'Workflow exceeded maximum iterations',
          executionId,
          maxIterations: MAX_EXECUTION_ITERATIONS
        });

        await this.stateManager.update(executionId, {
          status: WorkflowStatus.FAILED
        });

        await this.stateManager.addError(executionId, {
          message: `Workflow exceeded maximum iterations (${MAX_EXECUTION_ITERATIONS})`,
          code: 'MAX_ITERATIONS_EXCEEDED'
        });

        this._emitEvent('workflow.failed', {
          executionId,
          error: { message: 'Maximum iterations exceeded', code: 'MAX_ITERATIONS_EXCEEDED' }
        });
      }
    } catch (error) {
      logger.error({
        component: 'WorkflowEngine',
        message: 'Fatal error in execution loop',
        executionId,
        error: error.message,
        stack: error.stack
      });

      await this.stateManager.update(executionId, {
        status: WorkflowStatus.FAILED
      });

      await this.stateManager.addError(executionId, {
        message: error.message,
        code: error.code || 'EXECUTION_ERROR',
        stack: error.stack
      });

      this._emitEvent('workflow.failed', {
        executionId,
        error: { message: error.message, code: error.code }
      });
    } finally {
      // Cleanup abort controller
      this.abortControllers.delete(executionId);
    }
  }

  /**
   * Executes a single node
   *
   * @param {Object} node - The node to execute
   * @param {string} node.id - Node identifier
   * @param {string} node.type - Node type (e.g., 'llm', 'tool', 'decision')
   * @param {Object} node.config - Node configuration
   * @param {Object} workflow - The workflow definition
   * @param {string} executionId - The execution identifier
   * @param {Object} options - Execution options
   * @returns {Promise<*>} The node execution result
   *
   * @example
   * const result = await engine.executeNode(
   *   { id: 'node-1', type: 'llm', config: { prompt: 'Hello' } },
   *   workflowDef,
   *   'exec-123',
   *   { timeout: 30000 }
   * );
   */
  async executeNode(node, workflow, executionId, options = {}) {
    const { id: nodeId, type: nodeType, config } = node;

    logger.info({
      component: 'WorkflowEngine',
      message: 'Executing node',
      executionId,
      nodeId,
      nodeType
    });

    // 1. Get executor for node type
    const executor = this.getExecutor(nodeType);

    if (!executor) {
      const error = new Error(`No executor registered for node type: ${nodeType}`);
      error.code = 'EXECUTOR_NOT_FOUND';
      throw error;
    }

    // 2. Emit node start event
    this._emitEvent('workflow.node.start', {
      executionId,
      nodeId,
      nodeType
    });

    // 3. Add step to history
    await this.stateManager.addStep(executionId, {
      nodeId,
      type: 'node_start',
      data: { nodeType, configKeys: Object.keys(config || {}) }
    });

    // 4. Get current state for context
    const state = await this.stateManager.get(executionId);

    // 5. Build execution context
    const context = {
      executionId,
      nodeId,
      workflow,
      data: state.data,
      nodeResults: state.data.nodeResults || {},
      user: options.user,
      abortSignal: this.abortControllers.get(executionId)?.signal
    };

    // 6. Execute with timeout
    const timeout = options.timeout || node.timeout || this.defaultTimeout;
    let result;

    try {
      result = await this._executeWithTimeout(
        () => executor.execute(node, context),
        timeout,
        `Node ${nodeId} execution timed out after ${timeout}ms`
      );
    } catch (error) {
      // Re-throw to be handled by caller
      throw error;
    }

    // 7. Update state with result
    await this.stateManager.markNodeCompleted(executionId, nodeId, result);

    // 8. Add step to history
    await this.stateManager.addStep(executionId, {
      nodeId,
      type: 'node_complete',
      data: {
        resultType: typeof result,
        hasOutput: result !== null && result !== undefined
      }
    });

    // 9. Emit node complete event
    this._emitEvent('workflow.node.complete', {
      executionId,
      nodeId,
      result: this._sanitizeForEvent(result)
    });

    logger.info({
      component: 'WorkflowEngine',
      message: 'Node execution completed',
      executionId,
      nodeId
    });

    return result;
  }

  /**
   * Handles node execution error
   * @param {string} executionId - The execution identifier
   * @param {Object} node - The failed node
   * @param {Error} error - The error that occurred
   * @param {Object} options - Execution options
   * @private
   */
  async _handleNodeError(executionId, node, error, _options) {
    const { id: nodeId, type: _nodeType } = node;

    logger.error({
      component: 'WorkflowEngine',
      message: 'Node execution failed',
      executionId,
      nodeId,
      error: error.message
    });

    // Mark node as failed
    await this.stateManager.markNodeFailed(executionId, nodeId, error);

    // Add to history
    await this.stateManager.addStep(executionId, {
      nodeId,
      type: 'node_error',
      data: {
        message: error.message,
        code: error.code
      }
    });

    // Emit error event
    this._emitEvent('workflow.node.error', {
      executionId,
      nodeId,
      error: {
        message: error.message,
        code: error.code
      }
    });

    // Determine if we should fail the entire workflow
    // For MVP, any node failure fails the workflow
    // TODO: Add error handling configuration (retry, skip, fallback)
    const shouldFailWorkflow = true;

    if (shouldFailWorkflow) {
      await this.stateManager.update(executionId, {
        status: WorkflowStatus.FAILED,
        completedAt: new Date().toISOString()
      });

      this._emitEvent('workflow.failed', {
        executionId,
        error: {
          message: `Node ${nodeId} failed: ${error.message}`,
          nodeId,
          code: error.code
        }
      });
    }
  }

  /**
   * Completes a workflow execution
   * @param {string} executionId - The execution identifier
   * @param {Object} state - Current execution state
   * @private
   */
  async _completeWorkflow(executionId, state) {
    logger.info({
      component: 'WorkflowEngine',
      message: 'Workflow execution completed',
      executionId,
      completedNodes: state.completedNodes.length
    });

    await this.stateManager.update(executionId, {
      status: WorkflowStatus.COMPLETED,
      completedAt: new Date().toISOString()
    });

    // Extract output from last node result
    const lastNodeId = state.completedNodes[state.completedNodes.length - 1];
    const output = state.data.nodeResults?.[lastNodeId];

    this._emitEvent('workflow.complete', {
      executionId,
      output: this._sanitizeForEvent(output)
    });
  }

  /**
   * Resumes a paused workflow execution
   *
   * @param {string} executionId - The execution identifier
   * @param {Object} [resumeData={}] - Additional data to merge into state
   * @param {Object} [options={}] - Resume options
   * @returns {Promise<Object>} The current execution state
   *
   * @example
   * // Resume after user provides input
   * const state = await engine.resume('exec-123', {
   *   userResponse: 'Yes, proceed'
   * });
   */
  async resume(executionId, resumeData = {}, options = {}) {
    const state = await this.stateManager.get(executionId);

    if (!state) {
      const error = new Error(`Execution not found: ${executionId}`);
      error.code = 'EXECUTION_NOT_FOUND';
      throw error;
    }

    if (state.status !== WorkflowStatus.PAUSED) {
      const error = new Error(
        `Cannot resume execution with status: ${state.status}. Only paused executions can be resumed.`
      );
      error.code = 'INVALID_STATE_FOR_RESUME';
      throw error;
    }

    logger.info({
      component: 'WorkflowEngine',
      message: 'Resuming workflow execution',
      executionId,
      currentNodes: state.currentNodes
    });

    // Merge resume data into state
    await this.stateManager.update(executionId, {
      status: WorkflowStatus.RUNNING,
      data: {
        ...state.data,
        ...resumeData,
        _resumedAt: new Date().toISOString()
      }
    });

    // Set up new abort controller
    const abortController = new AbortController();
    this.abortControllers.set(executionId, abortController);

    // Get workflow definition from state or options
    const workflow = options.workflow || state.data._workflowDefinition;

    if (!workflow) {
      const error = new Error(
        'Workflow definition not available. Provide it in options or ensure it was stored in state.'
      );
      error.code = 'WORKFLOW_NOT_AVAILABLE';
      throw error;
    }

    // Continue execution loop
    this._runExecutionLoop(workflow, executionId, options, abortController.signal).catch(error => {
      logger.error({
        component: 'WorkflowEngine',
        message: 'Resumed workflow execution failed',
        executionId,
        error: error.message
      });
    });

    return this.stateManager.get(executionId);
  }

  /**
   * Pauses a running workflow execution
   *
   * @param {string} executionId - The execution identifier
   * @param {string} [reason='user_requested'] - Reason for pausing
   * @returns {Promise<Object>} The current execution state
   */
  async pause(executionId, reason = 'user_requested') {
    const state = await this.stateManager.get(executionId);

    if (!state) {
      const error = new Error(`Execution not found: ${executionId}`);
      error.code = 'EXECUTION_NOT_FOUND';
      throw error;
    }

    if (state.status !== WorkflowStatus.RUNNING) {
      const error = new Error(
        `Cannot pause execution with status: ${state.status}. Only running executions can be paused.`
      );
      error.code = 'INVALID_STATE_FOR_PAUSE';
      throw error;
    }

    logger.info({
      component: 'WorkflowEngine',
      message: 'Pausing workflow execution',
      executionId,
      reason
    });

    // Update state to paused
    await this.stateManager.update(executionId, {
      status: WorkflowStatus.PAUSED
    });

    // Create checkpoint
    await this.stateManager.checkpoint(executionId, `pause_${reason}`);

    // Emit pause event
    this._emitEvent('workflow.paused', {
      executionId,
      nodeId: state.currentNodes[0],
      reason
    });

    return this.stateManager.get(executionId);
  }

  /**
   * Cancels a running or paused workflow execution
   *
   * @param {string} executionId - The execution identifier
   * @param {string} [reason='user_cancelled'] - Reason for cancellation
   * @returns {Promise<Object>} The final execution state
   *
   * @example
   * await engine.cancel('exec-123', 'User requested cancellation');
   */
  async cancel(executionId, reason = 'user_cancelled') {
    const state = await this.stateManager.get(executionId);

    if (!state) {
      const error = new Error(`Execution not found: ${executionId}`);
      error.code = 'EXECUTION_NOT_FOUND';
      throw error;
    }

    if (state.status === WorkflowStatus.COMPLETED || state.status === WorkflowStatus.CANCELLED) {
      logger.warn({
        component: 'WorkflowEngine',
        message: 'Cannot cancel execution in terminal state',
        executionId,
        status: state.status
      });
      return state;
    }

    logger.info({
      component: 'WorkflowEngine',
      message: 'Cancelling workflow execution',
      executionId,
      reason
    });

    // Abort any running node execution
    const abortController = this.abortControllers.get(executionId);
    if (abortController) {
      abortController.abort();
      this.abortControllers.delete(executionId);
    }

    // Update state to cancelled
    await this.stateManager.update(executionId, {
      status: WorkflowStatus.CANCELLED,
      completedAt: new Date().toISOString()
    });

    // Record cancellation reason
    await this.stateManager.addStep(executionId, {
      nodeId: null,
      type: 'workflow_cancelled',
      data: { reason }
    });

    // Emit cancelled event
    this._emitEvent('workflow.cancelled', {
      executionId,
      reason
    });

    return this.stateManager.get(executionId);
  }

  /**
   * Gets the current state of an execution
   *
   * @param {string} executionId - The execution identifier
   * @returns {Promise<Object|null>} The execution state or null if not found
   */
  async getState(executionId) {
    return this.stateManager.get(executionId);
  }

  /**
   * Lists all active workflow executions
   * @returns {Promise<Object[]>} Array of execution summaries
   */
  async listActiveExecutions() {
    return this.stateManager.getActiveSummaries();
  }

  /**
   * Executes a function with a timeout
   * @param {Function} fn - The async function to execute
   * @param {number} timeout - Timeout in milliseconds
   * @param {string} timeoutMessage - Error message on timeout
   * @returns {Promise<*>} The function result
   * @private
   */
  async _executeWithTimeout(fn, timeout, timeoutMessage) {
    return new Promise(async (resolve, reject) => {
      const timeoutId = setTimeout(() => {
        const error = new Error(timeoutMessage);
        error.code = 'NODE_TIMEOUT';
        reject(error);
      }, timeout);

      try {
        const result = await fn();
        clearTimeout(timeoutId);
        resolve(result);
      } catch (error) {
        clearTimeout(timeoutId);
        reject(error);
      }
    });
  }

  /**
   * Emits a workflow event via actionTracker
   * @param {string} eventType - The event type
   * @param {Object} data - Event data
   * @private
   */
  _emitEvent(eventType, data) {
    // Use the executionId as the chatId for consistency with actionTracker
    const chatId = data.executionId;

    actionTracker.emit('fire-sse', {
      event: eventType,
      chatId,
      ...data
    });

    logger.debug({
      component: 'WorkflowEngine',
      message: 'Emitted workflow event',
      eventType,
      executionId: data.executionId
    });
  }

  /**
   * Sanitizes a value for inclusion in events (removes large data)
   * @param {*} value - The value to sanitize
   * @returns {*} Sanitized value
   * @private
   */
  _sanitizeForEvent(value) {
    if (value === null || value === undefined) {
      return value;
    }

    // Convert to JSON to check size
    try {
      const json = JSON.stringify(value);
      if (json.length > 1024) {
        // Truncate large values
        return {
          _truncated: true,
          _type: typeof value,
          _size: json.length,
          _preview: json.substring(0, 200) + '...'
        };
      }
      return value;
    } catch {
      return { _error: 'Could not serialize value' };
    }
  }
}

export default WorkflowEngine;
