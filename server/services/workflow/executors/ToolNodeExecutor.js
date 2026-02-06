/**
 * Executor for workflow tool nodes.
 *
 * Tool nodes directly invoke a specific tool without LLM interaction.
 * They are useful for deterministic operations like data retrieval,
 * API calls, or transformations that don't require AI reasoning.
 *
 * @module services/workflow/executors/ToolNodeExecutor
 */

import { BaseNodeExecutor } from './BaseNodeExecutor.js';
import { runTool } from '../../../toolLoader.js';

/**
 * Tool node configuration
 * @typedef {Object} ToolNodeConfig
 * @property {string} toolId - The tool identifier to execute
 * @property {Object} [parameters] - Tool parameters (can contain variable references)
 * @property {string} [outputVariable] - State variable to store the result
 * @property {number} [timeout] - Execution timeout in milliseconds
 * @property {boolean} [optional] - If true, tool failure won't fail the workflow
 * @property {Object} [errorMapping] - Map error types to custom outputs
 */

/**
 * Executor for tool nodes.
 *
 * Tool nodes are responsible for:
 * - Resolving parameter values from workflow state
 * - Executing the specified tool
 * - Handling tool errors and timeouts
 * - Storing results in workflow state
 *
 * @extends BaseNodeExecutor
 *
 * @example
 * // Tool node configuration
 * {
 *   id: 'search-docs',
 *   type: 'tool',
 *   name: 'Search Documents',
 *   config: {
 *     toolId: 'source_search',
 *     parameters: {
 *       query: '$.data.searchQuery',
 *       limit: 10,
 *       filters: {
 *         type: 'document',
 *         date: '$.data.dateFilter'
 *       }
 *     },
 *     outputVariable: 'searchResults',
 *     timeout: 30000
 *   }
 * }
 */
export class ToolNodeExecutor extends BaseNodeExecutor {
  /**
   * Execute the tool node.
   *
   * Resolves parameters from state, executes the tool, and stores the result.
   *
   * @param {Object} node - The tool node configuration
   * @param {Object} state - Current workflow state
   * @param {Object} context - Execution context with user and chatId
   * @returns {Promise<Object>} Execution result with tool output
   *
   * @example
   * const result = await executor.execute(toolNode, state, context);
   * // result.output = { results: [...], total: 42 }
   * // result.stateUpdates = { searchResults: { results: [...], total: 42 } }
   */
  async execute(node, state, context) {
    // Validate required configuration
    this.validateConfig(node, ['toolId']);

    const { config } = node;
    const { user, chatId, appConfig } = context;
    const { toolId, parameters = {}, outputVariable, timeout, optional = false } = config;

    this.logger.info({
      component: 'ToolNodeExecutor',
      message: `Executing tool node '${node.id}'`,
      nodeId: node.id,
      toolId,
      hasParameters: Object.keys(parameters).length > 0
    });

    try {
      // Resolve parameters from state
      const resolvedParams = this.resolveParameters(parameters, state);

      this.logger.debug({
        component: 'ToolNodeExecutor',
        message: `Resolved parameters for tool '${toolId}'`,
        nodeId: node.id,
        parameterKeys: Object.keys(resolvedParams)
      });

      // Execute the tool with timeout if specified
      const result = await this.executeWithTimeout(
        toolId,
        {
          ...resolvedParams,
          chatId,
          user,
          appConfig
        },
        timeout
      );

      this.logger.info({
        component: 'ToolNodeExecutor',
        message: `Tool '${toolId}' executed successfully`,
        nodeId: node.id,
        hasResult: result !== undefined
      });

      // Build state updates if outputVariable is configured
      const stateUpdates = outputVariable ? { [outputVariable]: result } : undefined;

      return this.createSuccessResult(result, { stateUpdates });
    } catch (error) {
      return this.handleToolError(error, node, config, optional);
    }
  }

  /**
   * Resolve all parameters from workflow state.
   *
   * Parameters can contain:
   * - Variable references ($.data.field)
   * - Literal values
   * - Nested objects with mixed references
   *
   * @param {Object} paramConfig - Parameter configuration
   * @param {Object} state - Workflow state
   * @returns {Object} Resolved parameters
   * @private
   */
  resolveParameters(paramConfig, state) {
    return this.resolveVariables(paramConfig, state);
  }

  /**
   * Execute a tool with optional timeout.
   *
   * @param {string} toolId - Tool identifier
   * @param {Object} params - Tool parameters
   * @param {number} [timeout] - Timeout in milliseconds
   * @returns {Promise<*>} Tool result
   * @private
   */
  async executeWithTimeout(toolId, params, timeout) {
    if (!timeout) {
      return await runTool(toolId, params);
    }

    // Create timeout promise
    const timeoutPromise = new Promise((_, reject) => {
      setTimeout(() => {
        reject(new Error(`Tool '${toolId}' execution timed out after ${timeout}ms`));
      }, timeout);
    });

    // Race between tool execution and timeout
    return await Promise.race([runTool(toolId, params), timeoutPromise]);
  }

  /**
   * Handle tool execution errors.
   *
   * @param {Error} error - The error that occurred
   * @param {Object} node - Node configuration
   * @param {Object} config - Tool config
   * @param {boolean} optional - Whether the tool is optional
   * @returns {Object} Error result or optional fallback
   * @private
   */
  handleToolError(error, node, config, optional) {
    const errorMessage = error.message || 'Unknown tool error';

    this.logger.error({
      component: 'ToolNodeExecutor',
      message: `Tool execution failed for node '${node.id}'`,
      nodeId: node.id,
      toolId: config.toolId,
      error: errorMessage,
      stack: error.stack
    });

    // If tool is optional, return error as output but don't fail
    if (optional) {
      this.logger.info({
        component: 'ToolNodeExecutor',
        message: `Optional tool '${config.toolId}' failed, continuing workflow`,
        nodeId: node.id
      });

      const errorOutput = {
        error: true,
        message: errorMessage,
        toolId: config.toolId
      };

      // Check for error mapping
      if (config.errorMapping) {
        const mappedOutput = this.mapError(error, config.errorMapping);
        if (mappedOutput !== undefined) {
          return this.createSuccessResult(mappedOutput, {
            stateUpdates: config.outputVariable ? { [config.outputVariable]: mappedOutput } : undefined
          });
        }
      }

      return this.createSuccessResult(errorOutput, {
        stateUpdates: config.outputVariable ? { [config.outputVariable]: errorOutput } : undefined
      });
    }

    return this.createErrorResult(`Tool '${config.toolId}' failed: ${errorMessage}`, {
      toolId: config.toolId,
      nodeId: node.id,
      originalError: error.message
    });
  }

  /**
   * Map an error to a custom output based on error mapping configuration.
   *
   * @param {Error} error - The error that occurred
   * @param {Object} errorMapping - Error mapping configuration
   * @returns {*} Mapped output or undefined
   * @private
   *
   * @example
   * // Error mapping configuration
   * {
   *   'NOT_FOUND': { results: [], message: 'No results found' },
   *   'TIMEOUT': { results: [], message: 'Search timed out' },
   *   'default': { results: [], message: 'Search failed' }
   * }
   */
  mapError(error, errorMapping) {
    // Check for specific error code mapping
    if (error.code && errorMapping[error.code]) {
      return errorMapping[error.code];
    }

    // Check for error message pattern matching
    for (const [pattern, output] of Object.entries(errorMapping)) {
      if (pattern !== 'default' && error.message?.includes(pattern)) {
        return output;
      }
    }

    // Fall back to default mapping
    if (errorMapping.default) {
      return errorMapping.default;
    }

    return undefined;
  }
}

export default ToolNodeExecutor;
