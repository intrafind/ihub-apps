/**
 * Base class for workflow node executors.
 *
 * Node executors are responsible for executing specific types of nodes in a workflow DAG.
 * Each node type (start, end, agent, tool, decision) has its own executor that extends this base class.
 *
 * The execute() method is the main entry point and must be overridden by subclasses.
 * It receives the node configuration, current workflow state, and execution context,
 * and returns an execution result with status, output, and optional state updates.
 *
 * @module services/workflow/executors/BaseNodeExecutor
 */

import logger from '../../../utils/logger.js';

/**
 * Execution result returned by node executors
 * @typedef {Object} ExecutionResult
 * @property {'completed'|'failed'|'pending'} status - Execution status
 * @property {*} output - Node output data
 * @property {Object} [stateUpdates] - Key-value pairs to merge into workflow state
 * @property {boolean} [isTerminal] - If true, this node ends the workflow
 * @property {string} [error] - Error message if status is 'failed'
 * @property {string} [branch] - Branch identifier for decision nodes
 */

/**
 * Workflow execution context
 * @typedef {Object} ExecutionContext
 * @property {Object} chatService - Chat service instance for LLM calls
 * @property {Object} user - Current user object
 * @property {string} chatId - Chat/conversation identifier
 * @property {Object} appConfig - Application configuration
 * @property {Object} initialData - Initial input data for the workflow
 * @property {string} language - User language for localization
 */

/**
 * Workflow node configuration
 * @typedef {Object} WorkflowNode
 * @property {string} id - Unique node identifier
 * @property {string} type - Node type (start, end, agent, tool, decision)
 * @property {string} name - Human-readable node name
 * @property {Object} config - Node-specific configuration
 * @property {Array<string>} [next] - IDs of successor nodes
 */

/**
 * Workflow state object
 * @typedef {Object} WorkflowState
 * @property {Object} data - Current workflow data/variables
 * @property {Object} nodeOutputs - Map of node ID to output
 * @property {Array<string>} executedNodes - List of executed node IDs
 * @property {Object} metadata - Workflow metadata
 */

/**
 * Base class for all node executors.
 * Provides common functionality for variable resolution, validation, and error handling.
 */
export class BaseNodeExecutor {
  /**
   * Create a new BaseNodeExecutor
   * @param {Object} options - Executor options
   * @param {Object} [options.logger] - Custom logger instance
   */
  constructor(options = {}) {
    this.options = options;
    this.logger = options.logger || logger;
  }

  /**
   * Execute the node logic. Must be overridden by subclasses.
   *
   * @param {WorkflowNode} node - The node to execute
   * @param {WorkflowState} state - Current workflow state
   * @param {ExecutionContext} context - Execution context
   * @returns {Promise<ExecutionResult>} Execution result
   * @throws {Error} If not implemented by subclass
   *
   * @example
   * // Subclass implementation
   * async execute(node, state, context) {
   *   const result = await this.doSomething(node.config, state);
   *   return {
   *     status: 'completed',
   *     output: result,
   *     stateUpdates: { myVariable: result.value }
   *   };
   * }
   */
  async execute(node, _state, _context) {
    throw new Error(
      `execute() must be implemented by subclass. ` +
        `Node type '${node?.type}' executor is missing implementation.`
    );
  }

  /**
   * Resolve a variable path from workflow state using JSONPath-like syntax.
   *
   * Supports the following path formats:
   * - $.data.someKey - Access state.data.someKey
   * - $.nodeOutputs.nodeId.field - Access output from a specific node
   * - $.metadata.field - Access workflow metadata
   * - Plain string without $ - Returns the string as-is (literal value)
   *
   * @param {string} path - Variable path (e.g., '$.data.userInput')
   * @param {WorkflowState} state - Current workflow state
   * @returns {*} Resolved value or undefined if path not found
   *
   * @example
   * // Access nested data
   * const value = this.resolveVariable('$.data.user.name', state);
   *
   * @example
   * // Access node output
   * const output = this.resolveVariable('$.nodeOutputs.agent1.response', state);
   */
  resolveVariable(path, state) {
    // If not a variable reference, return as-is
    if (typeof path !== 'string' || !path.startsWith('$')) {
      return path;
    }

    // Remove the leading '$.' and split into parts
    const normalizedPath = path.startsWith('$.') ? path.slice(2) : path.slice(1);
    const parts = normalizedPath.split('.');

    // Navigate through the state object
    let current = state;
    for (const part of parts) {
      if (current === null || current === undefined) {
        this.logger.debug({
          component: 'BaseNodeExecutor',
          message: `Variable path '${path}' resolved to undefined at part '${part}'`
        });
        return undefined;
      }

      // Handle array index notation (e.g., items[0])
      const arrayMatch = part.match(/^(\w+)\[(\d+)\]$/);
      if (arrayMatch) {
        const [, arrayName, indexStr] = arrayMatch;
        const index = parseInt(indexStr, 10);
        current = current[arrayName];
        if (Array.isArray(current)) {
          current = current[index];
        } else {
          this.logger.debug({
            component: 'BaseNodeExecutor',
            message: `Expected array at '${arrayName}' but found ${typeof current}`
          });
          return undefined;
        }
      } else {
        current = current[part];
      }
    }

    return current;
  }

  /**
   * Resolve all variable references in a value recursively.
   * Handles strings, arrays, and objects.
   *
   * @param {*} value - Value that may contain variable references
   * @param {WorkflowState} state - Current workflow state
   * @returns {*} Value with all variables resolved
   *
   * @example
   * // Resolve template string
   * const message = this.resolveVariables('Hello, $.data.userName!', state);
   *
   * @example
   * // Resolve object with variable references
   * const config = this.resolveVariables({
   *   query: '$.data.searchQuery',
   *   limit: 10
   * }, state);
   */
  resolveVariables(value, state) {
    if (typeof value === 'string') {
      // Check if the entire value is a variable reference
      if (value.startsWith('$.')) {
        return this.resolveVariable(value, state);
      }

      // Check for embedded variable references like "Hello, ${$.data.name}!"
      const variablePattern = /\$\{(\$\.[^}]+)\}/g;
      if (variablePattern.test(value)) {
        return value.replace(/\$\{(\$\.[^}]+)\}/g, (match, varPath) => {
          const resolved = this.resolveVariable(varPath, state);
          return resolved !== undefined ? String(resolved) : match;
        });
      }

      return value;
    }

    if (Array.isArray(value)) {
      return value.map(item => this.resolveVariables(item, state));
    }

    if (value !== null && typeof value === 'object') {
      const resolved = {};
      for (const [key, val] of Object.entries(value)) {
        resolved[key] = this.resolveVariables(val, state);
      }
      return resolved;
    }

    return value;
  }

  /**
   * Validate node configuration against required fields.
   *
   * @param {WorkflowNode} node - Node to validate
   * @param {Array<string>} requiredFields - List of required config field names
   * @throws {Error} If required fields are missing
   *
   * @example
   * // Validate tool node has required fields
   * this.validateConfig(node, ['toolId', 'parameters']);
   */
  validateConfig(node, requiredFields = []) {
    if (!node) {
      throw new Error('Node configuration is required');
    }

    if (!node.id) {
      throw new Error('Node must have an id');
    }

    if (!node.type) {
      throw new Error(`Node '${node.id}' must have a type`);
    }

    const config = node.config || {};
    const missingFields = requiredFields.filter(field => {
      const value = config[field];
      return value === undefined || value === null || value === '';
    });

    if (missingFields.length > 0) {
      throw new Error(
        `Node '${node.id}' (type: ${node.type}) is missing required config fields: ` +
          `${missingFields.join(', ')}`
      );
    }
  }

  /**
   * Create a standardized error result.
   *
   * @param {string} message - Error message
   * @param {Object} [details] - Additional error details
   * @returns {ExecutionResult} Failed execution result
   *
   * @example
   * if (!toolId) {
   *   return this.createErrorResult('Tool ID is required');
   * }
   */
  createErrorResult(message, details = {}) {
    this.logger.error({
      component: this.constructor.name,
      message,
      ...details
    });

    return {
      status: 'failed',
      output: null,
      error: message,
      details
    };
  }

  /**
   * Create a standardized success result.
   *
   * @param {*} output - Node output data
   * @param {Object} [options] - Additional result options
   * @param {Object} [options.stateUpdates] - State updates to apply
   * @param {boolean} [options.isTerminal] - Whether this ends the workflow
   * @param {string} [options.branch] - Branch identifier for decision nodes
   * @returns {ExecutionResult} Completed execution result
   *
   * @example
   * return this.createSuccessResult(response, {
   *   stateUpdates: { agentOutput: response },
   *   branch: 'success'
   * });
   */
  createSuccessResult(output, options = {}) {
    const result = {
      status: 'completed',
      output
    };

    if (options.stateUpdates) {
      result.stateUpdates = options.stateUpdates;
    }

    if (options.isTerminal) {
      result.isTerminal = true;
    }

    if (options.branch) {
      result.branch = options.branch;
    }

    return result;
  }

  /**
   * Get the executor type name for logging purposes.
   * @returns {string} Executor type name
   */
  getTypeName() {
    return this.constructor.name.replace('NodeExecutor', '').toLowerCase() || 'base';
  }
}

export default BaseNodeExecutor;
