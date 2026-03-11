/**
 * Executor for workflow loop nodes.
 *
 * Loop nodes iterate over a collection or repeat execution until a condition is met.
 * They support three modes:
 * - 'for': Fixed count-based iteration (0..count-1)
 * - 'forEach': Iterate over an array of items
 * - 'while': Condition-based iteration (evaluated before each iteration)
 *
 * Body nodes are executed inline (not as sub-workflows) for performance.
 * Outputs from each iteration are collected and stored in the outputVariable.
 *
 * @module services/workflow/executors/LoopNodeExecutor
 */

import vm from 'vm';
import { BaseNodeExecutor } from './BaseNodeExecutor.js';

const DEFAULT_MAX_ITERATIONS = 50;
const HARD_MAX_ITERATIONS = 200;

/**
 * Loop node configuration
 * @typedef {Object} LoopNodeConfig
 * @property {'for'|'forEach'|'while'} mode - Loop mode
 * @property {number} [count] - Number of iterations (for 'for' mode)
 * @property {string} [array] - Variable path to array (for 'forEach' mode, e.g., '$.data.items')
 * @property {string} [condition] - Condition expression (for 'while' mode)
 * @property {number} [maxIterations] - Max iterations cap (default 50, hard max 200)
 * @property {Array<Object>} [body] - Inline node configs to execute each iteration
 * @property {string} [outputVariable] - Where to store collected outputs array
 */

/**
 * Executor for loop nodes.
 *
 * Loop nodes are responsible for:
 * - Iterating over a fixed count, array, or condition
 * - Executing body nodes inline for each iteration
 * - Collecting and storing per-iteration outputs
 * - Enforcing iteration limits to prevent infinite loops
 *
 * @extends BaseNodeExecutor
 *
 * @example
 * // forEach loop
 * {
 *   id: 'process-items',
 *   type: 'loop',
 *   name: 'Process Each Item',
 *   config: {
 *     mode: 'forEach',
 *     array: '$.data.items',
 *     outputVariable: 'processedItems',
 *     body: [
 *       { id: 'step1', type: 'transform', config: { operations: [...] } }
 *     ]
 *   }
 * }
 *
 * @example
 * // for loop
 * {
 *   id: 'repeat-task',
 *   type: 'loop',
 *   config: {
 *     mode: 'for',
 *     count: 5,
 *     outputVariable: 'results',
 *     body: []
 *   }
 * }
 */
export class LoopNodeExecutor extends BaseNodeExecutor {
  /**
   * Create a new LoopNodeExecutor
   * @param {Object} options - Executor options
   */
  constructor(options = {}) {
    super(options);
  }

  /**
   * Execute the loop node.
   *
   * Runs body nodes for each iteration and collects outputs.
   *
   * @param {Object} node - The loop node configuration
   * @param {Object} state - Current workflow state
   * @param {Object} context - Execution context
   * @returns {Promise<Object>} Execution result with collected iteration outputs
   */
  async execute(node, state, context) {
    const { config = {} } = node;
    const mode = config.mode || 'for';
    const bodyNodes = config.body || [];
    const outputVariable = config.outputVariable;

    const rawMax = config.maxIterations ?? DEFAULT_MAX_ITERATIONS;
    const maxIterations = Math.min(rawMax, HARD_MAX_ITERATIONS);

    this.logger.info({
      component: 'LoopNodeExecutor',
      message: `Executing loop node '${node.id}'`,
      nodeId: node.id,
      mode,
      maxIterations,
      bodyNodeCount: bodyNodes.length
    });

    try {
      const iterationOutputs = [];

      if (mode === 'for') {
        await this.executeForLoop(
          config,
          state,
          context,
          bodyNodes,
          maxIterations,
          iterationOutputs
        );
      } else if (mode === 'forEach') {
        await this.executeForEachLoop(
          config,
          state,
          context,
          bodyNodes,
          maxIterations,
          iterationOutputs
        );
      } else if (mode === 'while') {
        await this.executeWhileLoop(
          config,
          state,
          context,
          bodyNodes,
          maxIterations,
          iterationOutputs
        );
      } else {
        return this.createErrorResult(`Unknown loop mode: '${mode}'`, { nodeId: node.id });
      }

      const stateUpdates = {};
      if (outputVariable) {
        stateUpdates[outputVariable] = iterationOutputs;
      }

      this.logger.info({
        component: 'LoopNodeExecutor',
        message: `Loop node '${node.id}' completed`,
        nodeId: node.id,
        mode,
        iterations: iterationOutputs.length
      });

      return this.createSuccessResult(
        { iterations: iterationOutputs.length, outputs: iterationOutputs },
        { stateUpdates }
      );
    } catch (error) {
      this.logger.error({
        component: 'LoopNodeExecutor',
        message: `Loop node '${node.id}' failed`,
        nodeId: node.id,
        error: error.message,
        stack: error.stack
      });

      return this.createErrorResult(`Loop execution failed: ${error.message}`, {
        nodeId: node.id,
        originalError: error.message
      });
    }
  }

  /**
   * Execute a fixed-count for loop.
   * @private
   */
  async executeForLoop(config, state, context, bodyNodes, maxIterations, iterationOutputs) {
    const count = Math.min(config.count ?? 0, maxIterations);

    for (let i = 0; i < count; i++) {
      const iterState = this.buildIterationState(state, i, undefined, count);
      const output = await this.executeBodyNodes(bodyNodes, iterState, context);
      iterationOutputs.push({ index: i, output });
    }
  }

  /**
   * Execute a forEach loop over an array.
   * @private
   */
  async executeForEachLoop(config, state, context, bodyNodes, maxIterations, iterationOutputs) {
    const items = this.resolveVariable(config.array, state);

    if (!Array.isArray(items)) {
      this.logger.warn({
        component: 'LoopNodeExecutor',
        message: `forEach array '${config.array}' did not resolve to an array`,
        resolved: typeof items
      });
      return;
    }

    const total = Math.min(items.length, maxIterations);

    for (let i = 0; i < total; i++) {
      const iterState = this.buildIterationState(state, i, items[i], items.length);
      const output = await this.executeBodyNodes(bodyNodes, iterState, context);
      iterationOutputs.push({ index: i, item: items[i], output });
    }
  }

  /**
   * Execute a while loop until condition is false or maxIterations reached.
   * @private
   */
  async executeWhileLoop(config, state, context, bodyNodes, maxIterations, iterationOutputs) {
    const condition = config.condition;

    if (!condition) {
      this.logger.warn({
        component: 'LoopNodeExecutor',
        message: 'While loop has no condition - skipping'
      });
      return;
    }

    let currentState = state;
    let lastOutput = null;
    let i = 0;

    while (i < maxIterations) {
      let conditionResult;

      try {
        conditionResult = vm.runInNewContext(
          condition,
          { data: currentState.data, result: lastOutput },
          { timeout: 1000 }
        );
      } catch (err) {
        this.logger.warn({
          component: 'LoopNodeExecutor',
          message: `While condition evaluation failed at iteration ${i}: ${err.message}`
        });
        break;
      }

      if (!conditionResult) {
        break;
      }

      const iterState = this.buildIterationState(currentState, i, undefined, null);
      lastOutput = await this.executeBodyNodes(bodyNodes, iterState, context);
      iterationOutputs.push({ index: i, output: lastOutput });

      // Carry state updates forward for next iteration's condition evaluation
      currentState = {
        ...currentState,
        data: {
          ...currentState.data,
          _loopIndex: i,
          _loopTotal: null
        }
      };

      i++;
    }

    if (i >= maxIterations) {
      this.logger.warn({
        component: 'LoopNodeExecutor',
        message: `While loop reached maxIterations (${maxIterations}) - stopping`
      });
    }
  }

  /**
   * Build state for a single loop iteration.
   * @private
   */
  buildIterationState(state, index, item, total) {
    return {
      ...state,
      data: {
        ...state.data,
        _loopIndex: index,
        _loopItem: item,
        _loopTotal: total
      }
    };
  }

  /**
   * Execute body nodes sequentially for one loop iteration.
   * Returns the output of the last body node, or the iteration index if no body.
   * @private
   */
  async executeBodyNodes(bodyNodes, iterState, context) {
    if (!bodyNodes || bodyNodes.length === 0) {
      return { index: iterState.data._loopIndex };
    }

    // Lazy import to avoid circular dependency
    const { getExecutor } = await import('./index.js');

    let lastOutput = null;
    let currentState = iterState;

    for (const bodyNodeConfig of bodyNodes) {
      const executor = getExecutor(bodyNodeConfig.type);
      const result = await executor.execute(bodyNodeConfig, currentState, context);

      lastOutput = result.output;

      // Apply state updates for next body node in sequence
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
          component: 'LoopNodeExecutor',
          message: `Body node '${bodyNodeConfig.id}' failed: ${result.error}`
        });
      }
    }

    return lastOutput;
  }
}

export default LoopNodeExecutor;
