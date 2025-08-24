/**
 * Tool registry for managing tool definitions and conversions
 */

import { ProviderError, ConfigurationError } from '../utils/ErrorHandler.js';
import { Validator } from '../utils/Validator.js';

/**
 * Registry for managing tools and their provider-specific formats
 */
export class ToolRegistry {
  constructor(logger) {
    this.logger = logger;
    this.tools = new Map();
    this.converters = new Map();
    this.handlers = new Map();

    // Initialize built-in converters
    this.initializeConverters();
  }

  /**
   * Register a tool definition
   * @param {Object} toolDefinition - Tool definition
   * @param {string} toolDefinition.name - Tool name
   * @param {string} toolDefinition.description - Tool description
   * @param {Object} toolDefinition.parameters - JSON schema for parameters
   * @param {Function} [toolDefinition.handler] - Tool execution handler
   * @param {Object} [toolDefinition.metadata] - Additional metadata
   * @returns {ToolRegistry} Self for chaining
   */
  registerTool(toolDefinition) {
    const { name, description, parameters, handler, metadata = {} } = toolDefinition;

    if (!name || typeof name !== 'string') {
      throw new ConfigurationError(
        'Tool name is required and must be a string',
        'name',
        'ToolRegistry'
      );
    }

    if (!description || typeof description !== 'string') {
      throw new ConfigurationError(
        'Tool description is required and must be a string',
        'description',
        'ToolRegistry'
      );
    }

    // Validate parameters schema
    if (parameters && !this.isValidJsonSchema(parameters)) {
      throw new ConfigurationError(
        'Tool parameters must be a valid JSON schema',
        'parameters',
        'ToolRegistry'
      );
    }

    const normalizedName = this.normalizeToolName(name);
    const tool = {
      id: normalizedName,
      name: normalizedName,
      description,
      parameters: parameters || { type: 'object', properties: {} },
      metadata,
      handler
    };

    this.tools.set(normalizedName, tool);

    if (handler && typeof handler === 'function') {
      this.handlers.set(normalizedName, handler);
    }

    this.logger?.debug?.('Tool registered:', { name: normalizedName, hasHandler: !!handler });
    return this;
  }

  /**
   * Register multiple tools at once
   * @param {Array<Object>} toolDefinitions - Array of tool definitions
   * @returns {ToolRegistry} Self for chaining
   */
  registerTools(toolDefinitions) {
    if (!Array.isArray(toolDefinitions)) {
      throw new ConfigurationError(
        'Tool definitions must be an array',
        'toolDefinitions',
        'ToolRegistry'
      );
    }

    toolDefinitions.forEach(tool => this.registerTool(tool));
    return this;
  }

  /**
   * Unregister a tool
   * @param {string} name - Tool name to unregister
   * @returns {boolean} True if tool was found and removed
   */
  unregisterTool(name) {
    const normalizedName = this.normalizeToolName(name);
    const removed = this.tools.delete(normalizedName);
    this.handlers.delete(normalizedName);
    return removed;
  }

  /**
   * Get a tool definition by name
   * @param {string} name - Tool name
   * @returns {Object|null} Tool definition or null if not found
   */
  getTool(name) {
    const normalizedName = this.normalizeToolName(name);
    return this.tools.get(normalizedName) || null;
  }

  /**
   * Check if a tool is registered
   * @param {string} name - Tool name
   * @returns {boolean} True if tool is registered
   */
  hasTool(name) {
    const normalizedName = this.normalizeToolName(name);
    return this.tools.has(normalizedName);
  }

  /**
   * List all registered tool names
   * @returns {Array<string>} Array of tool names
   */
  listTools() {
    return Array.from(this.tools.keys());
  }

  /**
   * Get all tool definitions
   * @returns {Array<Object>} Array of tool definitions
   */
  getAllTools() {
    return Array.from(this.tools.values());
  }

  /**
   * Get tools formatted for a specific provider
   * @param {string} provider - Provider name
   * @param {Array<string>} [toolNames] - Optional array of specific tool names to include
   * @returns {Array<Object>} Provider-formatted tools
   */
  getToolsForProvider(provider, toolNames = null) {
    const converter = this.getConverter(provider);
    const toolsToConvert = toolNames
      ? toolNames.map(name => this.getTool(name)).filter(Boolean)
      : this.getAllTools();

    return toolsToConvert.map(tool => converter.formatTool(tool));
  }

  /**
   * Register a provider-specific converter
   * @param {string} provider - Provider name
   * @param {Object} converter - Converter object with formatTool, parseToolCall, formatToolResponse methods
   * @returns {ToolRegistry} Self for chaining
   */
  registerConverter(provider, converter) {
    if (!provider || typeof provider !== 'string') {
      throw new ConfigurationError(
        'Provider name is required and must be a string',
        'provider',
        'ToolRegistry'
      );
    }

    if (!converter || typeof converter !== 'object') {
      throw new ConfigurationError(
        'Converter is required and must be an object',
        'converter',
        'ToolRegistry'
      );
    }

    // Validate converter interface
    const requiredMethods = ['formatTool', 'parseToolCall', 'formatToolResponse'];
    for (const method of requiredMethods) {
      if (typeof converter[method] !== 'function') {
        throw new ConfigurationError(
          `Converter must have ${method} method`,
          'converter',
          'ToolRegistry'
        );
      }
    }

    this.converters.set(provider.toLowerCase(), converter);
    this.logger?.debug?.('Converter registered for provider:', provider);
    return this;
  }

  /**
   * Get converter for a provider
   * @param {string} provider - Provider name
   * @returns {Object} Converter object
   */
  getConverter(provider) {
    const converter = this.converters.get(provider.toLowerCase());
    if (!converter) {
      throw new ProviderError(
        `No converter available for provider: ${provider}`,
        provider,
        'CONVERTER_NOT_FOUND'
      );
    }
    return converter;
  }

  /**
   * Parse tool calls from provider response
   * @param {Array|Object} toolCalls - Tool calls from provider
   * @param {string} provider - Provider name
   * @returns {Array<Object>} Normalized tool calls
   */
  parseToolCalls(toolCalls, provider) {
    if (!toolCalls) return [];

    const converter = this.getConverter(provider);
    const calls = Array.isArray(toolCalls) ? toolCalls : [toolCalls];

    return calls.map(call => converter.parseToolCall(call));
  }

  /**
   * Format tool responses for provider
   * @param {Array<Object>} results - Tool execution results
   * @param {string} provider - Provider name
   * @returns {Array<Object>} Provider-formatted tool responses
   */
  formatToolResponses(results, provider) {
    if (!results || results.length === 0) return [];

    const converter = this.getConverter(provider);
    return results.map(result => converter.formatToolResponse(result));
  }

  /**
   * Get tool handler for execution
   * @param {string} name - Tool name
   * @returns {Function|null} Tool handler function or null
   */
  getHandler(name) {
    const normalizedName = this.normalizeToolName(name);
    return this.handlers.get(normalizedName) || null;
  }

  /**
   * Check if a tool has a handler
   * @param {string} name - Tool name
   * @returns {boolean} True if tool has a handler
   */
  hasHandler(name) {
    const normalizedName = this.normalizeToolName(name);
    return this.handlers.has(normalizedName);
  }

  /**
   * Normalize tool name to be compatible across providers
   * @param {string} name - Original tool name
   * @returns {string} Normalized tool name
   */
  normalizeToolName(name) {
    if (!name || typeof name !== 'string') return 'unnamed_tool';

    // Replace invalid characters with underscores
    const normalized = name.replace(/[^A-Za-z0-9_.-]/g, '_');

    // Ensure name starts with letter or underscore
    if (normalized && !/^[A-Za-z_]/.test(normalized)) {
      return `tool_${normalized}`;
    }

    return normalized || 'unnamed_tool';
  }

  /**
   * Validate JSON schema
   * @param {Object} schema - JSON schema to validate
   * @returns {boolean} True if valid
   */
  isValidJsonSchema(schema) {
    if (!schema || typeof schema !== 'object') return false;

    // Basic schema validation
    if (schema.type && typeof schema.type !== 'string') return false;
    if (schema.properties && typeof schema.properties !== 'object') return false;
    if (schema.required && !Array.isArray(schema.required)) return false;

    return true;
  }

  /**
   * Initialize built-in converters for common providers
   */
  initializeConverters() {
    // OpenAI/VLLM converter
    this.registerConverter('openai', new OpenAIConverter());
    this.registerConverter('vllm', new OpenAIConverter());

    // Anthropic converter
    this.registerConverter('anthropic', new AnthropicConverter());

    // Google converter
    this.registerConverter('google', new GoogleConverter());

    // Mistral converter
    this.registerConverter('mistral', new MistralConverter());
  }

  /**
   * Clear all tools and handlers
   */
  clear() {
    this.tools.clear();
    this.handlers.clear();
    this.logger?.debug?.('All tools cleared from registry');
  }

  /**
   * Get registry statistics
   * @returns {Object} Registry statistics
   */
  getStats() {
    return {
      totalTools: this.tools.size,
      toolsWithHandlers: this.handlers.size,
      supportedProviders: this.converters.size,
      providers: Array.from(this.converters.keys())
    };
  }
}

/**
 * Base converter class for provider-specific tool format conversion
 */
class BaseConverter {
  /**
   * Format a tool definition for the provider
   * @param {Object} tool - Generic tool definition
   * @returns {Object} Provider-formatted tool
   */
  formatTool(tool) {
    throw new Error('formatTool must be implemented by provider converter');
  }

  /**
   * Parse a tool call from provider response
   * @param {Object} toolCall - Provider tool call
   * @returns {Object} Normalized tool call
   */
  parseToolCall(toolCall) {
    throw new Error('parseToolCall must be implemented by provider converter');
  }

  /**
   * Format tool execution result for provider
   * @param {Object} result - Tool execution result
   * @returns {Object} Provider-formatted tool response
   */
  formatToolResponse(result) {
    throw new Error('formatToolResponse must be implemented by provider converter');
  }
}

/**
 * OpenAI-compatible converter (OpenAI, VLLM)
 */
class OpenAIConverter extends BaseConverter {
  formatTool(tool) {
    return {
      type: 'function',
      function: {
        name: tool.name,
        description: tool.description,
        parameters: tool.parameters
      }
    };
  }

  parseToolCall(toolCall) {
    let args = {};
    try {
      args =
        typeof toolCall.function.arguments === 'string'
          ? JSON.parse(toolCall.function.arguments)
          : toolCall.function.arguments;
    } catch (error) {
      args = { _parse_error: toolCall.function.arguments };
    }

    return {
      id: toolCall.id,
      name: toolCall.function.name,
      arguments: args
    };
  }

  formatToolResponse(result) {
    return {
      role: 'tool',
      tool_call_id: result.toolCallId,
      name: result.name,
      content: result.isSuccess
        ? typeof result.result === 'string'
          ? result.result
          : JSON.stringify(result.result)
        : `Error: ${result.error?.message || 'Tool execution failed'}`
    };
  }
}

/**
 * Anthropic converter
 */
class AnthropicConverter extends BaseConverter {
  formatTool(tool) {
    return {
      name: tool.name,
      description: tool.description,
      input_schema: tool.parameters
    };
  }

  parseToolCall(toolCall) {
    return {
      id: toolCall.id,
      name: toolCall.name,
      arguments: toolCall.input || {}
    };
  }

  formatToolResponse(result) {
    return {
      role: 'user',
      content: [
        {
          type: 'tool_result',
          tool_use_id: result.toolCallId,
          content: result.isSuccess
            ? typeof result.result === 'string'
              ? result.result
              : JSON.stringify(result.result)
            : `Error: ${result.error?.message || 'Tool execution failed'}`,
          is_error: !result.isSuccess
        }
      ]
    };
  }
}

/**
 * Google converter
 */
class GoogleConverter extends BaseConverter {
  formatTool(tool) {
    return {
      functionDeclarations: [
        {
          name: tool.name,
          description: tool.description,
          parameters: tool.parameters
        }
      ]
    };
  }

  parseToolCall(toolCall) {
    return {
      id: `${toolCall.name}_${Date.now()}`,
      name: toolCall.name,
      arguments: toolCall.args || {}
    };
  }

  formatToolResponse(result) {
    return {
      role: 'function',
      parts: [
        {
          functionResponse: {
            name: result.name,
            response: result.isSuccess
              ? result.result
              : {
                  error: result.error?.message || 'Tool execution failed'
                }
          }
        }
      ]
    };
  }
}

/**
 * Mistral converter
 */
class MistralConverter extends BaseConverter {
  formatTool(tool) {
    return {
      type: 'function',
      function: {
        name: tool.name,
        description: tool.description,
        parameters: tool.parameters
      }
    };
  }

  parseToolCall(toolCall) {
    let args = {};
    try {
      args =
        typeof toolCall.function.arguments === 'string'
          ? JSON.parse(toolCall.function.arguments)
          : toolCall.function.arguments;
    } catch (error) {
      args = { _parse_error: toolCall.function.arguments };
    }

    return {
      id: toolCall.id,
      name: toolCall.function.name,
      arguments: args
    };
  }

  formatToolResponse(result) {
    return {
      role: 'tool',
      tool_call_id: result.toolCallId,
      name: result.name,
      content: result.isSuccess
        ? typeof result.result === 'string'
          ? result.result
          : JSON.stringify(result.result)
        : `Error: ${result.error?.message || 'Tool execution failed'}`
    };
  }
}
