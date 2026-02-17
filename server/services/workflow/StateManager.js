import { atomicWriteJSON } from '../../utils/atomicWrite.js';
import { deepMerge } from '../../utils/deepMerge.js';
import path from 'path';
import fs from 'fs/promises';
import { v4 as uuidv4 } from 'uuid';
import logger from '../../utils/logger.js';
import { getRootDir } from '../../pathUtils.js';
import config from '../../config.js';
import { validateIdForPath } from '../../utils/pathSecurity.js';

/**
 * Default directory for workflow state persistence
 * Uses the canonical path: {rootDir}/{CONTENTS_DIR}/data/workflow-state
 * @constant {string}
 */
const STATE_DIR = path.join(getRootDir(), config.CONTENTS_DIR, 'data', 'workflow-state');

/**
 * Maximum allowed size for workflow state in bytes (50MB)
 * Prevents memory issues from extremely large state objects
 * @constant {number}
 */
const MAX_STATE_SIZE = 50 * 1024 * 1024;

/**
 * Valid workflow execution status values
 * @constant {Object}
 */
export const WorkflowStatus = {
  PENDING: 'pending',
  RUNNING: 'running',
  PAUSED: 'paused',
  COMPLETED: 'completed',
  FAILED: 'failed',
  CANCELLED: 'cancelled'
};

/**
 * StateManager handles workflow execution state and checkpoint management.
 * It provides in-memory state storage with optional file-based persistence
 * for durability and recovery scenarios.
 *
 * @example
 * const stateManager = new StateManager();
 * const state = await stateManager.create({
 *   executionId: 'exec-123',
 *   workflowId: 'workflow-456',
 *   data: { input: 'test' }
 * });
 */
/**
 * Singleton StateManager instance shared across all WorkflowEngine instances.
 * This prevents state isolation when multiple engines (e.g., workflowRunner
 * and workflowRoutes) each create their own StateManager with separate
 * in-memory activeStates Maps.
 * @type {StateManager|null}
 * @private
 */
let _singletonInstance = null;

/**
 * Returns the shared StateManager singleton instance.
 * Creates one on first call. All WorkflowEngine instances should use this
 * to ensure consistent in-memory state across different code paths.
 * @param {Object} [options] - Options passed to constructor on first creation
 * @returns {StateManager}
 */
export function getStateManager(options) {
  if (!_singletonInstance) {
    _singletonInstance = new StateManager(options);
  }
  return _singletonInstance;
}

/**
 * Resets the singleton instance (for testing purposes only).
 */
export function resetStateManager() {
  _singletonInstance = null;
}

export class StateManager {
  /**
   * Creates a new StateManager instance
   * @param {Object} options - Configuration options
   * @param {string} [options.stateDir] - Directory for persisting state checkpoints
   */
  constructor(options = {}) {
    /**
     * In-memory storage for active workflow execution states
     * @type {Map<string, Object>}
     * @private
     */
    this.activeStates = new Map();

    /**
     * Directory path for persisting state checkpoints
     * @type {string}
     */
    this.stateDir = options.stateDir || STATE_DIR;
  }

  /**
   * Creates initial execution state for a new workflow run
   * @param {Object} initialState - Initial state configuration
   * @param {string} initialState.executionId - Unique execution identifier
   * @param {string} initialState.workflowId - Workflow definition identifier
   * @param {Object} [initialState.data={}] - Initial workflow data/context
   * @param {string[]} [initialState.currentNodes=[]] - Initially active node IDs
   * @returns {Promise<Object>} The created execution state
   *
   * @example
   * const state = await stateManager.create({
   *   executionId: 'exec-123',
   *   workflowId: 'my-workflow',
   *   data: { userInput: 'Hello' },
   *   currentNodes: ['start-node']
   * });
   */
  async create(initialState) {
    const { executionId, workflowId, data = {}, currentNodes = [] } = initialState;

    if (!executionId) {
      throw new Error('executionId is required to create workflow state');
    }

    if (!workflowId) {
      throw new Error('workflowId is required to create workflow state');
    }

    const state = {
      executionId,
      workflowId,
      status: WorkflowStatus.PENDING,
      currentNodes,
      completedNodes: [],
      failedNodes: [],
      data,
      history: [],
      checkpoints: [],
      errors: [],
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      startedAt: null,
      completedAt: null
    };

    // Validate state size before storing
    this._validateStateSize(state);

    this.activeStates.set(executionId, state);

    logger.info({
      component: 'StateManager',
      message: 'Created workflow execution state',
      executionId,
      workflowId
    });

    return { ...state };
  }

  /**
   * Updates an existing execution state with new values
   * @param {string} executionId - The execution identifier
   * @param {Object} updates - Partial state updates to apply
   * @returns {Promise<Object>} The updated execution state
   * @throws {Error} If execution state is not found or size limit exceeded
   *
   * @example
   * const updatedState = await stateManager.update('exec-123', {
   *   status: 'running',
   *   data: { ...existingData, result: 'processed' }
   * });
   */
  async update(executionId, updates) {
    const state = this.activeStates.get(executionId);

    if (!state) {
      throw new Error(`Execution state not found: ${executionId}`);
    }

    // Merge updates into existing state
    const updatedState = {
      ...state,
      ...updates,
      updatedAt: new Date().toISOString()
    };

    // Deep merge for nested objects like data to preserve nested state
    // (e.g., researchState.iteration preserved when only currentFocus is updated)
    if (updates.data) {
      updatedState.data = deepMerge(state.data, updates.data);
    }

    // Validate state size after update
    this._validateStateSize(updatedState);

    this.activeStates.set(executionId, updatedState);

    logger.debug({
      component: 'StateManager',
      message: 'Updated workflow execution state',
      executionId,
      status: updatedState.status
    });

    return { ...updatedState };
  }

  /**
   * Retrieves the current execution state
   * @param {string} executionId - The execution identifier
   * @returns {Promise<Object|null>} The execution state or null if not found
   *
   * @example
   * const state = await stateManager.get('exec-123');
   * if (state) {
   *   console.log('Current status:', state.status);
   * }
   */
  async get(executionId) {
    // Validate executionId before using it in filesystem paths
    if (!validateIdForPath(executionId, 'executionId')) {
      logger.warn({
        component: 'StateManager',
        message: 'Invalid executionId for state lookup',
        executionId
      });
      return null;
    }

   const state = this.activeStates.get(executionId);

    if (!state) {
      // Try to load from checkpoint file if not in memory
      try {
        const checkpointPath = path.join(this.stateDir, executionId, 'latest.json');
        const checkpointData = await fs.readFile(checkpointPath, 'utf8');
        const restoredState = JSON.parse(checkpointData);
        this.activeStates.set(executionId, restoredState);
        return { ...restoredState };
      } catch {
        return null;
      }
    }

    return { ...state };
  }

  /**
   * Creates a checkpoint by persisting current state to file
   * @param {string} executionId - The execution identifier
   * @param {string} [reason='auto'] - Reason for creating the checkpoint
   * @returns {Promise<Object>} Checkpoint metadata including ID and timestamp
   * @throws {Error} If execution state is not found
   *
   * @example
   * const checkpoint = await stateManager.checkpoint('exec-123', 'before_llm_call');
   * console.log('Checkpoint saved:', checkpoint.checkpointId);
   */
  async checkpoint(executionId, reason = 'auto') {
    const state = this.activeStates.get(executionId);

    if (!state) {
      throw new Error(`Execution state not found for checkpoint: ${executionId}`);
    }

    const checkpointId = `ckpt-${uuidv4()}`;
    const timestamp = new Date().toISOString();

    const checkpointMeta = {
      checkpointId,
      reason,
      timestamp,
      status: state.status,
      currentNodes: [...state.currentNodes]
    };

    // Update state with checkpoint info
    state.checkpoints.push(checkpointMeta);
    state.updatedAt = timestamp;

    // Ensure checkpoint directory exists
    const checkpointDir = path.join(this.stateDir, executionId);
    await fs.mkdir(checkpointDir, { recursive: true });

    // Write latest checkpoint file using atomic write
    const latestPath = path.join(checkpointDir, 'latest.json');
    await atomicWriteJSON(latestPath, state);

    logger.info({
      component: 'StateManager',
      message: 'Checkpoint saved',
      executionId,
      checkpointId,
      reason
    });

    return checkpointMeta;
  }

  /**
   * Restores execution state from the latest checkpoint
   * @param {string} executionId - The execution identifier
   * @returns {Promise<Object>} The restored execution state
   * @throws {Error} If checkpoint file is not found
   *
   * @example
   * const state = await stateManager.restore('exec-123');
   * console.log('Restored from checkpoint:', state.status);
   */
  async restore(executionId) {
    const checkpointPath = path.join(this.stateDir, executionId, 'latest.json');

    try {
      const checkpointData = await fs.readFile(checkpointPath, 'utf8');
      const restoredState = JSON.parse(checkpointData);

      // Mark state as restored
      restoredState.restoredAt = new Date().toISOString();
      restoredState.restoredFrom = 'latest';

      // Store in active states
      this.activeStates.set(executionId, restoredState);

      logger.info({
        component: 'StateManager',
        message: 'State restored from checkpoint',
        executionId
      });

      return { ...restoredState };
    } catch (error) {
      throw new Error(`Failed to restore checkpoint: ${error.message}`);
    }
  }

  /**
   * Adds an execution step to the history
   * @param {string} executionId - The execution identifier
   * @param {Object} step - Step details to record
   * @param {string} step.nodeId - Node that was executed
   * @param {string} step.type - Type of step (node_start, node_complete, node_error)
   * @param {Object} [step.data] - Additional step data
   * @returns {Promise<void>}
   *
   * @example
   * await stateManager.addStep('exec-123', {
   *   nodeId: 'llm-node-1',
   *   type: 'node_complete',
   *   data: { outputTokens: 150 }
   * });
   */
  async addStep(executionId, step) {
    const state = this.activeStates.get(executionId);

    if (!state) {
      throw new Error(`Execution state not found: ${executionId}`);
    }

    const historyEntry = {
      ...step,
      timestamp: new Date().toISOString()
    };

    state.history.push(historyEntry);
    state.updatedAt = historyEntry.timestamp;

    // Check state size after adding history
    this._validateStateSize(state);

    logger.debug({
      component: 'StateManager',
      message: 'Added step to execution history',
      executionId,
      nodeId: step.nodeId,
      type: step.type
    });
  }

  /**
   * Records an error for the execution
   * @param {string} executionId - The execution identifier
   * @param {Object} error - Error details to record
   * @param {string} error.message - Error message
   * @param {string} [error.nodeId] - Node where error occurred
   * @param {string} [error.code] - Error code
   * @param {string} [error.stack] - Error stack trace
   * @returns {Promise<void>}
   *
   * @example
   * await stateManager.addError('exec-123', {
   *   nodeId: 'api-node',
   *   message: 'API rate limit exceeded',
   *   code: 'RATE_LIMIT'
   * });
   */
  async addError(executionId, error) {
    const state = this.activeStates.get(executionId);

    if (!state) {
      throw new Error(`Execution state not found: ${executionId}`);
    }

    const errorEntry = {
      ...error,
      timestamp: new Date().toISOString()
    };

    state.errors.push(errorEntry);
    state.updatedAt = errorEntry.timestamp;

    logger.warn({
      component: 'StateManager',
      message: 'Recorded execution error',
      executionId,
      nodeId: error.nodeId,
      errorMessage: error.message
    });
  }

  /**
   * Marks a node as completed and updates state accordingly
   * @param {string} executionId - The execution identifier
   * @param {string} nodeId - The completed node ID
   * @param {Object} [result] - Node execution result
   * @returns {Promise<void>}
   */
  async markNodeCompleted(executionId, nodeId, result = null) {
    const state = this.activeStates.get(executionId);

    if (!state) {
      throw new Error(`Execution state not found: ${executionId}`);
    }

    // Remove from current nodes
    state.currentNodes = state.currentNodes.filter(id => id !== nodeId);

    // Add to completed nodes if not already there
    // Note: completedNodes tracks unique nodes for routing purposes
    if (!state.completedNodes.includes(nodeId)) {
      state.completedNodes.push(nodeId);
    }

    // Track total node invocations (counts every execution, including loops)
    state.data.nodeInvocations = (state.data.nodeInvocations || 0) + 1;

    // Store result in data if provided
    if (result !== null) {
      state.data.nodeResults = state.data.nodeResults || {};

      // Store with iteration key if iteration info is available (for loops)
      // This allows UI to display each iteration separately
      const iteration = result.iteration || result.output?.iteration;
      if (iteration !== undefined) {
        state.data.nodeResults[`${nodeId}_iter${iteration}`] = result;
      }

      // Always store latest result under nodeId for backward compatibility
      state.data.nodeResults[nodeId] = result;

      // Track metrics if available
      if (result.metrics) {
        state.data.executionMetrics = state.data.executionMetrics || {
          totalDuration: 0,
          totalTokens: { input: 0, output: 0, total: 0 },
          nodeCount: 0
        };
        state.data.executionMetrics.totalDuration += result.metrics.duration || 0;
        if (result.metrics.tokens) {
          state.data.executionMetrics.totalTokens.input += result.metrics.tokens.input || 0;
          state.data.executionMetrics.totalTokens.output += result.metrics.tokens.output || 0;
          state.data.executionMetrics.totalTokens.total +=
            (result.metrics.tokens.input || 0) + (result.metrics.tokens.output || 0);
        }
        state.data.executionMetrics.nodeCount++;
      }

      // Apply stateUpdates to state.data using deep merge (e.g., outputVariable values)
      // This allows subsequent nodes and showData to access values like $.research_results
      // Deep merge preserves nested properties (e.g., researchState.iteration during loops)
      if (result.stateUpdates && typeof result.stateUpdates === 'object') {
        state.data = deepMerge(state.data, result.stateUpdates);
      }
    }

    state.updatedAt = new Date().toISOString();
  }

  /**
   * Marks a node as failed and updates state accordingly
   * @param {string} executionId - The execution identifier
   * @param {string} nodeId - The failed node ID
   * @param {Error|Object} error - The error that caused the failure
   * @returns {Promise<void>}
   */
  async markNodeFailed(executionId, nodeId, error) {
    const state = this.activeStates.get(executionId);

    if (!state) {
      throw new Error(`Execution state not found: ${executionId}`);
    }

    // Remove from current nodes
    state.currentNodes = state.currentNodes.filter(id => id !== nodeId);

    // Add to failed nodes if not already there
    if (!state.failedNodes.includes(nodeId)) {
      state.failedNodes.push(nodeId);
    }

    // Add error to errors list
    await this.addError(executionId, {
      nodeId,
      message: error.message || String(error),
      code: error.code,
      stack: error.stack
    });

    state.updatedAt = new Date().toISOString();
  }

  /**
   * Cleans up execution state from memory and optionally from disk
   * @param {string} executionId - The execution identifier
   * @param {boolean} [keepCheckpoints=false] - Whether to preserve checkpoint files
   * @returns {Promise<void>}
   *
   * @example
   * // Clean up completed execution, removing all checkpoints
   * await stateManager.cleanup('exec-123', false);
   *
   * // Clean up but keep checkpoints for debugging
   * await stateManager.cleanup('exec-123', true);
   */
  async cleanup(executionId, keepCheckpoints = false) {
    // Remove from active states
    this.activeStates.delete(executionId);

    if (!keepCheckpoints) {
      // Remove checkpoint files
      const checkpointDir = path.join(this.stateDir, executionId);
      try {
        await fs.rm(checkpointDir, { recursive: true, force: true });
        logger.info({
          component: 'StateManager',
          message: 'Cleaned up execution state and checkpoints',
          executionId
        });
      } catch (error) {
        // Directory might not exist, which is fine
        if (error.code !== 'ENOENT') {
          logger.warn({
            component: 'StateManager',
            message: 'Failed to clean up checkpoint directory',
            executionId,
            error: error.message
          });
        }
      }
    } else {
      logger.info({
        component: 'StateManager',
        message: 'Cleaned up execution state (checkpoints preserved)',
        executionId
      });
    }
  }

  /**
   * Lists all active execution IDs
   * @returns {Promise<string[]>} Array of active execution IDs
   */
  async listActive() {
    return Array.from(this.activeStates.keys());
  }

  /**
   * Gets summary information for all active executions
   * @returns {Promise<Object[]>} Array of execution summaries
   */
  async getActiveSummaries() {
    const summaries = [];

    for (const [executionId, state] of this.activeStates) {
      summaries.push({
        executionId,
        workflowId: state.workflowId,
        status: state.status,
        currentNodes: state.currentNodes.length,
        completedNodes: state.completedNodes.length,
        failedNodes: state.failedNodes.length,
        createdAt: state.createdAt,
        updatedAt: state.updatedAt
      });
    }

    return summaries;
  }

  /**
   * Validates that state size is within limits
   * @param {Object} state - The state object to validate
   * @throws {Error} If state exceeds size limit
   * @private
   */
  _validateStateSize(state) {
    const stateJson = JSON.stringify(state);
    const sizeInBytes = Buffer.byteLength(stateJson, 'utf8');

    if (sizeInBytes > MAX_STATE_SIZE) {
      const sizeMB = (sizeInBytes / (1024 * 1024)).toFixed(2);
      const limitMB = (MAX_STATE_SIZE / (1024 * 1024)).toFixed(2);
      throw new Error(
        `Workflow state size (${sizeMB}MB) exceeds limit (${limitMB}MB). ` +
          'Consider checkpointing and cleaning up history.'
      );
    }
  }
}

export default StateManager;
