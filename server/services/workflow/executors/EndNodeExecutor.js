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
import renderTemplate from '../../templating/renderTemplate.js';
import {
  UNSAFE_OUTPUT_KEYS,
  hasEndOutput,
  isOutputObject
} from '../../../../shared/workflowEndOutput.js';

/**
 * End node configuration
 * @typedef {Object} EndNodeConfig
 * @property {string|Object} output - The end step's output, the answer the workflow gives (the chat
 *   shows exactly this): a variable (`finalReport`), a path into one (`report.markdown`), a state
 *   path (`$.data.finalReport`) or a text with variables (`{{summary}}`); or an object of those,
 *   `{ topic: 'topic', report: 'finalReport' }`, which gives a JSON object. Required.
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
 * - Giving the workflow its output: every end node has an `output`, and what a chat
 *   or an API caller gets as the answer is exactly that
 * - Collecting additional information next to it (variables, mapping, metadata)
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
 *     output: '$.data.processedResult',
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
    this.logger.info('Executing end node', {
      component: 'EndNodeExecutor',
      nodeId: node.id,
      stateDataKeys: Object.keys(state.data || {})
    });

    const { config = {} } = node;

    // The output comes first: an end step without one cannot give the workflow
    // an answer, and a run that ends without one is a configuration error to
    // surface, not something to guess a replacement for.
    const answer = this.resolveAnswer(node, state);

    // Determine the additional information next to it based on configuration
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

    // The output is the answer, whatever else the end step passes on: it wins
    // over a mapped or listed variable of the same name.
    output.output = answer;

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

    this.logger.info('End node completed - workflow finished', {
      component: 'EndNodeExecutor',
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
   * The end step's output, from its `output` setting.
   *
   * The setting is a text, or an object of texts. A text is one of
   *   - a state path: `$.data.finalReport`
   *   - a text with variables: `{{summary}}` or `Done: {{count}} items`. A text that
   *     is a single `{{variable}}` is the variable itself, so JSON stays JSON
   *   - a variable or a path into one: `finalReport`, `report.markdown`
   * An object gives an object: each field is resolved like a text, and a field whose
   * value is not there is left out of it.
   * A value that is not there yet (a branch that never set the variable) is an
   * empty output, not an error: the run still ends, the answer is just empty.
   *
   * @param {Object} node - The end node
   * @param {Object} state - Workflow state
   * @returns {*} The output value: text, an object, or any other value as it is
   * @throws {Error} `END_OUTPUT_MISSING` when the end step has no `output` set
   * @private
   */
  resolveAnswer(node, state) {
    const spec = node.config?.output;
    if (!hasEndOutput(spec)) {
      const error = new Error(
        `The end step '${node.id}' has no output. Set its Output to the variable that holds the answer, or to an object of fields.`
      );
      error.code = 'END_OUTPUT_MISSING';
      throw error;
    }

    const value = this.resolveOutputSpec(spec, state);
    return value === undefined || value === null ? '' : value;
  }

  /**
   * One text or object of an `output` setting, resolved against the run.
   *
   * @param {string|Object} spec - A text, or an object of texts
   * @param {Object} state - Workflow state
   * @returns {*} The value; undefined or null when it is not there
   * @private
   */
  resolveOutputSpec(spec, state) {
    if (isOutputObject(spec)) {
      const fields = {};
      for (const [name, field] of Object.entries(spec)) {
        if (UNSAFE_OUTPUT_KEYS.includes(name)) continue;
        const value = this.resolveOutputSpec(field, state);
        if (value !== undefined && value !== null) fields[name] = value;
      }
      return fields;
    }

    const text = spec.trim();
    const data = state.data || {};
    // A text that is a single `{{variable}}` is that variable, not a rendering
    // of it: JSON stays JSON. Only a text with more in it is built as text.
    const single = /^\{\{\s*([^#/@}][^}]*?)\s*\}\}$/.exec(text);
    if (single) return this.valueAt(data, single[1]);
    if (text.includes('{{')) return renderTemplate(text, data);
    if (text.startsWith('$')) return this.resolveVariable(text, state);
    return this.valueAt(data, text);
  }

  /**
   * The value at a dotted path in the workflow data (`report.markdown`).
   *
   * @param {*} data - Workflow data. Typed loosely on purpose: a path runs into values of any
   *   type, null and undefined included, and a narrower type makes a static analyzer take the
   *   checks for them as always false
   * @param {string} path - Variable name or dotted path into one
   * @returns {*} The value as it is, of whatever type; undefined when it is not there
   * @private
   */
  valueAt(data, path) {
    return path
      .trim()
      .split('.')
      .reduce((current, key) => {
        if (current === null || current === undefined) return undefined;
        // Only what the value itself holds: never a prototype member such as `constructor`
        return Object.prototype.hasOwnProperty.call(Object(current), key)
          ? current[key]
          : undefined;
      }, data);
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
