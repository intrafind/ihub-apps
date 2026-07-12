import { v4 as uuidv4 } from 'uuid';
import { DAGScheduler } from './DAGScheduler.js';
import { getStateManager, WorkflowStatus } from './StateManager.js';
import { getExecutor as getDefaultExecutor } from './executors/index.js';
import { getExecutionRegistry } from './ExecutionRegistry.js';
import { actionTracker } from '../../actionTracker.js';
import { summarizePlanForEvent } from '../../agents/runtime/taskRecord.js';
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
 * Engine-level cap on total scheduler iterations (each iteration runs one
 * ready node). This is a backstop above the per-node `maxIterations`
 * check; the per-node cap is the primary safety. Set high enough to
 * accommodate cycle-shaped workflows that visit many nodes many times
 * (e.g. 5 sub-questions × 100 docs × ~5 inner cycle nodes ≈ 2500).
 * @constant {number}
 */
const MAX_EXECUTION_ITERATIONS = 10000;

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
/**
 * Singleton WorkflowEngine instance shared across all entry points
 * (workflowRunner, workflowRoutes, agents/runs, agents/artifacts, and the
 * boot-time resume path). `abortControllers` is per-instance state, so a
 * cancel() routed through a different instance than the one running the
 * loop cannot fire that run's abort signal — it can only flip the
 * persisted status, which is only picked up between nodes. Sharing one
 * instance makes cancellation coherent across every entry point.
 * @type {WorkflowEngine|null}
 * @private
 */
let _singletonInstance = null;

/**
 * Returns the shared WorkflowEngine singleton instance.
 * Creates one on first call. All callers should use this instead of
 * `new WorkflowEngine()` so abort controllers and cancellation stay
 * coherent across entry points.
 *
 * Do not pass a `defaultTimeout` override here — since the instance is
 * shared, whichever caller happens to construct it first would silently
 * decide the default for everyone else. Callers that need a longer
 * per-run timeout (e.g. agent runs) should pass `timeout` explicitly in
 * the `options` of each `start`/`resume`/`resumeFromCheckpoint`/
 * `resumeFromTerminated` call instead — `_normalizeTimeout` already
 * prefers a per-call `options.timeout` over `this.defaultTimeout`.
 * @param {Object} [options] - Options passed to constructor on first creation
 * @returns {WorkflowEngine}
 */
export function getWorkflowEngine(options) {
  if (!_singletonInstance) {
    _singletonInstance = new WorkflowEngine(options);
  }
  return _singletonInstance;
}

/**
 * Resets the singleton instance (for testing purposes only).
 */
export function resetWorkflowEngine() {
  _singletonInstance = null;
}

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

    logger.info('Registered node executor', { component: 'WorkflowEngine', nodeType });
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
   * Execute a child sub-workflow spawned by a planner node.
   *
   * Creates a new execution with a parent-child relationship tracked in state,
   * emits an SSE event for UI visibility, and starts the child workflow
   * non-blocking via this.start().
   *
   * @param {string} parentExecutionId - The execution ID of the parent workflow
   * @param {Object} workflowDef - The materialized sub-workflow definition
   * @param {Object} initialData - Initial data for the child workflow (merged from parent state)
   * @param {Object} [options={}] - Execution options
   * @param {number} [options.depth=0] - Current sub-workflow nesting depth
   * @param {number} [options.maxDepth=3] - Maximum allowed nesting depth
   * @param {Object} [options.user] - User context
   * @param {string} [options.chatId] - Chat ID for SSE events
   * @param {Object} [options.appConfig] - App configuration
   * @param {string} [options.language] - Language code
   * @returns {Promise<string>} The child execution ID
   * @throws {Error} If depth limit is exceeded
   */
  async executeSubWorkflow(parentExecutionId, workflowDef, initialData, options = {}) {
    const depth = options.depth || 0;
    const maxDepth = options.maxDepth || 3;
    if (depth > maxDepth) throw new Error(`Sub-workflow depth limit (${maxDepth}) exceeded`);

    const childExecutionId = `wf-child-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

    // Store parent-child relationship in parent state
    const parentState = await this.stateManager.get(parentExecutionId);
    if (parentState) {
      const childIds = parentState.data?._childExecutionIds || [];
      await this.stateManager.update(parentExecutionId, {
        data: { _childExecutionIds: [...childIds, childExecutionId] }
      });
    }

    // Emit SSE event for UI tracking. Flat payload to match the rest of
    // the workflow/agent event surface (the client handler reads top-level
    // fields, not a nested `data:` envelope).
    actionTracker.emit('fire-sse', {
      event: 'workflow.subworkflow.start',
      chatId: parentExecutionId,
      executionId: childExecutionId,
      parentExecutionId,
      depth,
      taskCount: workflowDef.nodes?.length
    });

    // Start child execution (non-blocking)
    await this.start(
      workflowDef,
      { ...initialData, _parentExecutionId: parentExecutionId },
      {
        executionId: childExecutionId,
        depth,
        ...options
      }
    );

    return childExecutionId;
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

    logger.info('Starting workflow execution', {
      component: 'WorkflowEngine',
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
        logger.info('Workflow contains intentional cycles (loops enabled)', {
          component: 'WorkflowEngine',
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

    // 4. Create execution state. We persist a SUMMARY of the workflow
    // definition (just the node shape — id / type / config._isSynthesizer)
    // so the UI can render orchestrator rows ("Planning", "Composing
    // final report") with stable visibility before those nodes actually
    // run. We don't store the full definition (with prompts, model ids,
    // etc.) because it can be tens of KB per state save.
    const workflowSummary = {
      id: workflowDefinition.id,
      name: workflowDefinition.name,
      nodes: Array.isArray(workflowDefinition.nodes)
        ? workflowDefinition.nodes.map(n => ({
            id: n?.id,
            type: n?.type,
            // Carry only the markers the UI inspects. _isSynthesizer flags
            // the final composer; _persistAsArtifact flags a prompt node
            // that IS the primary answer producer (simple-agent or
            // inbox-worker without a separate synthesizer) — the UI uses
            // this to render a step row for it even though no planner
            // materialized it as a task.
            ...(n?.config?._isSynthesizer === true ? { _isSynthesizer: true } : {}),
            ...(n?.config?._persistAsArtifact === true ? { _persistAsArtifact: true } : {})
          }))
        : []
    };

    const state = await this.stateManager.create({
      executionId,
      workflowId,
      data: {
        ...initialData,
        _workflow: {
          startedBy: options.user?.id || 'anonymous',
          startedAt: new Date().toISOString()
        },
        _executionDeadline: executionDeadline,
        _workflowSummary: workflowSummary
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
        logger.error('Workflow execution failed', {
          component: 'WorkflowEngine',
          executionId,
          error
        });
      }
    );

    // 8. Return initial state (execution continues in background)
    return state;
  }

  /**
   * Resume a previously-interrupted execution from its last checkpoint.
   *
   * Unlike start(), this does NOT create fresh state — it restores the
   * persisted `latest.json` for `executionId` (with its `completedNodes` /
   * `currentNodes` / accumulated `data`) and re-enters the same execution
   * loop. The scheduler picks up exactly where it left off; any node that was
   * mid-flight at crash time re-runs (at-least-once semantics — node executors
   * should be idempotent where it matters).
   *
   * Used on boot to recover runs the server was executing when it stopped,
   * instead of marking them failed. The caller is responsible for supplying
   * the full `workflowDefinition` (reloaded from disk / re-serialized from the
   * agent profile) since only a summary is persisted in state.
   *
   * Distinct from `resume()` (which un-pauses a HITL-paused run): this recovers
   * a run that was interrupted by a process crash/restart.
   *
   * @param {Object} workflowDefinition - Full workflow definition
   * @param {string} executionId - The execution to resume
   * @param {Object} [options] - Execution options (user, etc.)
   * @returns {Promise<Object|null>} The execution state, or null if not resumable
   */
  async resumeFromCheckpoint(workflowDefinition, executionId, options = {}) {
    let state = null;
    try {
      state = await this.stateManager.restore(executionId);
    } catch {
      state = null; // restore throws when no checkpoint file exists
    }
    if (!state) {
      logger.warn('Cannot resume execution — no checkpoint found', {
        component: 'WorkflowEngine',
        executionId
      });
      return null;
    }

    // Terminal runs are not resumable.
    const TERMINAL = [WorkflowStatus.COMPLETED, WorkflowStatus.FAILED, WorkflowStatus.CANCELLED];
    if (TERMINAL.includes(state.status)) {
      logger.debug('Skipping resume — execution already terminal', {
        component: 'WorkflowEngine',
        executionId,
        status: state.status
      });
      return state;
    }

    // Re-anchor the execution deadline to now so a run that was interrupted
    // hours ago doesn't instantly trip MAX_EXECUTION_TIME on resume.
    const maxExecutionTime = workflowDefinition.config?.maxExecutionTime || 300000;

    // Reset the per-node iteration counter for the nodes we're about to
    // re-run (same rationale as resumeFromTerminated): the counter is a CYCLE
    // guard, not a retry counter. Without this, a loop node interrupted near
    // MAX_NODE_ITERATIONS trips the cap on its first post-resume execution and
    // defeats recovery. deepMerge preserves counters for other in-loop nodes.
    const prevIterations = state.data?._nodeIterations || {};
    const resetIterations = { ...prevIterations };
    for (const nodeId of state.currentNodes || []) {
      resetIterations[nodeId] = 0;
    }

    await this.stateManager.update(executionId, {
      status: WorkflowStatus.RUNNING,
      data: {
        _executionDeadline: Date.now() + maxExecutionTime,
        _resumedAt: new Date().toISOString(),
        _nodeIterations: resetIterations
      }
    });

    const abortController = new AbortController();
    this.abortControllers.set(executionId, abortController);

    logger.info('Resuming workflow execution from checkpoint', {
      component: 'WorkflowEngine',
      executionId,
      workflowId: workflowDefinition.id,
      completedNodes: state.completedNodes?.length || 0,
      currentNodes: state.currentNodes
    });

    this._emitEvent('workflow.resumed', {
      executionId,
      workflowId: workflowDefinition.id,
      completedNodes: state.completedNodes || [],
      currentNodes: state.currentNodes || []
    });

    // Re-enter the same loop; it reads currentNodes/completedNodes from state.
    this._runExecutionLoop(workflowDefinition, executionId, options, abortController.signal).catch(
      error => {
        logger.error('Resumed workflow execution failed', {
          component: 'WorkflowEngine',
          executionId,
          error
        });
      }
    );

    return this.stateManager.get(executionId);
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

        logger.debug('Workflow iteration', {
          component: 'WorkflowEngine',
          executionId,
          iteration: iterationCount
        });

        // Check for cancellation
        if (signal.aborted) {
          logger.info('Workflow execution cancelled', { component: 'WorkflowEngine', executionId });
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
          logger.error('Workflow exceeded maximum execution time', {
            component: 'WorkflowEngine',
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
          logger.info('Workflow execution stopped', {
            component: 'WorkflowEngine',
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
            // Nodes are blocked on unsatisfiable dependencies (deadlock)
            logger.error('Workflow has blocked/deadlocked nodes', {
              component: 'WorkflowEngine',
              executionId,
              blockedNodes: state.currentNodes
            });

            await this.stateManager.update(executionId, {
              status: WorkflowStatus.FAILED,
              completedAt: new Date().toISOString()
            });

            await this.stateManager.addError(executionId, {
              message: `Workflow deadlocked: node(s) ${state.currentNodes.join(', ')} have unsatisfiable dependencies`,
              code: 'WORKFLOW_DEADLOCK'
            });

            // Persist failed state to disk
            await this.stateManager.checkpoint(executionId, 'deadlock_failure');

            const registry = getExecutionRegistry();
            registry.updateStatus(executionId, WorkflowStatus.FAILED, { currentNode: null });

            this._emitEvent('workflow.failed', {
              executionId,
              error: {
                message: 'Workflow deadlocked — one or more nodes have unsatisfiable dependencies',
                code: 'WORKFLOW_DEADLOCK'
              }
            });
          }
          break;
        }

        // Execute nodes sequentially (MVP)
        for (const nodeId of executableNodes) {
          if (signal.aborted) break;

          const node = workflow.nodes.find(n => n.id === nodeId);

          if (!node) {
            logger.error('Node not found in workflow', {
              component: 'WorkflowEngine',
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
                  logger.warn('Node failed, retrying', {
                    component: 'WorkflowEngine',
                    executionId,
                    nodeId,
                    attempt,
                    maxAttempts: maxRetries + 1,
                    retryDelay,
                    error: executeError
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
              logger.info('Workflow paused by node', {
                component: 'WorkflowEngine',
                executionId,
                nodeId,
                pauseReason: result.pauseReason || 'node_requested_pause'
              });

              // Update state to paused with checkpoint info.
              // Record _pausedAtMs (wall clock) so resume() can extend the
              // execution deadline by the time spent waiting for the human —
              // user thinking time must not eat into maxExecutionTime.
              await this.stateManager.update(executionId, {
                status: WorkflowStatus.PAUSED,
                data: {
                  ...result.stateUpdates,
                  _pausedAt: nodeId,
                  _pausedAtMs: Date.now(),
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

            // Determine next nodes based on result.
            //
            // `isTerminal: true` on a node's result short-circuits the rest
            // of the workflow. Used by InboxLoadNodeExecutor when the inbox
            // is empty — there's nothing to plan or synthesize, so we don't
            // burn an LLM call (and the planner's wall-time budget) on a
            // no-op run. The currentNodes list is cleared so the execution
            // loop's "no more nodes" check terminates the run cleanly.
            const currentState = await this.stateManager.get(executionId);
            let newCurrentNodes;
            if (result && result.isTerminal === true) {
              logger.info('Workflow short-circuited by terminal node', {
                component: 'WorkflowEngine',
                executionId,
                nodeId
              });
              newCurrentNodes = currentState.currentNodes.filter(id => id !== nodeId);
            } else {
              const nextNodes = this.scheduler.getNextNodes(nodeId, result, workflow, currentState);
              newCurrentNodes = [
                ...currentState.currentNodes.filter(id => id !== nodeId),
                ...nextNodes
              ];
            }

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
        logger.error('Workflow exceeded maximum iterations', {
          component: 'WorkflowEngine',
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
      logger.error('Fatal error in execution loop', {
        component: 'WorkflowEngine',
        executionId,
        error
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

    logger.info('Executing node', { component: 'WorkflowEngine', executionId, nodeId, nodeType });

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
      logger.info('Node executing in loop iteration', {
        component: 'WorkflowEngine',
        executionId,
        nodeId,
        iteration: currentIteration,
        maxIterations
      });
    }

    // 6. Build execution context
    const context = {
      executionId,
      // ChatId is the ROOT run id — used as the SSE channel key by every
      // event the executors emit (planner workflow.plan.created, task
      // workers' agent.task.created, activate_skill, etc.). Without this
      // those events fire with chatId=undefined and the route's SSE
      // forwarder drops them — so tasks only show up in the UI AFTER the
      // run completes (via API refetch). For top-level runs this equals
      // the executionId; sub-workflows inherit it from options.chatId
      // (PlannerNodeExecutor passes context.chatId when spawning the child).
      chatId: options.chatId || executionId,
      nodeId,
      workflow,
      initialData: updatedState.data, // Initial data stored in state.data
      nodeResults: updatedState.data?.nodeResults || {},
      iteration: currentIteration, // Current iteration count for this node
      user: options.user,
      language: options.language || 'en',
      abortSignal: this.abortControllers.get(executionId)?.signal,
      engine: this, // Reference to engine for sub-workflow spawning (planner nodes)
      depth: options?.depth || 0 // Current sub-workflow nesting depth
    };

    // 7. Execute with timeout and timing (prefer node.execution.timeout over legacy node.timeout)
    const executionConfig = node.execution || {};
    const timeout = this._normalizeTimeout(executionConfig.timeout, options.timeout, node.timeout);
    let result;
    const startTime = Date.now();

    try {
      result = await this._executeWithTimeout(
        signal => executor.execute(node, updatedState, { ...context, abortSignal: signal }),
        timeout,
        `Node ${nodeId} execution timed out after ${timeout}ms`,
        context.abortSignal
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

    logger.info('Node execution completed', { component: 'WorkflowEngine', executionId, nodeId });

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

    logger.error('Node execution failed', {
      component: 'WorkflowEngine',
      executionId,
      nodeId,
      error
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
      // Same plan reconciliation as the success path: a failed run shouldn't
      // leave a task spinning at in_progress either.
      await this._reconcilePlanOnTerminal(executionId);

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

    logger.info('Workflow execution completed', {
      component: 'WorkflowEngine',
      executionId,
      completedNodes: state.completedNodes.length,
      finalStatus
    });

    // Close out any task the agent left in_progress/open before persisting the
    // terminal status, so the completed run never shows a spinning task.
    await this._reconcilePlanOnTerminal(executionId, state);

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

    logger.info('Resuming workflow execution', {
      component: 'WorkflowEngine',
      executionId,
      currentNodes: state.currentNodes
    });

    // Extend the execution deadline by however long the workflow sat paused
    // so human idle time does NOT eat into maxExecutionTime. Also accumulate
    // a `_humanWaitMs` counter for observability.
    const pausedAtMs = state.data?._pausedAtMs;
    const previousDeadline = state.data?._executionDeadline;
    const pausedDurationMs = pausedAtMs ? Math.max(0, Date.now() - pausedAtMs) : 0;
    const extendedDeadline =
      previousDeadline && pausedDurationMs > 0
        ? previousDeadline + pausedDurationMs
        : previousDeadline;
    const accumulatedHumanWait = (state.data?._humanWaitMs || 0) + pausedDurationMs;

    // Merge resume data into state (stateManager.update uses deep merge internally)
    await this.stateManager.update(executionId, {
      status: WorkflowStatus.RUNNING,
      data: {
        ...resumeData,
        _resumedAt: new Date().toISOString(),
        _pausedAtMs: null,
        ...(extendedDeadline ? { _executionDeadline: extendedDeadline } : {}),
        _humanWaitMs: accumulatedHumanWait
      }
    });

    if (pausedDurationMs > 0) {
      logger.info('Extended execution deadline by human wait time', {
        component: 'WorkflowEngine',
        executionId,
        pausedDurationMs,
        extendedDeadline
      });
    }

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
      logger.error('Resumed workflow execution failed', {
        component: 'WorkflowEngine',
        executionId,
        error
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

    logger.info('Pausing workflow execution', {
      component: 'WorkflowEngine',
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
   * Resumes a workflow that was previously cancelled or failed mid-execution
   * (timeout, server restart, transient error). The interrupted node will be
   * re-executed from scratch; previously-completed nodes are not re-run.
   *
   * For user-initiated cancellations we refuse — those were intentional.
   *
   * @param {string} executionId
   * @param {Object} [options]
   * @returns {Promise<Object>} New execution state
   */
  async resumeFromTerminated(executionId, options = {}) {
    const state = await this.stateManager.get(executionId);
    if (!state) {
      const error = new Error(`Execution not found: ${executionId}`);
      error.code = 'EXECUTION_NOT_FOUND';
      throw error;
    }

    const RESUMABLE = new Set([WorkflowStatus.CANCELLED, WorkflowStatus.FAILED]);
    if (!RESUMABLE.has(state.status)) {
      const error = new Error(
        `Cannot resume execution with status '${state.status}'. Only cancelled or failed executions can be resumed via resumeFromTerminated.`
      );
      error.code = 'INVALID_STATE_FOR_RESUME';
      throw error;
    }

    // Don't resurrect user-cancelled executions — that was an explicit stop.
    const lastCancelEvent = (state.history || [])
      .slice()
      .reverse()
      .find(h => h.type === 'workflow_cancelled');
    const cancelReason = lastCancelEvent?.data?.reason;
    if (cancelReason === 'user_cancelled' || cancelReason === 'user_requested') {
      const error = new Error('Cannot resume a workflow that was cancelled by the user.');
      error.code = 'USER_CANCELLED';
      throw error;
    }

    // currentNodes is the set of in-flight / ready-to-run nodes. For a timeout
    // cancellation it's typically non-empty (the next iteration node was about
    // to run). For a hard failure the engine moves the failed node out of
    // currentNodes into failedNodes and may leave currentNodes empty — in that
    // case we recover the resume point by re-queueing the failed nodes for
    // retry.
    const hasCurrent = Array.isArray(state.currentNodes) && state.currentNodes.length > 0;
    const hasFailed = Array.isArray(state.failedNodes) && state.failedNodes.length > 0;
    if (!hasCurrent && !hasFailed) {
      const error = new Error(
        'Cannot resume: no in-flight nodes recorded. The workflow finished its last scheduled node before interruption.'
      );
      error.code = 'NO_RESUME_POINT';
      throw error;
    }
    const resumeNodes = hasCurrent ? [...state.currentNodes] : [...new Set(state.failedNodes)];

    const workflow = options.workflow || state.data?._workflowDefinition;
    if (!workflow) {
      const error = new Error(
        'Workflow definition not available. Provide it in options or ensure it was stored in state.'
      );
      error.code = 'WORKFLOW_NOT_AVAILABLE';
      throw error;
    }

    const now = new Date().toISOString();

    // Reset the execution deadline. The original deadline (set at workflow
    // start) is in the past — that's the whole reason we're resuming. Give
    // the resumed run a fresh window equal to maxExecutionTime so it can
    // actually finish. Track total accumulated runtime across resumes for
    // observability.
    const maxExecutionTime = workflow.config?.maxExecutionTime || 300000;
    const newDeadline = Date.now() + maxExecutionTime;
    const previousElapsed = state.data?._totalElapsedMs || 0;
    const startedAtTs = state.data?._workflow?.startedAt
      ? new Date(state.data._workflow.startedAt).getTime()
      : null;
    const interruptedAtTs = state.completedAt ? new Date(state.completedAt).getTime() : null;
    const lastRunElapsed =
      startedAtTs && interruptedAtTs ? Math.max(0, interruptedAtTs - startedAtTs) : 0;

    // Reset the per-node iteration counter for the nodes we're about to
    // re-execute. The counter is a CYCLE guard (catches a node that loops
    // back to itself N times within a single run), not a RETRY counter —
    // a failed attempt followed by a resume should start fresh. Without
    // this reset, every resume bumps the counter and after `maxIterations`
    // resumes the engine refuses to run the node with
    // `MAX_NODE_ITERATIONS_EXCEEDED`. We deepMerge `_nodeIterations` so
    // counters for OTHER nodes (which may legitimately be mid-loop) are
    // preserved.
    const prevIterations = state.data?._nodeIterations || {};
    const resetIterations = { ...prevIterations };
    for (const nodeId of resumeNodes) {
      resetIterations[nodeId] = 0;
    }

    // Clear the terminal markers, requeue the resume nodes, clear failedNodes
    // so the engine doesn't immediately re-flag them on retry. completedNodes
    // is preserved so already-finished work is not re-run.
    await this.stateManager.update(executionId, {
      status: WorkflowStatus.RUNNING,
      errors: [],
      completedAt: null,
      currentNodes: resumeNodes,
      failedNodes: [],
      data: {
        _resumedAt: now,
        _resumedFromStatus: state.status,
        _executionDeadline: newDeadline,
        _totalElapsedMs: previousElapsed + lastRunElapsed,
        _resumeCount: (state.data?._resumeCount || 0) + 1,
        _nodeIterations: resetIterations
      }
    });

    await this.stateManager.addStep(executionId, {
      nodeId: null,
      type: 'workflow_resumed',
      data: {
        fromStatus: state.status,
        reason: cancelReason || null,
        resumeNodes
      },
      timestamp: now
    });

    try {
      getExecutionRegistry().updateStatus(executionId, WorkflowStatus.RUNNING);
    } catch {
      // Registry may not be wired in this environment — non-fatal.
    }

    logger.info('Resuming terminated workflow execution', {
      component: 'WorkflowEngine',
      executionId,
      fromStatus: state.status,
      resumeNodes
    });

    const abortController = new AbortController();
    this.abortControllers.set(executionId, abortController);

    this._runExecutionLoop(workflow, executionId, options, abortController.signal).catch(error => {
      logger.error('Resumed workflow execution failed', {
        component: 'WorkflowEngine',
        executionId,
        error
      });
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
      logger.warn('Cannot cancel execution in terminal state', {
        component: 'WorkflowEngine',
        executionId,
        status: state.status
      });
      return state;
    }

    logger.info('Cancelling workflow execution', {
      component: 'WorkflowEngine',
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
   * Hard-deletes an execution's checkpoint data from disk. Refuses if the
   * execution is currently active. The ExecutionRegistry entry must be
   * removed separately by the caller.
   *
   * @param {string} executionId - The execution identifier
   * @returns {Promise<void>}
   */
  async deleteExecution(executionId) {
    if (this.abortControllers && this.abortControllers.has(executionId)) {
      const error = new Error(
        `Cannot delete execution ${executionId} while it is active. Cancel it first.`
      );
      error.code = 'EXECUTION_ACTIVE';
      throw error;
    }
    await this.stateManager.cleanup(executionId, false);
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
   * @param {Function} fn - The async function to execute; receives an AbortSignal
   *   that fires when the timeout elapses (or the outer signal aborts) so callers
   *   that respect it can actually tear down their in-flight work
   * @param {number} timeout - Timeout in milliseconds
   * @param {string} timeoutMessage - Error message on timeout
   * @param {AbortSignal} [outerSignal] - Signal (e.g. workflow-level cancellation)
   *   that should also abort the signal passed to fn
   * @returns {Promise<*>} The function result
   * @private
   */
  async _executeWithTimeout(fn, timeout, timeoutMessage, outerSignal) {
    const timeoutController = new AbortController();
    const onOuterAbort = () => timeoutController.abort();

    if (outerSignal) {
      if (outerSignal.aborted) {
        timeoutController.abort();
      } else {
        outerSignal.addEventListener('abort', onOuterAbort, { once: true });
      }
    }

    let timeoutId;
    const timeoutPromise = new Promise((_resolve, reject) => {
      timeoutId = setTimeout(() => {
        const error = new Error(timeoutMessage);
        error.code = 'NODE_TIMEOUT';
        // Settle the race with the NODE_TIMEOUT error first so callers keep
        // seeing that contract even if fn() also rejects (e.g. because it
        // observes the abort below) in the same tick.
        reject(error);
        timeoutController.abort();
      }, timeout);
    });

    try {
      return await Promise.race([fn(timeoutController.signal), timeoutPromise]);
    } finally {
      clearTimeout(timeoutId);
      outerSignal?.removeEventListener('abort', onOuterAbort);
    }
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
  /**
   * Reconcile the living plan (`_taskQueue`) when a run reaches a terminal
   * state. A workflow's terminal status is driven by the node graph — NOT by
   * whether the agent finished every task it laid out via set_plan/update_task.
   * So a run can complete (or fail) while a task is still `in_progress` or
   * `open`, which renders as a finished run with a perpetually-spinning task.
   *
   * On terminal we mark any leftover `in_progress`/`open` task as `cancelled`
   * (we can't honestly claim it `done`) so the plan reflects reality, and emit
   * `agent.plan.updated` so a live (non-refetched) view corrects immediately.
   * Only touches agent runs that actually have a task queue.
   *
   * @param {string} executionId
   * @param {Object} [stateArg] - already-loaded state, to avoid a re-read
   * @private
   */
  async _reconcilePlanOnTerminal(executionId, stateArg) {
    try {
      const state = stateArg || (await this.stateManager.get(executionId));
      const queue = state?.data?._taskQueue;
      if (!Array.isArray(queue) || queue.length === 0) return;
      let changed = false;
      const reconciled = queue.map(t => {
        if (t && (t.status === 'in_progress' || t.status === 'open')) {
          changed = true;
          return { ...t, status: 'cancelled' };
        }
        return t;
      });
      if (!changed) return;
      // deepMerge replaces arrays, so this swaps the queue wholesale.
      await this.stateManager.update(executionId, { data: { _taskQueue: reconciled } });
      this._emitEvent('agent.plan.updated', {
        executionId,
        reason: 'terminal-reconcile',
        ...summarizePlanForEvent(reconciled)
      });
    } catch (err) {
      logger.warn('Plan reconciliation on terminal state failed', {
        component: 'WorkflowEngine',
        executionId,
        error: err.message
      });
    }
  }

  _emitEvent(eventType, data) {
    // Use the executionId as the chatId for consistency with actionTracker
    const chatId = data.executionId;

    actionTracker.emit('fire-sse', {
      event: eventType,
      chatId,
      ...data
    });

    logger.debug('Emitted workflow event', {
      component: 'WorkflowEngine',
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
