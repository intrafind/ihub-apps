import path from 'path';
import fs from 'fs/promises';
import logger from '../../utils/logger.js';
import { WorkflowStatus } from './StateManager.js';

/**
 * Default directory for workflow state persistence
 * @constant {string}
 */
const STATE_DIR = 'contents/workflow-state';

/**
 * Registry filename for persisting execution metadata
 * @constant {string}
 */
const REGISTRY_FILE = 'execution-registry.json';

/**
 * ExecutionRegistry tracks all workflow executions by user for listing and recovery.
 * It maintains an in-memory index that can be persisted to disk and recovered
 * on server restart.
 *
 * @example
 * const registry = new ExecutionRegistry();
 * await registry.loadFromDisk();
 *
 * registry.register('exec-123', {
 *   userId: 'user-1',
 *   workflowId: 'workflow-1',
 *   workflowName: { en: 'Research Workflow' },
 *   status: 'running',
 *   startedAt: new Date().toISOString()
 * });
 *
 * const userExecutions = registry.getByUser('user-1');
 */
export class ExecutionRegistry {
  /**
   * Creates a new ExecutionRegistry instance
   * @param {Object} options - Configuration options
   * @param {string} [options.stateDir] - Directory for persisting registry
   */
  constructor(options = {}) {
    /**
     * Execution metadata indexed by executionId
     * @type {Map<string, Object>}
     * @private
     */
    this.executions = new Map();

    /**
     * User to executions mapping for fast lookup
     * @type {Map<string, Set<string>>}
     * @private
     */
    this.userExecutions = new Map();

    /**
     * Directory path for persisting registry
     * @type {string}
     */
    this.stateDir = options.stateDir || STATE_DIR;

    /**
     * Flag indicating if registry has been loaded
     * @type {boolean}
     * @private
     */
    this._loaded = false;

    /**
     * Debounce timer for save operations
     * @type {NodeJS.Timeout|null}
     * @private
     */
    this._saveTimer = null;

    /**
     * Save debounce delay in milliseconds
     * @type {number}
     * @private
     */
    this._saveDelay = 1000;
  }

  /**
   * Registers a new workflow execution
   * @param {string} executionId - Unique execution identifier
   * @param {Object} metadata - Execution metadata
   * @param {string} metadata.userId - User who started the execution
   * @param {string} metadata.workflowId - Workflow definition ID
   * @param {Object} metadata.workflowName - Localized workflow name
   * @param {string} metadata.status - Execution status
   * @param {string} metadata.startedAt - ISO timestamp when execution started
   * @param {Object} [metadata.pendingCheckpoint] - Active human checkpoint if any
   * @returns {Object} The registered execution metadata
   *
   * @example
   * registry.register('exec-123', {
   *   userId: 'user-1',
   *   workflowId: 'research-workflow',
   *   workflowName: { en: 'Research Assistant' },
   *   status: 'running',
   *   startedAt: new Date().toISOString()
   * });
   */
  register(executionId, metadata) {
    const { userId, workflowId, workflowName, status, startedAt } = metadata;

    if (!executionId) {
      throw new Error('executionId is required');
    }

    if (!userId) {
      throw new Error('userId is required');
    }

    if (!workflowId) {
      throw new Error('workflowId is required');
    }

    const execution = {
      executionId,
      userId,
      workflowId,
      workflowName: workflowName || { en: workflowId },
      status: status || WorkflowStatus.PENDING,
      startedAt: startedAt || new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      currentNode: null,
      pendingCheckpoint: null,
      completedAt: null
    };

    this.executions.set(executionId, execution);

    // Update user index
    if (!this.userExecutions.has(userId)) {
      this.userExecutions.set(userId, new Set());
    }
    this.userExecutions.get(userId).add(executionId);

    logger.info({
      component: 'ExecutionRegistry',
      message: 'Registered execution',
      executionId,
      userId,
      workflowId
    });

    // Schedule save
    this._scheduleSave();

    return { ...execution };
  }

  /**
   * Updates the status of an execution
   * @param {string} executionId - The execution identifier
   * @param {string} status - New status value
   * @param {Object} [updates] - Additional fields to update
   * @returns {Object|null} Updated execution or null if not found
   *
   * @example
   * registry.updateStatus('exec-123', 'paused', {
   *   currentNode: 'approval-node',
   *   pendingCheckpoint: { id: 'ckpt-1', message: 'Please approve' }
   * });
   */
  updateStatus(executionId, status, updates = {}) {
    const execution = this.executions.get(executionId);

    if (!execution) {
      logger.warn({
        component: 'ExecutionRegistry',
        message: 'Execution not found for status update',
        executionId
      });
      return null;
    }

    execution.status = status;
    execution.updatedAt = new Date().toISOString();

    // Apply additional updates
    if (updates.currentNode !== undefined) {
      execution.currentNode = updates.currentNode;
    }
    if (updates.pendingCheckpoint !== undefined) {
      execution.pendingCheckpoint = updates.pendingCheckpoint;
    }
    if (
      status === WorkflowStatus.COMPLETED ||
      status === WorkflowStatus.FAILED ||
      status === WorkflowStatus.CANCELLED
    ) {
      execution.completedAt = new Date().toISOString();
    }

    logger.debug({
      component: 'ExecutionRegistry',
      message: 'Updated execution status',
      executionId,
      status
    });

    // Schedule save
    this._scheduleSave();

    return { ...execution };
  }

  /**
   * Sets a pending human checkpoint on an execution
   * @param {string} executionId - The execution identifier
   * @param {Object} checkpoint - Checkpoint data
   * @returns {Object|null} Updated execution or null if not found
   */
  setPendingCheckpoint(executionId, checkpoint) {
    return this.updateStatus(executionId, WorkflowStatus.PAUSED, {
      pendingCheckpoint: checkpoint
    });
  }

  /**
   * Clears a pending checkpoint after user response
   * @param {string} executionId - The execution identifier
   * @returns {Object|null} Updated execution or null if not found
   */
  clearPendingCheckpoint(executionId) {
    const execution = this.executions.get(executionId);

    if (!execution) {
      return null;
    }

    execution.pendingCheckpoint = null;
    execution.updatedAt = new Date().toISOString();

    this._scheduleSave();

    return { ...execution };
  }

  /**
   * Gets an execution by ID
   * @param {string} executionId - The execution identifier
   * @returns {Object|null} Execution metadata or null if not found
   */
  get(executionId) {
    const execution = this.executions.get(executionId);
    return execution ? { ...execution } : null;
  }

  /**
   * Gets all executions for a specific user
   * @param {string} userId - The user identifier
   * @param {Object} [filters] - Optional filters
   * @param {string} [filters.status] - Filter by status
   * @param {number} [filters.limit] - Maximum number of results
   * @param {number} [filters.offset] - Skip first N results
   * @returns {Object[]} Array of execution metadata
   *
   * @example
   * const runningExecutions = registry.getByUser('user-1', { status: 'running' });
   * const recentExecutions = registry.getByUser('user-1', { limit: 10 });
   */
  getByUser(userId, filters = {}) {
    const executionIds = this.userExecutions.get(userId);

    if (!executionIds || executionIds.size === 0) {
      return [];
    }

    let executions = Array.from(executionIds)
      .map(id => this.executions.get(id))
      .filter(Boolean);

    // Apply status filter
    if (filters.status) {
      executions = executions.filter(e => e.status === filters.status);
    }

    // Sort by startedAt descending (most recent first)
    executions.sort((a, b) => new Date(b.startedAt) - new Date(a.startedAt));

    // Apply offset
    if (filters.offset && filters.offset > 0) {
      executions = executions.slice(filters.offset);
    }

    // Apply limit
    if (filters.limit && filters.limit > 0) {
      executions = executions.slice(0, filters.limit);
    }

    return executions.map(e => ({ ...e }));
  }

  /**
   * Gets all active (running or paused) executions
   * @returns {Object[]} Array of active execution metadata
   */
  getActive() {
    return Array.from(this.executions.values())
      .filter(e => e.status === WorkflowStatus.RUNNING || e.status === WorkflowStatus.PAUSED)
      .map(e => ({ ...e }));
  }

  /**
   * Gets all executions that are paused with pending checkpoints
   * @returns {Object[]} Array of executions awaiting human input
   */
  getPendingCheckpoints() {
    return Array.from(this.executions.values())
      .filter(e => e.status === WorkflowStatus.PAUSED && e.pendingCheckpoint)
      .map(e => ({ ...e }));
  }

  /**
   * Removes an execution from the registry
   * @param {string} executionId - The execution identifier
   * @returns {boolean} True if removed, false if not found
   */
  remove(executionId) {
    const execution = this.executions.get(executionId);

    if (!execution) {
      return false;
    }

    // Remove from user index
    const userSet = this.userExecutions.get(execution.userId);
    if (userSet) {
      userSet.delete(executionId);
      if (userSet.size === 0) {
        this.userExecutions.delete(execution.userId);
      }
    }

    // Remove from main map
    this.executions.delete(executionId);

    logger.info({
      component: 'ExecutionRegistry',
      message: 'Removed execution from registry',
      executionId
    });

    // Schedule save
    this._scheduleSave();

    return true;
  }

  /**
   * Loads registry state from disk
   * Scans the workflow-state directory for checkpoint files and rebuilds the registry
   * @returns {Promise<void>}
   */
  async loadFromDisk() {
    try {
      // First try to load from registry file
      const registryPath = path.join(this.stateDir, REGISTRY_FILE);

      try {
        const data = await fs.readFile(registryPath, 'utf8');
        const parsed = JSON.parse(data);

        if (parsed.executions && Array.isArray(parsed.executions)) {
          for (const execution of parsed.executions) {
            this.executions.set(execution.executionId, execution);

            // Rebuild user index
            if (!this.userExecutions.has(execution.userId)) {
              this.userExecutions.set(execution.userId, new Set());
            }
            this.userExecutions.get(execution.userId).add(execution.executionId);
          }

          logger.info({
            component: 'ExecutionRegistry',
            message: 'Loaded registry from file',
            executionCount: this.executions.size
          });
        }
      } catch (err) {
        if (err.code !== 'ENOENT') {
          logger.warn({
            component: 'ExecutionRegistry',
            message: 'Error loading registry file, will rebuild from checkpoints',
            error: err.message
          });
        }
      }

      // Scan checkpoint directories to recover any missed executions
      await this._scanCheckpointDirectories();

      this._loaded = true;

      logger.info({
        component: 'ExecutionRegistry',
        message: 'Registry loaded',
        totalExecutions: this.executions.size,
        activeExecutions: this.getActive().length
      });
    } catch (error) {
      logger.error({
        component: 'ExecutionRegistry',
        message: 'Failed to load registry from disk',
        error: error.message
      });
      this._loaded = true; // Mark as loaded even on error to allow fresh start
    }
  }

  /**
   * Scans checkpoint directories to recover execution metadata
   * @private
   */
  async _scanCheckpointDirectories() {
    try {
      const entries = await fs.readdir(this.stateDir, { withFileTypes: true });

      for (const entry of entries) {
        // Skip registry file and non-directories
        if (!entry.isDirectory() || entry.name === REGISTRY_FILE) {
          continue;
        }

        const executionId = entry.name;

        // Skip if already in registry
        if (this.executions.has(executionId)) {
          continue;
        }

        // Try to load latest checkpoint
        try {
          const latestPath = path.join(this.stateDir, executionId, 'latest.json');
          const data = await fs.readFile(latestPath, 'utf8');
          const state = JSON.parse(data);

          // Extract metadata from checkpoint
          const execution = {
            executionId,
            userId: state.data?._workflow?.startedBy || 'unknown',
            workflowId: state.workflowId || 'unknown',
            workflowName: { en: state.workflowId || 'Unknown Workflow' },
            status: state.status || WorkflowStatus.PENDING,
            startedAt: state.createdAt || new Date().toISOString(),
            updatedAt: state.updatedAt || new Date().toISOString(),
            currentNode: state.currentNodes?.[0] || null,
            pendingCheckpoint: state.pendingCheckpoint || null,
            completedAt: state.completedAt || null
          };

          this.executions.set(executionId, execution);

          // Update user index
          if (!this.userExecutions.has(execution.userId)) {
            this.userExecutions.set(execution.userId, new Set());
          }
          this.userExecutions.get(execution.userId).add(executionId);

          logger.info({
            component: 'ExecutionRegistry',
            message: 'Recovered execution from checkpoint',
            executionId,
            status: execution.status
          });
        } catch (err) {
          // Skip directories without valid checkpoints
          logger.debug({
            component: 'ExecutionRegistry',
            message: 'Skipping directory without valid checkpoint',
            executionId,
            error: err.message
          });
        }
      }
    } catch (err) {
      if (err.code === 'ENOENT') {
        // State directory doesn't exist yet, that's fine
        logger.debug({
          component: 'ExecutionRegistry',
          message: 'State directory does not exist yet'
        });
      } else {
        throw err;
      }
    }
  }

  /**
   * Saves registry state to disk
   * @returns {Promise<void>}
   */
  async saveToDisk() {
    try {
      // Ensure directory exists
      await fs.mkdir(this.stateDir, { recursive: true });

      const registryPath = path.join(this.stateDir, REGISTRY_FILE);
      const data = {
        version: 1,
        savedAt: new Date().toISOString(),
        executions: Array.from(this.executions.values())
      };

      await fs.writeFile(registryPath, JSON.stringify(data, null, 2), 'utf8');

      logger.debug({
        component: 'ExecutionRegistry',
        message: 'Saved registry to disk',
        executionCount: this.executions.size
      });
    } catch (error) {
      logger.error({
        component: 'ExecutionRegistry',
        message: 'Failed to save registry to disk',
        error: error.message
      });
    }
  }

  /**
   * Schedules a debounced save operation
   * @private
   */
  _scheduleSave() {
    if (this._saveTimer) {
      clearTimeout(this._saveTimer);
    }

    this._saveTimer = setTimeout(() => {
      this.saveToDisk();
      this._saveTimer = null;
    }, this._saveDelay);
  }

  /**
   * Gets statistics about the registry
   * @returns {Object} Registry statistics
   */
  getStats() {
    const statuses = {};

    for (const execution of this.executions.values()) {
      statuses[execution.status] = (statuses[execution.status] || 0) + 1;
    }

    return {
      totalExecutions: this.executions.size,
      totalUsers: this.userExecutions.size,
      byStatus: statuses
    };
  }
}

// Singleton instance for application-wide use
let registryInstance = null;

/**
 * Gets the singleton ExecutionRegistry instance
 * @param {Object} [options] - Options for creating the instance
 * @returns {ExecutionRegistry} The registry instance
 */
export function getExecutionRegistry(options = {}) {
  if (!registryInstance) {
    registryInstance = new ExecutionRegistry(options);
  }
  return registryInstance;
}

/**
 * Resets the singleton instance (useful for testing)
 */
export function resetExecutionRegistry() {
  registryInstance = null;
}

export default ExecutionRegistry;
