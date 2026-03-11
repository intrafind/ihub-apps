/**
 * Executor for workflow parallel nodes.
 *
 * Parallel nodes execute multiple branches concurrently. Each branch contains
 * a sequence of inline node configs that run sequentially within the branch.
 * All branches run concurrently via Promise.allSettled, ensuring that a failed
 * branch does not prevent other branches from completing.
 *
 * Results are keyed by branch id and stored in the outputVariable for downstream
 * use by a JoinNodeExecutor or other nodes.
 *
 * @module services/workflow/executors/ParallelNodeExecutor
 */

import { BaseNodeExecutor } from './BaseNodeExecutor.js';

/**
 * Parallel node configuration
 * @typedef {Object} ParallelNodeConfig
 * @property {Array<BranchConfig>} branches - Branch definitions to run concurrently
 * @property {string} [outputVariable] - Where to store per-branch results object
 */

/**
 * Branch configuration
 * @typedef {Object} BranchConfig
 * @property {string} id - Unique branch identifier
 * @property {Array<Object>} nodes - Inline node configs to execute sequentially
 */

/**
 * Executor for parallel nodes.
 *
 * Parallel nodes are responsible for:
 * - Running multiple branches concurrently
 * - Executing branch nodes sequentially within each branch
 * - Collecting and storing per-branch results
 * - Tolerating branch failures without failing the entire workflow
 *
 * @extends BaseNodeExecutor
 *
 * @example
 * {
 *   id: 'parallel-research',
 *   type: 'parallel',
 *   name: 'Research in Parallel',
 *   config: {
 *     outputVariable: 'branchResults',
 *     branches: [
 *       {
 *         id: 'branch-a',
 *         nodes: [{ id: 'step-a1', type: 'agent', config: { ... } }]
 *       },
 *       {
 *         id: 'branch-b',
 *         nodes: [{ id: 'step-b1', type: 'tool', config: { ... } }]
 *       }
 *     ]
 *   }
 * }
 */
export class ParallelNodeExecutor extends BaseNodeExecutor {
  /**
   * Create a new ParallelNodeExecutor
   * @param {Object} options - Executor options
   */
  constructor(options = {}) {
    super(options);
  }

  /**
   * Execute the parallel node.
   *
   * Runs all branches concurrently and collects results keyed by branch id.
   *
   * @param {Object} node - The parallel node configuration
   * @param {Object} state - Current workflow state
   * @param {Object} context - Execution context
   * @returns {Promise<Object>} Execution result with branch outputs
   */
  async execute(node, state, context) {
    const { config = {} } = node;
    const branches = config.branches || [];
    const outputVariable = config.outputVariable;

    this.logger.info({
      component: 'ParallelNodeExecutor',
      message: `Executing parallel node '${node.id}'`,
      nodeId: node.id,
      branchCount: branches.length
    });

    if (branches.length === 0) {
      this.logger.warn({
        component: 'ParallelNodeExecutor',
        message: `Parallel node '${node.id}' has no branches`
      });

      const stateUpdates = outputVariable ? { [outputVariable]: {} } : {};
      return this.createSuccessResult({ branchResults: {} }, { stateUpdates });
    }

    try {
      const branchPromises = branches.map(branch => this.executeBranch(branch, state, context));
      const settled = await Promise.allSettled(branchPromises);

      const branchResults = {};

      settled.forEach((settlement, index) => {
        const branch = branches[index];
        if (settlement.status === 'rejected') {
          this.logger.warn({
            component: 'ParallelNodeExecutor',
            message: `Branch '${branch.id}' rejected: ${settlement.reason?.message || settlement.reason}`,
            nodeId: node.id,
            branchId: branch.id
          });
          branchResults[branch.id] = {
            error: settlement.reason?.message || String(settlement.reason)
          };
        } else {
          const val = settlement.value;
          if (val.failed) {
            this.logger.warn({
              component: 'ParallelNodeExecutor',
              message: `Branch '${branch.id}' had a node failure: ${val.error}`,
              nodeId: node.id,
              branchId: branch.id
            });
            branchResults[branch.id] = { error: val.error };
          } else {
            branchResults[branch.id] = val.output;
          }
        }
      });

      const stateUpdates = outputVariable ? { [outputVariable]: branchResults } : {};

      this.logger.info({
        component: 'ParallelNodeExecutor',
        message: `Parallel node '${node.id}' completed`,
        nodeId: node.id,
        completedBranches: Object.keys(branchResults).length
      });

      return this.createSuccessResult({ branchResults }, { stateUpdates });
    } catch (error) {
      this.logger.error({
        component: 'ParallelNodeExecutor',
        message: `Parallel node '${node.id}' failed`,
        nodeId: node.id,
        error: error.message,
        stack: error.stack
      });

      return this.createErrorResult(`Parallel execution failed: ${error.message}`, {
        nodeId: node.id,
        originalError: error.message
      });
    }
  }

  /**
   * Execute a single branch by running its nodes sequentially.
   *
   * Returns `{output, failed, error}`. If any node in the branch fails, execution
   * stops for that branch and `failed: true` is returned so the caller can surface
   * the failure to JoinNodeExecutor error detection.
   *
   * @param {BranchConfig} branch - Branch configuration
   * @param {Object} state - Current workflow state
   * @param {Object} context - Execution context
   * @returns {Promise<{output: *, failed: boolean, error: string|undefined}>}
   * @private
   */
  async executeBranch(branch, state, context) {
    const nodes = branch.nodes || [];

    if (nodes.length === 0) {
      return { output: null, failed: false };
    }

    // Lazy import to avoid circular dependency
    const { getExecutor } = await import('./index.js');

    let lastOutput = null;
    let currentState = { ...state };

    for (const nodeConfig of nodes) {
      const executor = getExecutor(nodeConfig.type);
      const result = await executor.execute(nodeConfig, currentState, context);

      // Propagate state updates within the branch
      if (result.stateUpdates) {
        currentState = {
          ...currentState,
          data: {
            ...currentState.data,
            ...result.stateUpdates
          }
        };
      }

      if (result.status === 'failed') {
        this.logger.warn({
          component: 'ParallelNodeExecutor',
          message: `Node '${nodeConfig.id}' in branch '${branch.id}' failed: ${result.error}`
        });
        return { output: null, failed: true, error: result.error };
      }

      lastOutput = result.output;
    }

    return { output: lastOutput, failed: false };
  }
}

export default ParallelNodeExecutor;
