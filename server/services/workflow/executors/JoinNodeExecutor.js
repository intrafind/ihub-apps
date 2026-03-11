/**
 * Executor for workflow join nodes.
 *
 * Join nodes act as synchronization points that merge outputs from parallel
 * branches. They read branch results from a preceding parallel node's
 * outputVariable and apply a merge strategy to produce a single output.
 *
 * Supported merge strategies:
 * - 'all': Merge all branch results into a single object (default)
 * - 'any': Return the first non-null/non-error branch result
 * - 'majority': Return results that appeared in majority of branches
 *
 * Note: For MVP this is a sequential synchronization point. True parallel
 * execution with separate state will be added in a future iteration.
 *
 * @module services/workflow/executors/JoinNodeExecutor
 */

import { BaseNodeExecutor } from './BaseNodeExecutor.js';

/**
 * Join node configuration
 * @typedef {Object} JoinNodeConfig
 * @property {'all'|'any'|'majority'} [strategy] - Merge strategy (default: 'all')
 * @property {string} [outputVariable] - Where to store merged result
 * @property {Array<string>} [inputVariables] - Variable paths to merge from state
 */

/**
 * Executor for join nodes.
 *
 * Join nodes are responsible for:
 * - Reading branch results produced by a preceding parallel node
 * - Applying a merge strategy to produce a single consolidated output
 * - Storing the merged result in outputVariable
 *
 * @extends BaseNodeExecutor
 *
 * @example
 * // Join after parallel node
 * {
 *   id: 'join-results',
 *   type: 'join',
 *   name: 'Merge Branch Results',
 *   config: {
 *     strategy: 'all',
 *     outputVariable: 'mergedResults',
 *     inputVariables: ['$.data.branchResults']
 *   }
 * }
 */
export class JoinNodeExecutor extends BaseNodeExecutor {
  /**
   * Create a new JoinNodeExecutor
   * @param {Object} options - Executor options
   */
  constructor(options = {}) {
    super(options);
  }

  /**
   * Execute the join node.
   *
   * Reads branch results from state and applies the configured merge strategy.
   *
   * @param {Object} node - The join node configuration
   * @param {Object} state - Current workflow state
   * @param {Object} context - Execution context
   * @returns {Promise<Object>} Execution result with merged output
   */
  async execute(node, state, _context) {
    const { config = {} } = node;
    const strategy = config.strategy || 'all';
    const outputVariable = config.outputVariable;
    const inputVariables = config.inputVariables || [];

    this.logger.info({
      component: 'JoinNodeExecutor',
      message: `Executing join node '${node.id}'`,
      nodeId: node.id,
      strategy,
      inputVariables
    });

    try {
      // Collect branch results from specified input variables
      const collectedData = this.collectInputData(inputVariables, state);

      // Apply merge strategy
      const mergedResult = this.applyStrategy(strategy, collectedData, node.id);

      const stateUpdates = outputVariable ? { [outputVariable]: mergedResult } : {};

      this.logger.info({
        component: 'JoinNodeExecutor',
        message: `Join node '${node.id}' completed`,
        nodeId: node.id,
        strategy,
        resultType: typeof mergedResult
      });

      return this.createSuccessResult(mergedResult, { stateUpdates });
    } catch (error) {
      this.logger.error({
        component: 'JoinNodeExecutor',
        message: `Join node '${node.id}' failed`,
        nodeId: node.id,
        error: error.message,
        stack: error.stack
      });

      return this.createErrorResult(`Join execution failed: ${error.message}`, {
        nodeId: node.id,
        originalError: error.message
      });
    }
  }

  /**
   * Collect input data from the specified variable paths.
   *
   * @param {Array<string>} inputVariables - Variable paths to resolve from state
   * @param {Object} state - Current workflow state
   * @returns {Array<*>} Array of resolved values
   * @private
   */
  collectInputData(inputVariables, state) {
    if (inputVariables.length === 0) {
      return [];
    }

    return inputVariables
      .map(varPath => this.resolveVariable(varPath, state))
      .filter(v => v !== undefined);
  }

  /**
   * Apply the merge strategy to the collected branch results.
   *
   * @param {string} strategy - Merge strategy
   * @param {Array<*>} data - Collected input data
   * @param {string} nodeId - Node ID for logging
   * @returns {*} Merged result
   * @private
   */
  applyStrategy(strategy, data, nodeId) {
    if (data.length === 0) {
      this.logger.warn({
        component: 'JoinNodeExecutor',
        message: `Join node '${nodeId}' has no input data to merge`
      });
      return null;
    }

    switch (strategy) {
      case 'all':
        return this.mergeAll(data);
      case 'any':
        return this.mergeAny(data);
      case 'majority':
        return this.mergeMajority(data);
      default:
        this.logger.warn({
          component: 'JoinNodeExecutor',
          message: `Unknown join strategy '${strategy}', defaulting to 'all'`
        });
        return this.mergeAll(data);
    }
  }

  /**
   * Merge strategy 'all': merge all branch results into a single object.
   * Object results are spread-merged; non-object results are collected in array.
   *
   * @param {Array<*>} data - Input data array
   * @returns {Object|Array} Merged result
   * @private
   */
  mergeAll(data) {
    // If all items are objects (branch result maps), merge them together
    const allObjects = data.every(d => d !== null && typeof d === 'object' && !Array.isArray(d));

    if (allObjects) {
      return Object.assign({}, ...data);
    }

    // Otherwise return array of all values
    return data;
  }

  /**
   * Merge strategy 'any': return the first non-null, non-error branch result.
   *
   * @param {Array<*>} data - Input data array
   * @returns {*} First valid result or null
   * @private
   */
  mergeAny(data) {
    for (const item of data) {
      if (item === null || item === undefined) {
        continue;
      }

      // Skip error objects (from failed branches)
      if (typeof item === 'object' && !Array.isArray(item)) {
        // Check if it's a branch results map with at least one non-error entry
        const values = Object.values(item);
        const nonError = values.find(v => v !== null && !(typeof v === 'object' && 'error' in v));
        if (nonError !== undefined) {
          return nonError;
        }
        continue;
      }

      return item;
    }

    return null;
  }

  /**
   * Merge strategy 'majority': return results that appeared in majority of branches.
   * For branch result maps, returns branches whose results are non-null and non-error.
   *
   * @param {Array<*>} data - Input data array
   * @returns {*} Majority results
   * @private
   */
  mergeMajority(data) {
    // For branch result maps, filter branches with successful (non-error) results
    const allObjects = data.every(d => d !== null && typeof d === 'object' && !Array.isArray(d));

    if (allObjects) {
      const merged = Object.assign({}, ...data);
      const entries = Object.entries(merged);
      const total = entries.length;
      const threshold = Math.ceil(total / 2);

      // Count non-error, non-null entries
      const successfulEntries = entries.filter(
        ([, v]) => v !== null && !(typeof v === 'object' && 'error' in v)
      );

      if (successfulEntries.length >= threshold) {
        return Object.fromEntries(successfulEntries);
      }

      // Fallback: return all
      return merged;
    }

    // For non-object data, filter out null/undefined values
    const nonNull = data.filter(d => d !== null && d !== undefined);
    const threshold = Math.ceil(data.length / 2);

    return nonNull.length >= threshold ? nonNull : data;
  }
}

export default JoinNodeExecutor;
