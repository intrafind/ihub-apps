/**
 * Parallel Node Executor for workflow DAG processing.
 *
 * Executes multiple branches concurrently using Promise.allSettled,
 * so that a failure in one branch does not prevent others from completing.
 * Each branch contains a sequential list of nodes that are executed in order.
 *
 * Branch results are collected into a keyed object (branch.id -> result)
 * and optionally stored in a workflow state variable.
 *
 * @module services/workflow/executors/ParallelNodeExecutor
 */

import { BaseNodeExecutor } from './BaseNodeExecutor.js';
import logger from '../../../utils/logger.js';

/**
 * Executor that runs multiple node branches in parallel.
 *
 * @extends BaseNodeExecutor
 *
 * @example
 * // Parallel node config
 * {
 *   id: 'parallel-1',
 *   type: 'parallel',
 *   config: {
 *     outputVariable: 'parallelResults',
 *     branches: [
 *       {
 *         id: 'branch-a',
 *         nodes: [
 *           { id: 'agent-1', type: 'agent', config: { ... } }
 *         ]
 *       },
 *       {
 *         id: 'branch-b',
 *         nodes: [
 *           { id: 'tool-1', type: 'tool', config: { ... } },
 *           { id: 'transform-1', type: 'transform', config: { ... } }
 *         ]
 *       }
 *     ]
 *   }
 * }
 */
export class ParallelNodeExecutor extends BaseNodeExecutor {
  /**
   * Create a new ParallelNodeExecutor.
   * @param {Object} [options] - Executor options passed to BaseNodeExecutor
   */
  constructor(options = {}) {
    super(options);
  }

  /**
   * Execute all branches concurrently and collect their results.
   *
   * Each branch receives an isolated copy of the current workflow state.
   * Branches do not share state changes with each other during execution.
   * All branch results (including failures) are returned in the output.
   *
   * @param {import('./BaseNodeExecutor.js').WorkflowNode} node - The parallel node to execute
   * @param {import('./BaseNodeExecutor.js').WorkflowState} state - Current workflow state
   * @param {import('./BaseNodeExecutor.js').ExecutionContext} context - Execution context
   * @returns {Promise<import('./BaseNodeExecutor.js').ExecutionResult>} Result containing
   *   a map of branch IDs to their respective results
   */
  async execute(node, state, context) {
    const { config = {} } = node;
    const { branches = [], outputVariable } = config;

    if (branches.length === 0) {
      return this.createSuccessResult(
        { branches: [] },
        {
          stateUpdates: outputVariable ? { [outputVariable]: {} } : undefined
        }
      );
    }

    try {
      const branchPromises = branches.map(branch => this.executeBranch(branch, state, context));

      const results = await Promise.allSettled(branchPromises);

      const branchResults = {};
      for (let i = 0; i < branches.length; i++) {
        const branch = branches[i];
        const result = results[i];

        if (result.status === 'fulfilled') {
          branchResults[branch.id] = result.value;
        } else {
          branchResults[branch.id] = {
            output: null,
            failed: true,
            error: result.reason?.message || 'Branch failed'
          };
        }
      }

      logger.info({
        component: 'ParallelNodeExecutor',
        message: `Parallel execution completed for node '${node.id}'`,
        nodeId: node.id,
        branchCount: branches.length,
        successCount: results.filter(r => r.status === 'fulfilled').length
      });

      return this.createSuccessResult(
        { branches: branchResults },
        {
          stateUpdates: outputVariable ? { [outputVariable]: branchResults } : undefined
        }
      );
    } catch (error) {
      return this.createErrorResult(`Parallel execution failed: ${error.message}`, {
        nodeId: node.id,
        error: error.message
      });
    }
  }

  /**
   * Execute a single branch by running its nodes sequentially.
   *
   * Each branch operates on an isolated copy of the workflow state so that
   * concurrent branches do not interfere with each other. If any node in
   * the branch fails, execution stops and the partial results are returned.
   *
   * @param {Object} branch - Branch definition
   * @param {string} branch.id - Unique branch identifier
   * @param {Array<import('./BaseNodeExecutor.js').WorkflowNode>} branch.nodes - Nodes to execute in order
   * @param {import('./BaseNodeExecutor.js').WorkflowState} state - Workflow state (will be shallow-copied)
   * @param {import('./BaseNodeExecutor.js').ExecutionContext} context - Execution context
   * @returns {Promise<{output: Array, failed: boolean, error?: string}>} Branch execution result
   */
  async executeBranch(branch, state, context) {
    // Lazy import to avoid circular dependency with index.js
    const { getExecutor } = await import('./index.js');

    let currentState = { ...state, data: { ...state.data } };
    const outputs = [];

    for (const branchNode of branch.nodes || []) {
      const executor = getExecutor(branchNode.type);
      const result = await executor.execute(branchNode, currentState, context);

      if (result.stateUpdates) {
        currentState.data = { ...currentState.data, ...result.stateUpdates };
      }

      outputs.push(result);

      if (result.status === 'failed') {
        return { output: outputs, failed: true, error: result.error };
      }
    }

    return { output: outputs, failed: false };
  }
}

export default ParallelNodeExecutor;
