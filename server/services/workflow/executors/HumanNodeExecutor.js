/**
 * Human Node Executor
 *
 * Executes human checkpoint nodes that pause the workflow for user input/approval.
 * The workflow will remain paused until the user provides a response through
 * the checkpoint API.
 *
 * Human nodes are used for:
 * - Approval gates (e.g., manager approval before proceeding)
 * - User input collection (e.g., asking for additional information)
 * - Review checkpoints (e.g., review generated content before publishing)
 *
 * @module services/workflow/executors/HumanNodeExecutor
 */

import { BaseNodeExecutor } from './BaseNodeExecutor.js';
import { v4 as uuidv4 } from 'uuid';
import { actionTracker } from '../../../actionTracker.js';

/**
 * Executor for human checkpoint nodes.
 *
 * When executed, this node:
 * 1. Creates a pending checkpoint with the configured message and options
 * 2. Emits a 'workflow.human.required' event
 * 3. Returns with status 'paused' to halt the workflow
 *
 * The workflow can be resumed by calling the checkpoint response API with
 * the checkpoint ID and user's response.
 *
 * @extends BaseNodeExecutor
 *
 * @example
 * // Node configuration
 * {
 *   id: 'approval',
 *   type: 'human',
 *   name: { en: 'Manager Approval' },
 *   config: {
 *     message: { en: 'Please review and approve the results' },
 *     options: [
 *       { value: 'approve', label: { en: 'Approve' }, style: 'primary' },
 *       { value: 'reject', label: { en: 'Reject' }, style: 'danger' }
 *     ],
 *     showData: ['$.researchResults'],
 *     timeout: 86400000 // 24 hours optional timeout
 *   }
 * }
 */
export class HumanNodeExecutor extends BaseNodeExecutor {
  /**
   * Create a new HumanNodeExecutor
   * @param {Object} options - Executor options
   */
  constructor(options = {}) {
    super(options);
  }

  /**
   * Execute the human checkpoint node.
   *
   * Creates a checkpoint and pauses the workflow until user responds.
   *
   * @param {Object} node - The node configuration
   * @param {Object} state - Current workflow state
   * @param {Object} context - Execution context
   * @returns {Promise<Object>} Execution result with status 'paused'
   */
  async execute(node, state, context) {
    this.validateConfig(node, ['message']);

    const { config } = node;
    const language = context.language || 'en';

    // Resolve message from localized config
    const message = this._getLocalizedValue(config.message, language);

    // Resolve any variable references in the message
    const resolvedMessage = this.resolveVariables(message, state);

    // Create the checkpoint
    const checkpoint = {
      id: `ckpt-${uuidv4()}`,
      nodeId: node.id,
      nodeName: this._getLocalizedValue(node.name, language) || node.id,
      type: 'human_input',
      message: resolvedMessage,
      options: this._resolveOptions(config.options, language),
      inputSchema: config.inputSchema || null,
      showData: config.showData || null,
      timeout: config.timeout || null,
      createdAt: new Date().toISOString(),
      expiresAt: config.timeout ? new Date(Date.now() + config.timeout).toISOString() : null
    };

    // If showData is specified, extract the relevant data for display
    if (checkpoint.showData && Array.isArray(checkpoint.showData)) {
      checkpoint.displayData = {};
      for (const dataPath of checkpoint.showData) {
        const value = this.resolveVariable(dataPath, state);
        if (value !== undefined) {
          // Use the path as key, or extract a simpler key
          const key = dataPath.replace(/^\$\./, '').replace(/\./g, '_');
          checkpoint.displayData[key] = value;
        }
      }
    }

    this.logger.info({
      component: 'HumanNodeExecutor',
      message: 'Human checkpoint created',
      executionId: context.executionId,
      nodeId: node.id,
      checkpointId: checkpoint.id
    });

    // Emit event for real-time notification
    actionTracker.emit('fire-sse', {
      event: 'workflow.human.required',
      chatId: context.executionId,
      executionId: context.executionId,
      checkpoint
    });

    // Return paused result with checkpoint info
    return {
      status: 'paused',
      output: { awaitingHuman: true, checkpointId: checkpoint.id },
      checkpoint,
      pauseReason: 'human_input_required',
      stateUpdates: {
        pendingCheckpoint: checkpoint
      }
    };
  }

  /**
   * Resume execution after user responds to the checkpoint.
   *
   * This method is called by the WorkflowEngine when a checkpoint response
   * is received through the API.
   *
   * @param {Object} node - The node configuration
   * @param {Object} state - Current workflow state
   * @param {Object} humanResponse - User's response to the checkpoint
   * @param {string} humanResponse.checkpointId - The checkpoint ID being responded to
   * @param {string} humanResponse.response - The selected option value
   * @param {Object} [humanResponse.data] - Additional form data if inputSchema was provided
   * @param {Object} context - Execution context
   * @returns {Promise<Object>} Execution result with status 'completed'
   */
  async resume(node, state, humanResponse, context) {
    const { checkpointId, response, data } = humanResponse;

    this.logger.info({
      component: 'HumanNodeExecutor',
      message: 'Resuming from human checkpoint',
      executionId: context?.executionId,
      nodeId: node.id,
      checkpointId,
      response
    });

    // Validate response against options if options were specified
    const { config } = node;
    if (config.options && Array.isArray(config.options)) {
      const validOptions = config.options.map(opt => opt.value);
      if (!validOptions.includes(response)) {
        this.logger.warn({
          component: 'HumanNodeExecutor',
          message: 'Invalid response option',
          response,
          validOptions
        });
        return this.createErrorResult(
          `Invalid response '${response}'. Valid options: ${validOptions.join(', ')}`
        );
      }
    }

    // Validate data against inputSchema if provided
    if (config.inputSchema && data) {
      const validationResult = this._validateInputData(data, config.inputSchema);
      if (!validationResult.valid) {
        return this.createErrorResult(`Invalid input data: ${validationResult.error}`);
      }
    }

    // Build the human response output
    const humanResponseOutput = {
      checkpointId,
      nodeId: node.id,
      response,
      data: data || null,
      respondedAt: new Date().toISOString()
    };

    // Emit event for response received
    actionTracker.emit('fire-sse', {
      event: 'workflow.human.responded',
      chatId: context?.executionId,
      executionId: context?.executionId,
      nodeId: node.id,
      checkpointId,
      response
    });

    // Return completed result with response data
    // Include branch in output for consistency with ExecutionProgress display
    return this.createSuccessResult(
      {
        ...humanResponseOutput,
        branch: response // Include branch in output for UI display
      },
      {
        stateUpdates: {
          [`humanResponse_${node.id}`]: humanResponseOutput,
          pendingCheckpoint: null // Clear the pending checkpoint
        },
        branch: response // Use the response value as the branch for decision routing
      }
    );
  }

  /**
   * Get a localized value from an object with language keys
   * @param {Object|string} value - Localized value object or plain string
   * @param {string} language - Preferred language code
   * @returns {string} Resolved string value
   * @private
   */
  _getLocalizedValue(value, language) {
    if (typeof value === 'string') {
      return value;
    }
    if (value && typeof value === 'object') {
      return value[language] || value.en || Object.values(value)[0] || '';
    }
    return '';
  }

  /**
   * Resolve options with localized labels
   * @param {Array} options - Options array from config
   * @param {string} language - Preferred language code
   * @returns {Array} Resolved options
   * @private
   */
  _resolveOptions(options, language) {
    if (!options || !Array.isArray(options)) {
      return [{ value: 'continue', label: 'Continue', style: 'primary' }];
    }

    return options.map(option => ({
      value: option.value,
      label: this._getLocalizedValue(option.label, language) || option.value,
      style: option.style || 'secondary',
      description: option.description ? this._getLocalizedValue(option.description, language) : null
    }));
  }

  /**
   * Validate input data against a JSON schema (basic validation)
   * @param {Object} data - Input data to validate
   * @param {Object} schema - JSON schema for validation
   * @returns {Object} Validation result { valid: boolean, error?: string }
   * @private
   */
  _validateInputData(data, schema) {
    // Basic type validation - full JSON Schema validation could be added later
    if (schema.type === 'object' && typeof data !== 'object') {
      return { valid: false, error: 'Expected object type' };
    }

    if (schema.required && Array.isArray(schema.required)) {
      const missing = schema.required.filter(field => !(field in data));
      if (missing.length > 0) {
        return { valid: false, error: `Missing required fields: ${missing.join(', ')}` };
      }
    }

    return { valid: true };
  }
}

export default HumanNodeExecutor;
