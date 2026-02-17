import { v4 as uuidv4 } from 'uuid';
import { DAGScheduler } from './DAGScheduler.js';
import { getStateManager, WorkflowStatus } from './StateManager.js';
import { getExecutor as getDefaultExecutor } from './executors/index.js';
import { getExecutionRegistry } from './ExecutionRegistry.js';
import { actionTracker } from '../../actionTracker.js';
import logger from '../../utils/logger.js';

/**
 * Default timeout for node execution in milliseconds (5 minutes)
 * @constant {number}
 */
const DEFAULT_NODE_TIMEOUT = 5 * 60 * 1000;

/**
 * Minimum allowed timeout for node execution in milliseconds
 * @constant {number}
 */
const MIN_NODE_TIMEOUT = 1000; // 1 second

/**
 * Maximum allowed timeout for node execution in milliseconds (30 minutes)
 * @constant {number}
 */
const MAX_NODE_TIMEOUT = 30 * 60 * 1000;

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
    this.stateManager = options.stateManager || getStateManager();

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
   * Gets a registered executor by node type.
   * First checks custom registered executors, then falls back to default executors.
   * @param {string} nodeType - The node type identifier
   * @returns {Object|null} The executor or null if not registered
   */
  getExecutor(nodeType) {
    // Check for custom registered executor first
    const customExecutor = this.nodeExecutors.get(nodeType);
    if (customExecutor) {
      return customExecutor;
    }

    // Fall back to default executor from executors module
    try {
      return getDefaultExecutor(nodeType);
    } catch {
      return null;
    }
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

    // 1. Check for cycles (configurable - defaults to allowing cycles)
    const allowCycles = workflowDefinition.config?.allowCycles !== false;
    const cycleResult = this.scheduler.detectCycles(
      workflowDefinition.nodes || [],
      workflowDefinition.edges || [],
      { allowCycles }
    );

    if (cycleResult.hasCycle) {
      if (allowCycles) {
        // Cycles are allowed - log for informational purposes
        logger.info({
          component: 'WorkflowEngine',
          message: 'Workflow contains intentional cycles (loops enabled)',
          executionId,
          cycleNodes: cycleResult.cycleNodes,
          maxIterations: workflowDefinition.config?.maxIterations || 10
        });
      } else {
        // Strict DAG mode - reject cycles
        const error = new Error(
          `Workflow contains cycles involving nodes: ${cycleResult.cycleNodes.join(', ')}`
        );
        error.code = 'WORKFLOW_CYCLE_DETECTED';
        throw error;
      }
    }

    // 2. Find start node(s)
    const startNodes = this.scheduler.findStartNodes(workflowDefinition);

    if (startNodes.length === 0) {
      const error = new Error('Workflow has no start nodes');
      error.code = 'WORKFLOW_NO_START_NODE';
      throw error;
    }

    // 3. Calculate execution deadline from maxExecutionTime config
    const maxExecutionTime = workflowDefinition.config?.maxExecutionTime || 300000;
    const executionDeadline = Date.now() + maxExecutionTime;

    // 4. Create execution state
    const state = await this.stateManager.create({
      executionId,
      workflowId,
      data: {
        ...initialData,
        _workflow: {
          startedBy: options.user?.id || 'anonymous',
          startedAt: new Date().toISOString()
        },
        _executionDeadline: executionDeadline
      },
      currentNodes: startNodes
    });

    // 5. Set up abort controller for cancellation
    const abortController = new AbortController();
    this.abortControllers.set(executionId, abortController);

    // 6. Emit workflow start event
    this._emitEvent('workflow.start', {
      executionId,
      workflowId,
      startNodes
    });

    // 7. Begin execution loop (non-blocking)
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

    // 8. Return initial state (execution continues in background)
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

      // Update execution registry
      const registry = getExecutionRegistry();
      registry.updateStatus(executionId, WorkflowStatus.RUNNING);

      while (iterationCount < MAX_EXECUTION_ITERATIONS) {
        iterationCount++;

        // Emit iteration progress event for debugging
        this._emitEvent('workflow.iteration', {
          executionId,
          iteration: iterationCount,
          maxIterations: MAX_EXECUTION_ITERATIONS
        });

        logger.debug({
          component: 'WorkflowEngine',
          message: `Workflow iteration ${iterationCount}`,
          executionId,
          iteration: iterationCount
        });

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

        // Check for execution deadline (maxExecutionTime)
        const executionDeadline = state.data?._executionDeadline;
        if (executionDeadline && Date.now() >= executionDeadline) {
          logger.error({
            component: 'WorkflowEngine',
            message: 'Workflow exceeded maximum execution time',
            executionId
          });

          await this.stateManager.update(executionId, {
            status: WorkflowStatus.FAILED,
            completedAt: new Date().toISOString()
          });

          await this.stateManager.addError(executionId, {
            message: 'Workflow exceeded maximum execution time',
            code: 'MAX_EXECUTION_TIME_EXCEEDED'
          });

          // Persist failed state to disk
          await this.stateManager.checkpoint(executionId, 'timeout_failure');

          const registry = getExecutionRegistry();
          registry.updateStatus(executionId, WorkflowStatus.FAILED, { currentNode: null });

          this._emitEvent('workflow.failed', {
            executionId,
            error: {
              message: 'Maximum execution time exceeded',
              code: 'MAX_EXECUTION_TIME_EXCEEDED'
            }
          });
          break;
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
            // Get the last completed node to check for custom status
            const lastNodeId = state.completedNodes?.[state.completedNodes.length - 1];
            const lastNodeResult = state.data?.nodeResults?.[lastNodeId];
            const customStatus = lastNodeResult?.workflowStatus || null;

            // Workflow complete
            await this._completeWorkflow(executionId, state, customStatus);
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
            // Read retry config from node.execution
            const nodeExecConfig = node.execution || {};
            const maxRetries = nodeExecConfig.retries || 0;
            const retryDelay = nodeExecConfig.retryDelay || 1000;

            let result;
            let attempt = 0;

            // Retry loop: attempt execution up to maxRetries + 1 times

            while (true) {
              try {
                result = await this.executeNode(node, workflow, executionId, options);
                break; // Success - exit retry loop
              } catch (executeError) {
                attempt++;
                if (attempt <= maxRetries) {
                  // Log retry attempt
                  logger.warn({
                    component: 'WorkflowEngine',
                    message: `Node '${nodeId}' failed (attempt ${attempt}/${maxRetries + 1}), retrying in ${retryDelay}ms`,
                    executionId,
                    nodeId,
                    attempt,
                    maxRetries,
                    error: executeError.message
                  });

                  // Track retry count in state
                  const retryState = await this.stateManager.get(executionId);
                  await this.stateManager.update(executionId, {
                    data: {
                      ...retryState.data,
                      _nodeRetries: {
                        ...(retryState.data?._nodeRetries || {}),
                        [nodeId]: attempt
                      }
                    }
                  });

                  // Emit retry event
                  this._emitEvent('workflow.node.retry', {
                    executionId,
                    nodeId,
                    attempt,
                    maxRetries,
                    error: executeError.message,
                    nextRetryIn: retryDelay
                  });

                  // Wait before retrying
                  await new Promise(r => setTimeout(r, retryDelay));
                  continue;
                }
                // All retries exhausted - re-throw for outer catch
                throw executeError;
              }
            }

            // Check if the node returned a paused status (e.g., human checkpoint)
            if (result && result.status === 'paused') {
              logger.info({
                component: 'WorkflowEngine',
                message: 'Workflow paused by node',
                executionId,
                nodeId,
                pauseReason: result.pauseReason || 'node_requested_pause'
              });

              // Update state to paused with checkpoint info
              await this.stateManager.update(executionId, {
                status: WorkflowStatus.PAUSED,
                data: {
                  ...result.stateUpdates,
                  _pausedAt: nodeId,
                  _pauseReason: result.pauseReason
                }
              });

              // Update execution registry with paused status and checkpoint
              const registry = getExecutionRegistry();
              registry.updateStatus(executionId, WorkflowStatus.PAUSED, {
                currentNode: nodeId,
                pendingCheckpoint: result.checkpoint
              });

              // Emit pause event
              this._emitEvent('workflow.paused', {
                executionId,
                nodeId,
                reason: result.pauseReason,
                checkpoint: result.checkpoint
              });

              // Checkpoint the paused state
              if (options.checkpointOnNode) {
                await this.stateManager.checkpoint(executionId, `paused_at_${nodeId}`);
              }

              // Exit the execution loop - workflow will resume when user responds
              return;
            }

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

        // Persist failed state to disk
        await this.stateManager.checkpoint(executionId, 'max_iterations_failure');

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

      // Persist failed state to disk
      await this.stateManager.checkpoint(executionId, 'execution_error');

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

    // 2b. Update registry currentNode so admin API reflects active node
    const registry = getExecutionRegistry();
    registry.updateStatus(executionId, WorkflowStatus.RUNNING, {
      currentNode: nodeId
    });

    // 3. Add step to history
    await this.stateManager.addStep(executionId, {
      nodeId,
      type: 'node_start',
      data: { nodeType, configKeys: Object.keys(config || {}) }
    });

    // 4. Get current state for context
    const state = await this.stateManager.get(executionId);

    // 5. Track node iteration count (for cycle/loop protection)
    const nodeIterations = state.data?._nodeIterations || {};
    const currentIteration = (nodeIterations[nodeId] || 0) + 1;
    const maxIterations = workflow.config?.maxIterations || 10;

    if (currentIteration > maxIterations) {
      const error = new Error(
        `Node '${nodeId}' exceeded maximum iterations (${maxIterations}). ` +
          `This may indicate an infinite loop in your workflow.`
      );
      error.code = 'MAX_NODE_ITERATIONS_EXCEEDED';
      error.nodeId = nodeId;
      error.iterations = currentIteration;
      error.maxIterations = maxIterations;
      throw error;
    }

    // Calculate step counters for template access
    const nodeInvocations = Object.keys(state.data?.nodeResults || {}).length + 1;
    const totalNodes = workflow.nodes.filter(n => n.type !== 'start' && n.type !== 'end').length;

    // Update iteration count and step counters in state
    await this.stateManager.update(executionId, {
      data: {
        ...state.data,
        _nodeIterations: {
          ...nodeIterations,
          [nodeId]: currentIteration
        },
        _currentStep: nodeInvocations,
        _currentNodeIteration: currentIteration,
        _totalNodes: totalNodes
      }
    });

    // Re-fetch state after update for accurate context
    const updatedState = await this.stateManager.get(executionId);

    if (currentIteration > 1) {
      logger.info({
        component: 'WorkflowEngine',
        message: 'Node executing in loop iteration',
        executionId,
        nodeId,
        iteration: currentIteration,
        maxIterations
      });
    }

    // 6. Build execution context
    const context = {
      executionId,
      nodeId,
      workflow,
      initialData: updatedState.data, // Initial data stored in state.data
      nodeResults: updatedState.data?.nodeResults || {},
      iteration: currentIteration, // Current iteration count for this node
      user: options.user,
      language: options.language || 'en',
      abortSignal: this.abortControllers.get(executionId)?.signal
    };

    // 7. Execute with timeout and timing (prefer node.execution.timeout over legacy node.timeout)
    const executionConfig = node.execution || {};
    const timeout = this._normalizeTimeout(
      executionConfig.timeout,
      options.timeout,
      node.timeout
    );
    let result;
    const startTime = Date.now();

    try {
      result = await this._executeWithTimeout(
        () => executor.execute(node, updatedState, context),
        timeout,
        `Node ${nodeId} execution timed out after ${timeout}ms`
      );
    } catch (error) {
      // Re-throw to be handled by caller
      throw error;
    }

    // Capture execution duration and add metrics to result
    const duration = Date.now() - startTime;
    if (result && typeof result === 'object') {
      result.metrics = {
        duration,
        startTime: new Date(startTime).toISOString(),
        tokens: result.tokens || null
      };
    }

    // 8. Check if the executor returned a failed result
    if (result && result.status === 'failed') {
      // Convert the failed result into an error for proper handling
      const error = new Error(result.error || 'Node execution failed');
      error.code = result.code || 'NODE_EXECUTION_FAILED';
      error.nodeId = nodeId;
      error.details = result;
      throw error;
    }

    // 9. Update state with result (only for successful executions)
    // Include iteration in result so StateManager can store with iteration key
    const resultWithIteration = result
      ? { ...result, iteration: currentIteration }
      : { iteration: currentIteration };
    await this.stateManager.markNodeCompleted(executionId, nodeId, resultWithIteration);

    // 10. Add step to history
    await this.stateManager.addStep(executionId, {
      nodeId,
      type: 'node_complete',
      data: {
        resultType: typeof result,
        hasOutput: result !== null && result !== undefined,
        iteration: currentIteration
      }
    });

    // 11. Emit node complete event (include iteration for UI to track per-iteration results)
    this._emitEvent('workflow.node.complete', {
      executionId,
      nodeId,
      result: this._sanitizeForEvent(resultWithIteration)
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
    // Retries are handled in _runExecutionLoop before this method is called.
    // If we reach here, all retries have been exhausted.
    const shouldFailWorkflow = true;

    if (shouldFailWorkflow) {
      await this.stateManager.update(executionId, {
        status: WorkflowStatus.FAILED,
        completedAt: new Date().toISOString()
      });

      // Persist failed state to disk
      await this.stateManager.checkpoint(executionId, 'workflow_failed');

      // Update execution registry
      const registry = getExecutionRegistry();
      registry.updateStatus(executionId, WorkflowStatus.FAILED, { currentNode: null });

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
   * @param {string} [customStatus] - Custom status from end node (e.g., 'approved', 'rejected')
   * @private
   */
  async _completeWorkflow(executionId, state, customStatus = null) {
    // Use custom status if provided, otherwise default to COMPLETED
    const finalStatus = customStatus || WorkflowStatus.COMPLETED;

    logger.info({
      component: 'WorkflowEngine',
      message: 'Workflow execution completed',
      executionId,
      completedNodes: state.completedNodes.length,
      finalStatus
    });

    await this.stateManager.update(executionId, {
      status: finalStatus,
      completedAt: new Date().toISOString()
    });

    // Persist final completed state to disk so other engine instances can load it
    await this.stateManager.checkpoint(executionId, 'workflow_complete');

    // Update execution registry
    const registry = getExecutionRegistry();
    registry.updateStatus(executionId, finalStatus, { currentNode: null });

    // Extract output from state.data using end node's outputVariables config
    const workflow = state.data._workflowDefinition;
    const lastNodeId = state.completedNodes[state.completedNodes.length - 1];
    const endNode = workflow?.nodes?.find(n => n.id === lastNodeId);
    const outputVars = endNode?.config?.outputVariables;

    let output;
    if (outputVars && Array.isArray(outputVars)) {
      // Build output from state.data using the end node's outputVariables
      output = {};
      for (const varName of outputVars) {
        if (state.data[varName] !== undefined) {
          output[varName] = state.data[varName];
        }
      }
    } else {
      // Fallback to legacy behavior for backwards compatibility
      output = state.data.nodeResults?.[lastNodeId];
    }

    this._emitEvent('workflow.complete', {
      executionId,
      status: finalStatus,
      output
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

    // Merge resume data into state (stateManager.update uses deep merge internally)
    await this.stateManager.update(executionId, {
      status: WorkflowStatus.RUNNING,
      data: {
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

    // Persist cancelled state to disk
    await this.stateManager.checkpoint(executionId, 'workflow_cancelled');

    // Update execution registry
    const registry = getExecutionRegistry();
    registry.updateStatus(executionId, WorkflowStatus.CANCELLED, { currentNode: null });

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
   * Normalizes and bounds timeout values to prevent resource exhaustion
   * @param {...(number|undefined)} timeoutCandidates - Candidate timeout values in ms
   * @returns {number} A safe timeout value in milliseconds
   * @private
   */
  _normalizeTimeout(...timeoutCandidates) {
    for (const candidate of timeoutCandidates) {
      if (candidate === undefined || candidate === null) {
        continue;
      }
      const value = Number(candidate);
      if (!Number.isFinite(value) || value <= 0) {
        continue;
      }
      if (value < MIN_NODE_TIMEOUT) {
        return MIN_NODE_TIMEOUT;
      }
      if (value > MAX_NODE_TIMEOUT) {
        return MAX_NODE_TIMEOUT;
      }
      return value;
    }

    // Fall back to the engine's default timeout, bounded as well
    const defaultValue = Number(this.defaultTimeout) || DEFAULT_NODE_TIMEOUT;
    if (defaultValue < MIN_NODE_TIMEOUT) {
      return MIN_NODE_TIMEOUT;
    }
    if (defaultValue > MAX_NODE_TIMEOUT) {
      return MAX_NODE_TIMEOUT;
    }
    return defaultValue;
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
   * Sanitizes a value for inclusion in events (removes large data but preserves metadata)
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
      if (json.length > 2048) {
        // For workflow results, preserve important metadata even when truncating
        if (typeof value === 'object' && value !== null) {
          const sanitized = {
            _truncated: true,
            _type: typeof value,
            _size: json.length
          };

          // Preserve workflow-relevant metadata
          const preserveKeys = [
            'status',
            'branch',
            'outputVariable',
            'model',
            'modelName',
            'stateUpdates',
            'isTerminal',
            'workflowStatus',
            'metrics', // Duration and timing
            'tokens', // Token usage
            'iterations' // LLM iteration count
          ];

          for (const key of preserveKeys) {
            if (key in value) {
              sanitized[key] = value[key];
            }
          }

          // For output, provide a summary
          if (value.output !== undefined) {
            if (typeof value.output === 'string') {
              sanitized.output =
                value.output.length > 500
                  ? value.output.substring(0, 500) + '... [truncated]'
                  : value.output;
            } else if (typeof value.output === 'object') {
              // For objects, just show structure
              const outputJson = JSON.stringify(value.output);
              sanitized._outputPreview =
                outputJson.length > 300 ? outputJson.substring(0, 300) + '...' : outputJson;
            }
          }

          return sanitized;
        }

        // Fallback for non-objects
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
