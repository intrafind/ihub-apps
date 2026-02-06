/**
 * Executor for workflow start nodes.
 *
 * Start nodes are the entry points of a workflow. They initialize the workflow state
 * with input data and can optionally map initial data to specific state variables.
 *
 * A workflow must have exactly one start node, and it is always executed first.
 *
 * @module services/workflow/executors/StartNodeExecutor
 */

import { BaseNodeExecutor } from './BaseNodeExecutor.js';

/**
 * Start node configuration
 * @typedef {Object} StartNodeConfig
 * @property {Object} [inputMapping] - Map initial data fields to state variables
 * @property {Object} [defaults] - Default values for state variables
 * @property {Array<string>} [requiredInputs] - List of required input field names
 */

/**
 * Executor for start nodes.
 *
 * Start nodes are responsible for:
 * - Validating required input data
 * - Mapping initial data to state variables
 * - Setting default values for missing fields
 * - Initializing the workflow execution
 *
 * @extends BaseNodeExecutor
 *
 * @example
 * // Start node configuration
 * {
 *   id: 'start',
 *   type: 'start',
 *   name: 'Workflow Start',
 *   config: {
 *     inputMapping: {
 *       query: '$.input.userQuery',
 *       context: '$.input.additionalContext'
 *     },
 *     defaults: {
 *       maxResults: 10
 *     },
 *     requiredInputs: ['userQuery']
 *   }
 * }
 */
export class StartNodeExecutor extends BaseNodeExecutor {
  /**
   * Execute the start node.
   *
   * Initializes the workflow state with input data, applies input mapping,
   * and sets default values.
   *
   * @param {Object} node - The start node configuration
   * @param {Object} state - Current workflow state
   * @param {Object} context - Execution context with initialData
   * @returns {Promise<Object>} Execution result with initialized state
   *
   * @example
   * const result = await executor.execute(startNode, state, {
   *   initialData: { userQuery: 'Search for documents' }
   * });
   * // result.output = { initialized: true, timestamp: '...' }
   * // result.stateUpdates = { query: 'Search for documents', maxResults: 10 }
   */
  async execute(node, state, context) {
    this.logger.info({
      component: 'StartNodeExecutor',
      message: `Executing start node '${node.id}'`,
      nodeId: node.id,
      hasInitialData: !!context.initialData
    });

    const { config = {} } = node;
    const { initialData = {} } = context;

    // Validate required inputs if specified
    if (config.requiredInputs && Array.isArray(config.requiredInputs)) {
      const missingInputs = this.validateRequiredInputs(config.requiredInputs, initialData);
      if (missingInputs.length > 0) {
        return this.createErrorResult(
          `Start node '${node.id}' is missing required inputs: ${missingInputs.join(', ')}`,
          { missingInputs, nodeId: node.id }
        );
      }
    }

    // Build state updates from input mapping and defaults
    const stateUpdates = {};

    // Apply default values first (can be overridden by input mapping)
    if (config.defaults && typeof config.defaults === 'object') {
      Object.assign(stateUpdates, config.defaults);
    }

    // Apply input mapping
    if (config.inputMapping && typeof config.inputMapping === 'object') {
      const mappedData = this.applyInputMapping(config.inputMapping, initialData, state);
      Object.assign(stateUpdates, mappedData);
    } else {
      // If no mapping specified, copy all initial data to state.data
      // This provides a default behavior for simple workflows
      if (Object.keys(initialData).length > 0) {
        Object.assign(stateUpdates, initialData);
      }
    }

    const output = {
      initialized: true,
      timestamp: new Date().toISOString(),
      inputFields: Object.keys(initialData),
      mappedFields: Object.keys(stateUpdates)
    };

    this.logger.info({
      component: 'StartNodeExecutor',
      message: `Start node '${node.id}' completed`,
      nodeId: node.id,
      mappedFieldCount: Object.keys(stateUpdates).length
    });

    return this.createSuccessResult(output, {
      stateUpdates: Object.keys(stateUpdates).length > 0 ? stateUpdates : undefined
    });
  }

  /**
   * Validate that all required inputs are present.
   *
   * @param {Array<string>} requiredInputs - List of required field names
   * @param {Object} initialData - Input data object
   * @returns {Array<string>} List of missing field names
   * @private
   */
  validateRequiredInputs(requiredInputs, initialData) {
    const missing = [];

    for (const field of requiredInputs) {
      const value = initialData[field];
      if (value === undefined || value === null || value === '') {
        missing.push(field);
      }
    }

    return missing;
  }

  /**
   * Apply input mapping to transform initial data into state variables.
   *
   * The mapping object maps target state variable names to source paths.
   * Source paths can be:
   * - $.input.fieldName - Access from initialData
   * - $.data.fieldName - Access from current state (for re-runs)
   * - Literal values (strings, numbers, etc.)
   *
   * @param {Object} mapping - Mapping configuration { targetVar: sourcePath }
   * @param {Object} initialData - Initial input data
   * @param {Object} state - Current workflow state
   * @returns {Object} Mapped data object
   * @private
   *
   * @example
   * // Mapping configuration
   * const mapping = {
   *   searchQuery: '$.input.query',
   *   resultLimit: 10,
   *   contextData: '$.input.context'
   * };
   *
   * // Initial data
   * const initialData = {
   *   query: 'Find documents about AI',
   *   context: { topic: 'artificial intelligence' }
   * };
   *
   * // Result
   * {
   *   searchQuery: 'Find documents about AI',
   *   resultLimit: 10,
   *   contextData: { topic: 'artificial intelligence' }
   * }
   */
  applyInputMapping(mapping, initialData, state) {
    const result = {};

    // Create an extended state that includes initialData under 'input'
    const extendedState = {
      ...state,
      input: initialData
    };

    for (const [targetVar, sourcePath] of Object.entries(mapping)) {
      if (typeof sourcePath === 'string' && sourcePath.startsWith('$')) {
        // Resolve variable path
        const resolved = this.resolveVariable(sourcePath, extendedState);
        if (resolved !== undefined) {
          result[targetVar] = resolved;
        }
      } else {
        // Literal value
        result[targetVar] = sourcePath;
      }
    }

    return result;
  }
}

export default StartNodeExecutor;
