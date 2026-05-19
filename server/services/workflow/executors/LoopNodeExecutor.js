/**
 * Loop Node Executor for workflow DAG processing.
 *
 * Supports three iteration modes:
 * - `for`: Iterate a fixed number of times (count-based)
 * - `forEach`: Iterate over each element in an array resolved from workflow state
 * - `while`: Iterate as long as a JavaScript condition evaluates to true (VM-sandboxed)
 *
 * Each iteration executes a list of body nodes sequentially. Loop variables
 * (_loopIndex, _loopItem, _loopTotal) are injected into state.data during iteration
 * and cleaned up after the loop completes.
 *
 * A hard cap (default 50, max 200) prevents runaway loops.
 *
 * @module services/workflow/executors/LoopNodeExecutor
 */

import vm from 'node:vm';
import { BaseNodeExecutor } from './BaseNodeExecutor.js';
import logger from '../../../utils/logger.js';

/**
 * Executor that runs a list of body nodes repeatedly based on the configured loop mode.
 *
 * @extends BaseNodeExecutor
 *
 * @example
 * // for-loop node config
 * {
 *   id: 'loop-1',
 *   type: 'loop',
 *   config: {
 *     mode: 'for',
 *     count: 5,
 *     body: [{ id: 'inner-agent', type: 'agent', config: { ... } }],
 *     outputVariable: 'loopResults'
 *   }
 * }
 *
 * @example
 * // forEach-loop node config
 * {
 *   id: 'loop-2',
 *   type: 'loop',
 *   config: {
 *     mode: 'forEach',
 *     array: 'items',          // resolves to state.data.items
 *     body: [{ id: 'process', type: 'transform', config: { ... } }],
 *     outputVariable: 'processedItems'
 *   }
 * }
 *
 * @example
 * // while-loop node config
 * {
 *   id: 'loop-3',
 *   type: 'loop',
 *   config: {
 *     mode: 'while',
 *     condition: 'data.retryCount < 3',
 *     maxIterations: 10,
 *     body: [{ id: 'retry-step', type: 'agent', config: { ... } }]
 *   }
 * }
 */
export class LoopNodeExecutor extends BaseNodeExecutor {
  /**
   * Create a new LoopNodeExecutor.
   * @param {Object} [options] - Executor options passed to BaseNodeExecutor
   */
  constructor(options = {}) {
    super(options);
  }

  /**
   * Execute the loop node by iterating over body nodes according to the configured mode.
   *
   * @param {import('./BaseNodeExecutor.js').WorkflowNode} node - The loop node to execute
   * @param {import('./BaseNodeExecutor.js').WorkflowState} state - Current workflow state
   * @param {import('./BaseNodeExecutor.js').ExecutionContext} context - Execution context
   * @returns {Promise<import('./BaseNodeExecutor.js').ExecutionResult>} Result containing
   *   an array of iteration outputs and the total iteration count
   */
  async execute(node, state, context) {
    const { config = {} } = node;
    const {
      mode = 'for',
      count = 1,
      array,
      condition,
      maxIterations = 50,
      body = [],
      outputVariable
    } = config;

    // Hard cap prevents runaway loops regardless of user configuration
    const hardCap = Math.min(maxIterations, 200);

    try {
      const results = [];
      let currentState = { ...state, data: { ...state.data } };

      switch (mode) {
        case 'for': {
          const iterCount = Math.min(count, hardCap);
          for (let i = 0; i < iterCount; i++) {
            if (context.abortSignal?.aborted) break;
            currentState.data._loopIndex = i;
            currentState.data._loopTotal = iterCount;

            const bodyResult = await this.executeBodyNodes(body, currentState, context);
            results.push(bodyResult.output);
            currentState = bodyResult.state;

            if (bodyResult.failed) break;
          }
          break;
        }

        case 'forEach': {
          const resolvedArray = this.resolveVariable(
            array?.startsWith('$.') ? array : `$.data.${array}`,
            state
          );
          if (!Array.isArray(resolvedArray)) {
            return this.createErrorResult(`forEach: '${array}' is not an array`, {
              nodeId: node.id
            });
          }

          const iterArr = resolvedArray.slice(0, hardCap);
          for (let i = 0; i < iterArr.length; i++) {
            if (context.abortSignal?.aborted) break;
            currentState.data._loopIndex = i;
            currentState.data._loopItem = iterArr[i];
            currentState.data._loopTotal = iterArr.length;

            const bodyResult = await this.executeBodyNodes(body, currentState, context);
            results.push(bodyResult.output);
            currentState = bodyResult.state;

            if (bodyResult.failed) break;
          }
          break;
        }

        case 'while': {
          if (!condition) {
            return this.createErrorResult('while mode requires a condition', {
              nodeId: node.id
            });
          }

          let i = 0;
          while (i < hardCap) {
            if (context.abortSignal?.aborted) break;

            const condResult = this.evaluateCondition(condition, currentState.data, i);
            if (!condResult) break;

            currentState.data._loopIndex = i;
            currentState.data._loopTotal = -1; // unknown for while loops

            const bodyResult = await this.executeBodyNodes(body, currentState, context);
            results.push(bodyResult.output);
            // Use returned state so the next condition evaluation sees updated data
            currentState = bodyResult.state;

            if (bodyResult.failed) break;
            i++;
          }
          break;
        }

        default:
          return this.createErrorResult(`Unknown loop mode: ${mode}`, {
            nodeId: node.id
          });
      }

      // Clean up temporary loop variables from state
      delete currentState.data._loopIndex;
      delete currentState.data._loopItem;
      delete currentState.data._loopTotal;

      const stateUpdates = {
        ...(outputVariable ? { [outputVariable]: results } : {}),
        ...currentState.data
      };

      return this.createSuccessResult({ results, iterations: results.length }, { stateUpdates });
    } catch (error) {
      return this.createErrorResult(`Loop execution failed: ${error.message}`, {
        nodeId: node.id,
        error: error.message
      });
    }
  }

  /**
   * Execute a list of body nodes sequentially within a single loop iteration.
   *
   * Uses lazy import of `getExecutor` from `./index.js` to avoid circular
   * dependency issues (index.js imports this file, and this file needs getExecutor).
   *
   * @param {Array<import('./BaseNodeExecutor.js').WorkflowNode>} bodyNodes - Nodes to execute
   * @param {import('./BaseNodeExecutor.js').WorkflowState} iterationState - State for this iteration
   * @param {import('./BaseNodeExecutor.js').ExecutionContext} context - Execution context
   * @returns {Promise<{output: *, state: Object, failed: boolean}>} Iteration result with
   *   the final output, updated state, and whether execution failed
   */
  async executeBodyNodes(bodyNodes, iterationState, context) {
    // Lazy import to avoid circular dependency with index.js
    const { getExecutor } = await import('./index.js');

    let currentState = { ...iterationState, data: { ...iterationState.data } };

    for (const bodyNode of bodyNodes) {
      const executor = getExecutor(bodyNode.type);
      const result = await executor.execute(bodyNode, currentState, context);

      if (result.stateUpdates) {
        currentState.data = { ...currentState.data, ...result.stateUpdates };
      }

      if (result.status === 'failed') {
        return { output: result.output, state: currentState, failed: true };
      }
    }

    return { output: currentState.data, state: currentState, failed: false };
  }

  /**
   * Evaluate a JavaScript condition string in a sandboxed VM context.
   *
   * The condition runs in strict mode with a 1-second timeout. The sandbox
   * receives a JSON-safe copy of `data` and `index` to prevent prototype
   * pollution or access to the host environment.
   *
   * If evaluation throws (syntax error, timeout, etc.), the loop stops
   * by returning false.
   *
   * @param {string} condition - JavaScript expression to evaluate (e.g. "data.count < 10")
   * @param {Object} data - Current loop state data
   * @param {number} index - Current iteration index
   * @returns {boolean} Whether the condition is truthy
   */
  evaluateCondition(condition, data, index) {
    try {
      // VM sandbox hardening: create context with null prototype
      const sandbox = vm.createContext(Object.create(null));
      // Break prototype chain by JSON round-tripping to prevent pollution
      Object.assign(sandbox, JSON.parse(JSON.stringify({ data, index })));

      const result = vm.runInNewContext(`'use strict';\n${condition}`, sandbox, {
        timeout: 1000
      });
      return Boolean(result);
    } catch (error) {
      logger.warn({
        component: 'LoopNodeExecutor',
        message: `Condition evaluation failed: ${error.message}`,
        condition
      });
      return false; // Stop loop on error
    }
  }
}

export default LoopNodeExecutor;
