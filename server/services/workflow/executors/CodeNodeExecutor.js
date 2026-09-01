/**
 * Executor for workflow code nodes.
 *
 * Code nodes run user-provided JavaScript in a node:vm sandbox. This is
 * best-effort isolation, NOT a hard security boundary — node:vm shares the
 * host's heap, event loop, and process, and Node's own docs warn it must
 * not be relied on to run genuinely untrusted code safely. It blocks the
 * obvious footguns (prototype pollution, direct access to process/require/
 * Function) but a sufficiently determined script could still exhaust CPU
 * within the timeout window or find other V8-level escapes. Treat code
 * nodes as trusted-author-only, the same way you would treat any other
 * server-side script.
 *
 * Isolation measures:
 * - Null-prototype sandbox context prevents __proto__ traversal
 * - JSON round-trip on input data breaks prototype chain references
 * - 'use strict' mode prevents `this` escape to global scope
 * - Dangerous globals (Function, setTimeout, process, require) are blocked
 * - Host-realm built-ins (Array, String, Date, etc.) are never injected into
 *   the sandbox — the vm context's own realm already provides them, and
 *   injecting the host's versions would leak the host's Function via
 *   `.constructor`, enabling `Array.constructor('return process')()`-style escapes
 * - Configurable timeout prevents infinite loops
 *
 * @module services/workflow/executors/CodeNodeExecutor
 */

import vm from 'node:vm';
import { BaseNodeExecutor } from './BaseNodeExecutor.js';
import logger from '../../../utils/logger.js';

/**
 * Code node configuration
 * @typedef {Object} CodeNodeConfig
 * @property {string} code - JavaScript code to execute (last expression is the return value)
 * @property {number} [timeout=5000] - Execution timeout in ms (clamped to 100-30000)
 * @property {string} [outputVariable] - State variable to store the result
 */

/**
 * Code execution output
 * @typedef {Object} CodeExecutionOutput
 * @property {*} result - The return value (last expression) of the executed code
 * @property {Array<string>} logs - Captured console.log/warn/error output
 * @property {number} executionTime - Wall-clock execution time in milliseconds
 */

/**
 * Executor for code nodes.
 *
 * Runs user-provided JavaScript in a VM sandbox with strict security controls.
 * The code receives workflow state data as `data` and `input` variables and
 * can use standard JS built-ins (JSON, Math, Date, Array, String, RegExp, etc.).
 *
 * The return value is the last expression evaluated in the code.
 *
 * @extends BaseNodeExecutor
 *
 * @example
 * // Simple data transformation
 * {
 *   id: 'format-results',
 *   type: 'code',
 *   name: 'Format Search Results',
 *   config: {
 *     code: `
 *       const items = data.searchResults || [];
 *       items.map(item => ({
 *         title: item.name.toUpperCase(),
 *         score: Math.round(item.relevance * 100)
 *       }));
 *     `,
 *     outputVariable: 'formattedResults',
 *     timeout: 5000
 *   }
 * }
 *
 * @example
 * // Validation with console logging
 * {
 *   id: 'validate-input',
 *   type: 'code',
 *   name: 'Validate User Input',
 *   config: {
 *     code: `
 *       const email = data.userEmail || '';
 *       const isValid = /^[^@]+@[^@]+\\.[^@]+$/.test(email);
 *       console.log('Email validation:', isValid);
 *       ({ isValid, email, message: isValid ? 'OK' : 'Invalid email format' });
 *     `,
 *     outputVariable: 'validationResult'
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
   * Execute the code node in a node:vm sandbox (best-effort isolation, not a
   * hard security boundary — see the module docstring above).
   *
   * The code runs in a strict-mode VM context with:
   * - `data` and `input`: Deep-cloned workflow state data (read-only semantics)
   * - `console.log/warn/error`: Captured to logs array
   * - Standard JS built-ins (JSON, Math, Date, Array, String, Number, RegExp,
   *   etc.) available via the vm context's own realm — never injected from
   *   the host, to avoid leaking the host's Function constructor
   * - `Object` with safe methods only (keys, values, entries, assign, freeze, etc.)
   * - No access to: Function, setTimeout, process, require, globalThis
   *
   * @param {Object} node - The code node configuration
   * @param {Object} state - Current workflow state
   * @param {Object} _context - Execution context (unused for code nodes)
   * @returns {Promise<Object>} Execution result with code output, logs, and timing
   */
  async execute(node, state, _context) {
    const { config = {} } = node;
    const { code, timeout = 5000, outputVariable } = config;

    if (!code) {
      return this.createErrorResult('Code is required', { nodeId: node.id });
    }

    const clampedTimeout = Math.min(Math.max(timeout, 100), 30000);

    try {
      const startTime = Date.now();
      const logs = [];

      // 1. Null-prototype context prevents __proto__ traversal
      const sandbox = vm.createContext(Object.create(null));

      // 2. Break prototype chain via JSON round-trip (prevents access to host objects)
      const safeData = JSON.parse(JSON.stringify(state.data || {}));

      // 3. Safe Object proxy - only expose deterministic, side-effect-free methods
      const safeObject = {
        keys: Object.keys,
        values: Object.values,
        entries: Object.entries,
        assign: Object.assign,
        freeze: Object.freeze,
        isFrozen: Object.isFrozen,
        is: Object.is,
        create: Object.create,
        fromEntries: Object.fromEntries
      };

      // 4. Block dangerous globals that could escape the sandbox
      sandbox.Function = undefined;

      // 5. Expose only workflow data and a restricted Object; JSON, Math, Date,
      // Array, String, Number, RegExp, Boolean, Map, Set, Promise, parseInt,
      // parseFloat, isNaN, isFinite etc. are NOT injected here because doing so
      // would hand the sandbox the *host realm's* intrinsics — whose `.constructor`
      // is the host's Function, letting code escape via
      // `Array.constructor('return process')()`. The fresh vm context already
      // has its own copies of every standard built-in, scoped to this sandbox
      // realm, so user code can still use them safely without host access.
      Object.assign(sandbox, {
        data: safeData,
        input: safeData,
        Object: safeObject,
        console: {
          log: (...args) => logs.push(args.map(String).join(' ')),
          warn: (...args) => logs.push(args.map(String).join(' ')),
          error: (...args) => logs.push(args.map(String).join(' '))
        },
        // Explicitly block async/timer/system APIs
        setTimeout: undefined,
        setInterval: undefined,
        setImmediate: undefined,
        process: undefined,
        require: undefined,
        globalThis: undefined,
        global: undefined
      });

      // 6. Prepend 'use strict' to prevent `this` escape to global scope
      const result = vm.runInNewContext(`'use strict';\n${code}`, sandbox, {
        timeout: clampedTimeout,
        displayErrors: true
      });

      const executionTime = Date.now() - startTime;

      logger.info({
        component: 'CodeNodeExecutor',
        message: `Code node '${node.id}' completed in ${executionTime}ms`,
        nodeId: node.id,
        executionTime,
        logCount: logs.length
      });

      const output = { result, logs, executionTime };

      return this.createSuccessResult(output, {
        stateUpdates: outputVariable ? { [outputVariable]: output } : undefined
      });
    } catch (error) {
      const errorMessage =
        error.code === 'ERR_SCRIPT_EXECUTION_TIMEOUT'
          ? `Code execution timed out after ${clampedTimeout}ms`
          : `Code execution failed: ${error.message}`;

      return this.createErrorResult(errorMessage, {
        nodeId: node.id,
        error: error.message
      });
    }
  }
}

export default CodeNodeExecutor;
