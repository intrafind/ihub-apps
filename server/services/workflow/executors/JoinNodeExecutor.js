/**
 * Join Node Executor for workflow DAG processing.
 *
 * Merges results from multiple parallel branches (or any set of state variables)
 * into a single output using one of three strategies:
 *
 * - `all`: Object-spread merge of all inputs into a single object
 * - `any`: Pick the first non-null, non-error result
 * - `majority`: Pick the most common non-error result (by JSON equality)
 *
 * Typically placed after a ParallelNodeExecutor to combine branch outputs,
 * but can also be used standalone to merge arbitrary state variables.
 *
 * @module services/workflow/executors/JoinNodeExecutor
 */

import { BaseNodeExecutor } from './BaseNodeExecutor.js';
import logger from '../../../utils/logger.js';

/**
 * Executor that merges multiple inputs into a single output.
 *
 * @extends BaseNodeExecutor
 *
 * @example
 * // Join node config - merge all parallel branch results
 * {
 *   id: 'join-1',
 *   type: 'join',
 *   config: {
 *     strategy: 'all',
 *     inputVariables: ['parallelResults'],
 *     outputVariable: 'mergedResult'
 *   }
 * }
 *
 * @example
 * // Join node config - pick first successful result
 * {
 *   id: 'join-2',
 *   type: 'join',
 *   config: {
 *     strategy: 'any',
 *     inputVariables: ['resultA', 'resultB', 'resultC'],
 *     outputVariable: 'bestResult'
 *   }
 * }
 */
export class JoinNodeExecutor extends BaseNodeExecutor {
  /**
   * Create a new JoinNodeExecutor.
   * @param {Object} [options] - Executor options passed to BaseNodeExecutor
   */
  constructor(options = {}) {
    super(options);
  }

  /**
   * Execute the join by collecting inputs and merging them with the selected strategy.
   *
   * @param {import('./BaseNodeExecutor.js').WorkflowNode} node - The join node to execute
   * @param {import('./BaseNodeExecutor.js').WorkflowState} state - Current workflow state
   * @param {import('./BaseNodeExecutor.js').ExecutionContext} _context - Execution context (unused)
   * @returns {Promise<import('./BaseNodeExecutor.js').ExecutionResult>} Merged result
   */
  async execute(node, state, _context) {
    const { config = {} } = node;
    const { strategy = 'all', outputVariable, inputVariables = [] } = config;

    try {
      // Collect inputs from specified variables or fall back to nodeResults
      const inputs = this.collectInputs(inputVariables, state);

      let output;
      switch (strategy) {
        case 'all':
          // Object-spread merge: flatten all object inputs into one, keep non-objects keyed
          output = {};
          for (const [key, value] of Object.entries(inputs)) {
            if (value && typeof value === 'object' && !Array.isArray(value)) {
              Object.assign(output, value);
            } else {
              output[key] = value;
            }
          }
          break;

        case 'any':
          // First non-null, non-error result
          output = Object.values(inputs).find(v => v !== null && v !== undefined && !v?.error);
          if (output === undefined) output = Object.values(inputs)[0];
          break;

        case 'majority': {
          // Most common non-error result determined by JSON equality
          const counts = new Map();
          for (const value of Object.values(inputs)) {
            if (value?.error) continue;
            const serialized = JSON.stringify(value);
            counts.set(serialized, (counts.get(serialized) || 0) + 1);
          }
          let maxCount = 0;
          let majorityKey = null;
          for (const [key, count] of counts) {
            if (count > maxCount) {
              maxCount = count;
              majorityKey = key;
            }
          }
          output = majorityKey ? JSON.parse(majorityKey) : Object.values(inputs)[0];
          break;
        }

        default:
          return this.createErrorResult(`Unknown join strategy: ${strategy}`, {
            nodeId: node.id
          });
      }

      logger.info({
        component: 'JoinNodeExecutor',
        message: `Join completed for node '${node.id}' with strategy '${strategy}'`,
        nodeId: node.id,
        inputCount: Object.keys(inputs).length
      });

      return this.createSuccessResult(output, {
        stateUpdates: outputVariable ? { [outputVariable]: output } : undefined
      });
    } catch (error) {
      return this.createErrorResult(`Join failed: ${error.message}`, {
        nodeId: node.id,
        error: error.message
      });
    }
  }

  /**
   * Collect inputs from workflow state for the join operation.
   *
   * If `inputVariables` are specified, reads those keys from `state.data`.
   * Otherwise falls back to all entries in `state.data.nodeResults`.
   *
   * @param {Array<string>} inputVariables - Variable names to collect from state.data
   * @param {import('./BaseNodeExecutor.js').WorkflowState} state - Current workflow state
   * @returns {Object<string, *>} Map of variable name to value
   */
  collectInputs(inputVariables, state) {
    const inputs = {};

    if (inputVariables.length > 0) {
      for (const varName of inputVariables) {
        inputs[varName] = state.data?.[varName];
      }
    } else {
      // Fall back to all node results when no specific variables are listed
      const nodeResults = state.data?.nodeResults || {};
      for (const [key, value] of Object.entries(nodeResults)) {
        inputs[key] = value?.output || value;
      }
    }

    return inputs;
  }
}

export default JoinNodeExecutor;
