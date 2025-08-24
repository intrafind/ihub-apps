/**
 * Tool execution engine for running tools and managing their lifecycle
 */

import { ProviderError, ConfigurationError } from '../utils/ErrorHandler.js';

/**
 * Result of tool execution
 */
export class ToolResult {
  constructor({ toolCallId, name, result, error, executionTime, metadata = {} }) {
    this.toolCallId = toolCallId;
    this.name = name;
    this.result = result;
    this.error = error;
    this.executionTime = executionTime;
    this.metadata = metadata;
    this.timestamp = Date.now();
  }

  get isSuccess() {
    return !this.error;
  }

  get isError() {
    return !!this.error;
  }
}

/**
 * Tool executor for running registered tools
 */
export class ToolExecutor {
  constructor(registry, options = {}) {
    this.registry = registry;
    this.logger = options.logger;
    this.defaultTimeout = options.timeout || 30000; // 30 seconds default
    this.maxConcurrent = options.maxConcurrent || 5;
    this.executionContext = options.context || {};

    // Track running executions for cancellation/monitoring
    this.runningExecutions = new Map();
    this.executionCounter = 0;
  }

  /**
   * Execute a single tool call
   * @param {Object} toolCall - Tool call to execute
   * @param {string} toolCall.id - Tool call ID
   * @param {string} toolCall.name - Tool name
   * @param {Object} toolCall.arguments - Tool arguments
   * @param {Object} [context] - Additional context for execution
   * @param {number} [timeout] - Execution timeout in ms
   * @returns {Promise<ToolResult>} Execution result
   */
  async executeTool(toolCall, context = {}, timeout = this.defaultTimeout) {
    const { id, name, arguments: args } = toolCall;
    const startTime = performance.now();
    const executionId = ++this.executionCounter;

    this.logger?.debug?.('Executing tool:', { id, name, executionId });

    try {
      // Get tool definition and handler
      const tool = this.registry.getTool(name);
      if (!tool) {
        throw new ConfigurationError(`Tool not found: ${name}`, 'name', 'ToolExecutor');
      }

      const handler = this.registry.getHandler(name);
      if (!handler) {
        throw new ConfigurationError(
          `No handler registered for tool: ${name}`,
          'handler',
          'ToolExecutor'
        );
      }

      // Validate arguments against tool schema
      this.validateArguments(args, tool.parameters, name);

      // Create execution context
      const executionContext = {
        ...this.executionContext,
        ...context,
        toolCall: { id, name, arguments: args },
        tool,
        executionId
      };

      // Create timeout promise
      const timeoutPromise = new Promise((_, reject) => {
        const timer = setTimeout(() => {
          reject(new Error(`Tool execution timeout after ${timeout}ms`));
        }, timeout);

        // Store for potential cancellation
        this.runningExecutions.set(executionId, { timer, toolCall, startTime });
      });

      // Execute tool with timeout
      const executionPromise = this.executeWithContext(handler, args, executionContext);
      const result = await Promise.race([executionPromise, timeoutPromise]);

      // Clean up and measure execution time
      this.cleanupExecution(executionId);
      const executionTime = performance.now() - startTime;

      this.logger?.debug?.('Tool execution completed:', {
        id,
        name,
        executionId,
        executionTime: `${executionTime.toFixed(2)}ms`
      });

      return new ToolResult({
        toolCallId: id,
        name,
        result,
        error: null,
        executionTime,
        metadata: { executionId }
      });
    } catch (error) {
      this.cleanupExecution(executionId);
      const executionTime = performance.now() - startTime;

      this.logger?.error?.('Tool execution failed:', {
        id,
        name,
        executionId,
        error: error.message,
        executionTime: `${executionTime.toFixed(2)}ms`
      });

      return new ToolResult({
        toolCallId: id,
        name,
        result: null,
        error: {
          message: error.message,
          type: error.constructor.name,
          stack: error.stack
        },
        executionTime,
        metadata: { executionId }
      });
    }
  }

  /**
   * Execute multiple tool calls concurrently
   * @param {Array<Object>} toolCalls - Array of tool calls
   * @param {Object} [context] - Execution context
   * @param {Object} [options] - Execution options
   * @param {number} [options.timeout] - Timeout per tool
   * @param {number} [options.maxConcurrent] - Max concurrent executions
   * @param {boolean} [options.failFast] - Stop on first error
   * @returns {Promise<Array<ToolResult>>} Array of execution results
   */
  async executeTools(toolCalls, context = {}, options = {}) {
    if (!Array.isArray(toolCalls) || toolCalls.length === 0) {
      return [];
    }

    const {
      timeout = this.defaultTimeout,
      maxConcurrent = this.maxConcurrent,
      failFast = false
    } = options;

    this.logger?.debug?.('Executing multiple tools:', {
      count: toolCalls.length,
      maxConcurrent,
      failFast
    });

    const results = [];
    const batches = this.createBatches(toolCalls, maxConcurrent);

    for (const batch of batches) {
      const batchPromises = batch.map(toolCall => this.executeTool(toolCall, context, timeout));

      try {
        if (failFast) {
          const batchResults = await Promise.all(batchPromises);
          results.push(...batchResults);

          // Check for errors if failFast is enabled
          const hasError = batchResults.some(result => result.isError);
          if (hasError) {
            this.logger?.warn?.('Stopping tool execution due to error (failFast enabled)');
            break;
          }
        } else {
          // Use allSettled to continue even if some tools fail
          const settledResults = await Promise.allSettled(batchPromises);
          const batchResults = settledResults.map(settled =>
            settled.status === 'fulfilled'
              ? settled.value
              : new ToolResult({
                  toolCallId: 'unknown',
                  name: 'unknown',
                  result: null,
                  error: { message: settled.reason.message },
                  executionTime: 0
                })
          );
          results.push(...batchResults);
        }
      } catch (error) {
        this.logger?.error?.('Batch execution failed:', error.message);
        if (failFast) throw error;
      }
    }

    this.logger?.debug?.('Tool execution completed:', {
      total: toolCalls.length,
      successful: results.filter(r => r.isSuccess).length,
      failed: results.filter(r => r.isError).length
    });

    return results;
  }

  /**
   * Cancel all running executions
   */
  cancelAllExecutions() {
    const executionIds = Array.from(this.runningExecutions.keys());
    executionIds.forEach(id => this.cancelExecution(id));

    this.logger?.debug?.('Cancelled all running executions:', { count: executionIds.length });
  }

  /**
   * Cancel a specific execution
   * @param {number} executionId - Execution ID to cancel
   * @returns {boolean} True if execution was cancelled
   */
  cancelExecution(executionId) {
    const execution = this.runningExecutions.get(executionId);
    if (execution) {
      clearTimeout(execution.timer);
      this.runningExecutions.delete(executionId);
      this.logger?.debug?.('Cancelled execution:', { executionId });
      return true;
    }
    return false;
  }

  /**
   * Get statistics about tool executions
   * @returns {Object} Execution statistics
   */
  getStats() {
    return {
      runningExecutions: this.runningExecutions.size,
      totalExecutions: this.executionCounter,
      registeredTools: this.registry.getStats().totalTools,
      toolsWithHandlers: this.registry.getStats().toolsWithHandlers
    };
  }

  /**
   * Execute tool handler with proper context and error handling
   * @param {Function} handler - Tool handler function
   * @param {Object} args - Tool arguments
   * @param {Object} context - Execution context
   * @returns {Promise<any>} Tool result
   */
  async executeWithContext(handler, args, context) {
    try {
      // Support both async and sync handlers
      const result = await handler(args, context);
      return result;
    } catch (error) {
      // Wrap and re-throw for consistent error handling
      throw new Error(`Tool handler failed: ${error.message}`);
    }
  }

  /**
   * Validate tool arguments against schema
   * @param {Object} args - Tool arguments
   * @param {Object} schema - JSON schema
   * @param {string} toolName - Tool name for error messages
   */
  validateArguments(args, schema, toolName) {
    if (!schema || !schema.properties) return;

    // Check required parameters
    if (schema.required && Array.isArray(schema.required)) {
      for (const requiredParam of schema.required) {
        if (!(requiredParam in args)) {
          throw new ConfigurationError(
            `Missing required parameter '${requiredParam}' for tool '${toolName}'`,
            'arguments',
            'ToolExecutor'
          );
        }
      }
    }

    // Basic type validation
    if (schema.properties) {
      for (const [paramName, paramSchema] of Object.entries(schema.properties)) {
        if (paramName in args) {
          const value = args[paramName];
          const expectedType = paramSchema.type;

          if (expectedType && !this.validateParameterType(value, expectedType)) {
            throw new ConfigurationError(
              `Parameter '${paramName}' for tool '${toolName}' should be of type '${expectedType}'`,
              'arguments',
              'ToolExecutor'
            );
          }
        }
      }
    }
  }

  /**
   * Validate parameter type
   * @param {any} value - Parameter value
   * @param {string} expectedType - Expected JSON schema type
   * @returns {boolean} True if type matches
   */
  validateParameterType(value, expectedType) {
    switch (expectedType) {
      case 'string':
        return typeof value === 'string';
      case 'number':
        return typeof value === 'number' && !isNaN(value);
      case 'integer':
        return Number.isInteger(value);
      case 'boolean':
        return typeof value === 'boolean';
      case 'array':
        return Array.isArray(value);
      case 'object':
        return value !== null && typeof value === 'object' && !Array.isArray(value);
      default:
        return true; // Unknown types pass validation
    }
  }

  /**
   * Create batches for concurrent execution
   * @param {Array} items - Items to batch
   * @param {number} batchSize - Size of each batch
   * @returns {Array<Array>} Array of batches
   */
  createBatches(items, batchSize) {
    const batches = [];
    for (let i = 0; i < items.length; i += batchSize) {
      batches.push(items.slice(i, i + batchSize));
    }
    return batches;
  }

  /**
   * Clean up execution tracking
   * @param {number} executionId - Execution ID to clean up
   */
  cleanupExecution(executionId) {
    const execution = this.runningExecutions.get(executionId);
    if (execution) {
      clearTimeout(execution.timer);
      this.runningExecutions.delete(executionId);
    }
  }
}

/**
 * Built-in tool handlers for common operations
 */
export const BuiltInTools = {
  /**
   * Echo tool - returns the input
   */
  echo: {
    name: 'echo',
    description: 'Echo the input text',
    parameters: {
      type: 'object',
      properties: {
        text: { type: 'string', description: 'Text to echo' }
      },
      required: ['text']
    },
    handler: async args => args.text
  },

  /**
   * Math evaluation tool
   */
  math: {
    name: 'math',
    description: 'Evaluate a mathematical expression',
    parameters: {
      type: 'object',
      properties: {
        expression: { type: 'string', description: 'Mathematical expression to evaluate' }
      },
      required: ['expression']
    },
    handler: async args => {
      // Simple math evaluation (safe subset)
      const expr = args.expression.replace(/[^0-9+\-*/.() ]/g, '');
      try {
        return Function(`"use strict"; return (${expr})`)();
      } catch (error) {
        throw new Error(`Invalid mathematical expression: ${error.message}`);
      }
    }
  },

  /**
   * Time/date tool
   */
  datetime: {
    name: 'datetime',
    description: 'Get current date and time',
    parameters: {
      type: 'object',
      properties: {
        format: {
          type: 'string',
          description: 'Format string (iso, locale, timestamp)',
          default: 'iso'
        }
      }
    },
    handler: async args => {
      const now = new Date();
      switch (args.format) {
        case 'locale':
          return now.toLocaleString();
        case 'timestamp':
          return now.getTime();
        case 'iso':
        default:
          return now.toISOString();
      }
    }
  }
};

/**
 * Register built-in tools with a registry
 * @param {ToolRegistry} registry - Tool registry instance
 */
export function registerBuiltInTools(registry) {
  Object.values(BuiltInTools).forEach(tool => {
    registry.registerTool(tool);
  });
}
