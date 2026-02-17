/**
 * Executor for workflow end nodes.
 *
 * End nodes are the exit points of a workflow. They collect final output data
 * and signal workflow completion. A workflow can have multiple end nodes
 * (for different branches), but only one will be executed per workflow run.
 *
 * @module services/workflow/executors/EndNodeExecutor
 */

import { BaseNodeExecutor } from './BaseNodeExecutor.js';

/**
 * End node configuration
 * @typedef {Object} EndNodeConfig
 * @property {Object} [outputMapping] - Map state fields to output fields
 * @property {Array<string>} [includeFields] - Specific fields to include in output
 * @property {Array<string>} [excludeFields] - Fields to exclude from output
 * @property {string} [outputFormat] - Output format ('json', 'text', 'raw')
 * @property {string} [status] - Custom workflow status (e.g., 'approved', 'rejected')
 * @property {string} [statusCode] - Custom status code for the workflow result (deprecated, use status)
 */

/**
 * Executor for end nodes.
 *
 * End nodes are responsible for:
 * - Collecting final workflow output
 * - Applying output mapping/transformation
 * - Signaling workflow completion
 * - Formatting the final result
 *
 * @extends BaseNodeExecutor
 *
 * @example
 * // End node configuration with output mapping
 * {
 *   id: 'end-success',
 *   type: 'end',
 *   name: 'Success Exit',
 *   config: {
 *     outputMapping: {
 *       result: '$.data.processedResult',
 *       summary: '$.nodeOutputs.summarizer.content'
 *     },
 *     includeFields: ['result', 'summary', 'metadata']
 *   }
 * }
 */
export class EndNodeExecutor extends BaseNodeExecutor {
  /**
   * Execute the end node.
   *
   * Collects final output from workflow state, applies output mapping,
   * and returns the terminal result.
   *
   * @param {Object} node - The end node configuration
   * @param {Object} state - Current workflow state
   * @param {Object} context - Execution context
   * @returns {Promise<Object>} Terminal execution result with final output
   *
   * @example
   * const result = await executor.execute(endNode, state, context);
   * // result.status = 'completed'
   * // result.isTerminal = true
   * // result.output = { result: '...', summary: '...' }
   */
  async execute(node, state, _context) {
    this.logger.info({
      component: 'EndNodeExecutor',
      message: `Executing end node '${node.id}'`,
      nodeId: node.id,
      stateDataKeys: Object.keys(state.data || {})
    });

    const { config = {} } = node;

    // Determine the output based on configuration
    let output;

    if (config.outputMapping) {
      // Apply explicit output mapping
      output = this.applyOutputMapping(config.outputMapping, state);
    } else if (config.includeFields) {
      // Include only specific fields from state.data
      output = this.filterFields(state.data || {}, config.includeFields, 'include');
    } else if (config.excludeFields) {
      // Exclude specific fields from state.data
      output = this.filterFields(state.data || {}, config.excludeFields, 'exclude');
    } else if (config.outputVariables) {
      // Use explicitly listed output variables
      output = {};
      for (const varName of config.outputVariables) {
        if (varName in (state.data || {})) {
          output[varName] = state.data[varName];
        }
      }
    } else {
      // Default: return state data excluding internal fields to avoid circular references
      const internalFields = new Set([
        'nodeResults',
        '_nodeIterations',
        '_workflowDefinition',
        '_workflow',
        'pendingCheckpoint',
        '_pausedAt',
        '_pauseReason',
        '_resumedAt'
      ]);

      output = {};
      for (const [key, value] of Object.entries(state.data || {})) {
        if (!internalFields.has(key)) {
          output[key] = value;
        }
      }
    }

    // Add node outputs if requested
    if (config.includeNodeOutputs) {
      output._nodeOutputs = { ...state.nodeOutputs };
    }

    // Add execution metadata if requested
    if (config.includeMetadata) {
      output._metadata = {
        workflowId: state.metadata?.workflowId,
        executedNodes: state.executedNodes || [],
        completedAt: new Date().toISOString(),
        exitNode: node.id
      };
    }

    // Apply output format transformation
    if (config.outputFormat) {
      output = this.formatOutput(output, config.outputFormat);
    }

    // Determine custom workflow status if specified
    const workflowStatus = config.status || config.statusCode || null;

    this.logger.info({
      component: 'EndNodeExecutor',
      message: `End node '${node.id}' completed - workflow finished`,
      nodeId: node.id,
      outputKeys: typeof output === 'object' ? Object.keys(output) : ['formatted'],
      workflowStatus
    });

    return this.createSuccessResult(output, {
      isTerminal: true,
      workflowStatus // Pass custom status to WorkflowEngine
    });
  }

  /**
   * Apply output mapping to extract specific fields from state.
   *
   * @param {Object} mapping - Output mapping configuration
   * @param {Object} state - Workflow state
   * @returns {Object} Mapped output object
   * @private
   *
   * @example
   * const mapping = {
   *   finalAnswer: '$.data.answer',
   *   sources: '$.nodeOutputs.search.results'
   * };
   * const output = this.applyOutputMapping(mapping, state);
   */
  applyOutputMapping(mapping, state) {
    const output = {};

    for (const [outputKey, sourcePath] of Object.entries(mapping)) {
      if (typeof sourcePath === 'string' && sourcePath.startsWith('$')) {
        const resolved = this.resolveVariable(sourcePath, state);
        if (resolved !== undefined) {
          output[outputKey] = resolved;
        }
      } else {
        // Literal value or nested mapping
        output[outputKey] = this.resolveVariables(sourcePath, state);
      }
    }

    return output;
  }

  /**
   * Filter fields from an object based on include/exclude list.
   *
   * @param {Object} data - Source data object
   * @param {Array<string>} fields - List of field names
   * @param {string} mode - 'include' or 'exclude'
   * @returns {Object} Filtered object
   * @private
   */
  filterFields(data, fields, mode) {
    const result = {};

    if (mode === 'include') {
      // Only include specified fields
      for (const field of fields) {
        if (field in data) {
          result[field] = data[field];
        }
      }
    } else if (mode === 'exclude') {
      // Include all fields except specified ones
      for (const [key, value] of Object.entries(data)) {
        if (!fields.includes(key)) {
          result[key] = value;
        }
      }
    }

    return result;
  }

  /**
   * Format output according to specified format.
   *
   * @param {Object} output - Output object
   * @param {string} format - Output format ('json', 'text', 'raw')
   * @returns {*} Formatted output
   * @private
   */
  formatOutput(output, format) {
    switch (format) {
      case 'json':
        return output;

      case 'text':
        // Convert to human-readable text
        if (typeof output === 'string') {
          return output;
        }
        if (output.content || output.text || output.message) {
          return output.content || output.text || output.message;
        }
        return JSON.stringify(output, null, 2);

      case 'raw':
        // Return first value if single-key object
        const keys = Object.keys(output);
        if (keys.length === 1) {
          return output[keys[0]];
        }
        return output;

      default:
        return output;
    }
  }
}

export default EndNodeExecutor;
