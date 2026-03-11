/**
 * Executor for workflow code execution nodes.
 *
 * Code nodes execute arbitrary JavaScript in a sandboxed VM context.
 * The sandbox provides a limited set of safe globals and blocks access
 * to Node.js internals, network, and file-system APIs.
 *
 * @module services/workflow/executors/CodeNodeExecutor
 */

import vm from 'vm';
import { BaseNodeExecutor } from './BaseNodeExecutor.js';

const DEFAULT_TIMEOUT = 5000;
const MAX_TIMEOUT = 30000;

/**
 * Executor for code nodes.
 *
 * @extends BaseNodeExecutor
 *
 * @example
 * {
 *   id: 'process-data',
 *   type: 'code',
 *   name: 'Process Data',
 *   config: {
 *     code: `
 *       const items = data.items || [];
 *       return items.map(item => ({ ...item, processed: true }));
 *     `,
 *     timeout: 3000,
 *     outputVariable: 'processedItems'
 *   }
 * }
 */
export class CodeNodeExecutor extends BaseNodeExecutor {
  /**
   * Create a new CodeNodeExecutor
   * @param {Object} options - Executor options
   */
  constructor(options = {}) {
    super(options);
  }

  /**
   * Execute the code node.
   *
   * @param {Object} node - The node configuration
   * @param {Object} state - Current workflow state
   * @param {Object} _context - Execution context
   * @returns {Promise<Object>} Execution result with return value stored in outputVariable
   */
  async execute(node, state, _context) {
    const { config = {} } = node;

    this.validateConfig(node, ['code']);

    const timeout = Math.min(config.timeout || DEFAULT_TIMEOUT, MAX_TIMEOUT);
    const outputVariable = config.outputVariable || 'codeResult';
    const data = state.data || {};
    const input = data.input !== undefined ? data.input : data;

    this.logger.info({
      component: 'CodeNodeExecutor',
      message: `Executing code node '${node.id}'`,
      nodeId: node.id,
      timeout
    });

    const start = Date.now();
    const logs = [];

    // Build a hardened sandbox with null prototype to prevent prototype chain escapes
    const sandbox = Object.create(null);

    // Safe globals
    sandbox.JSON = JSON;
    sandbox.Math = Math;
    sandbox.Date = Date;
    sandbox.Array = Array;
    sandbox.Object = Object;
    sandbox.String = String;
    sandbox.Number = Number;
    sandbox.RegExp = RegExp;
    sandbox.Boolean = Boolean;
    sandbox.parseInt = parseInt;
    sandbox.parseFloat = parseFloat;
    sandbox.isNaN = isNaN;
    sandbox.isFinite = isFinite;
    sandbox.undefined = undefined;
    sandbox.null = null;
    sandbox.true = true;
    sandbox.false = false;

    // Captured console
    sandbox.console = {
      log: (...args) => logs.push(args.join(' ')),
      warn: (...args) => logs.push('[warn] ' + args.join(' ')),
      error: (...args) => logs.push('[error] ' + args.join(' '))
    };

    // Input variables available to user code
    sandbox.data = JSON.parse(JSON.stringify(data));
    sandbox.input =
      typeof input === 'object' && input !== null ? JSON.parse(JSON.stringify(input)) : input;

    // Create hardened context
    const context = vm.createContext(sandbox);

    // Wrap user code in an IIFE to capture return value
    const wrappedCode = `(function() { ${config.code} })()`;

    try {
      const result = vm.runInContext(wrappedCode, context, { timeout });

      const executionTime = Date.now() - start;

      const output = {
        result,
        logs,
        executionTime
      };

      this.logger.info({
        component: 'CodeNodeExecutor',
        message: `Code node '${node.id}' completed`,
        nodeId: node.id,
        executionTime,
        logCount: logs.length,
        outputVariable
      });

      return this.createSuccessResult(output, {
        stateUpdates: { [outputVariable]: output }
      });
    } catch (error) {
      const executionTime = Date.now() - start;

      this.logger.error({
        component: 'CodeNodeExecutor',
        message: `Code node '${node.id}' failed`,
        nodeId: node.id,
        error: error.message,
        stack: error.stack,
        executionTime
      });

      return this.createErrorResult(`Code execution failed: ${error.message}`, {
        nodeId: node.id,
        logs,
        executionTime,
        originalError: error.message
      });
    }
  }
}

export default CodeNodeExecutor;
