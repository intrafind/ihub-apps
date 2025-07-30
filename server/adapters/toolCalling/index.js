/**
 * Generic Tool Calling System - Main Export
 * 
 * This module provides a unified interface for tool/function calling across
 * different LLM providers. It handles bidirectional conversion between 
 * provider-specific formats and a normalized generic format.
 * 
 * @example
 * // Convert OpenAI tools to work with Anthropic
 * import { convertToolsBetweenProviders } from './toolCalling/index.js';
 * 
 * const openaiTools = [{ type: 'function', function: { name: 'search', ... } }];
 * const anthropicTools = convertToolsBetweenProviders(openaiTools, 'openai', 'anthropic');
 * 
 * @example
 * // Process streaming responses uniformly
 * import { convertResponseToGeneric } from './toolCalling/index.js';
 * 
 * const genericResponse = convertResponseToGeneric(rawResponse, 'anthropic');
 * // Now you have a uniform response format regardless of provider
 */

// Export main converter interface
export {
  convertToolsToGeneric,
  convertToolsFromGeneric,
  convertToolsBetweenProviders,
  convertToolCallsToGeneric,
  convertToolCallsFromGeneric,
  convertResponseToGeneric,
  convertResponseFromGeneric,
  convertResponseBetweenProviders,
  processMessageForProvider,
  getSupportedProviders,
  isProviderSupported,
  getProviderConverter,
  batchConvertResponses,
  createUnifiedInterface
} from './ToolCallingConverter.js';

// Export generic tool calling utilities
export {
  normalizeToolName,
  createGenericTool,
  createGenericToolCall,
  createGenericToolResult,
  createGenericStreamingResponse,
  normalizeFinishReason,
  sanitizeSchemaForProvider
} from './GenericToolCalling.js';

// Export individual provider converters for advanced use cases
export * as OpenAIConverter from './OpenAIConverter.js';
export * as AnthropicConverter from './AnthropicConverter.js';
export * as GoogleConverter from './GoogleConverter.js';
export * as MistralConverter from './MistralConverter.js';

// Export the main converter class for legacy compatibility
export { ToolCallingConverter } from './ToolCallingConverter.js';

/**
 * Quick-start factory function to create a converter for a specific provider
 * @param {string} provider - Provider name ('openai', 'anthropic', 'google', 'mistral')
 * @returns {Object} Provider-specific converter interface
 */
export function createConverter(provider) {
  return createUnifiedInterface(provider);
}

/**
 * Supported provider constants
 */
export const PROVIDERS = {
  OPENAI: 'openai',
  ANTHROPIC: 'anthropic',
  GOOGLE: 'google',
  MISTRAL: 'mistral'
};

/**
 * Common tool calling patterns and utilities
 */
export const ToolCallPatterns = {
  /**
   * Create a simple text generation tool definition
   * @param {string} name - Tool name
   * @param {string} description - Tool description
   * @returns {import('./GenericToolCalling.js').GenericTool} Generic tool definition
   */
  createTextTool(name, description) {
    return {
      id: name,
      name: normalizeToolName(name),
      description,
      parameters: {
        type: 'object',
        properties: {
          text: {
            type: 'string',
            description: 'The text to process'
          }
        },
        required: ['text']
      }
    };
  },

  /**
   * Create a search tool definition
   * @param {string} name - Tool name
   * @param {string} description - Tool description
   * @returns {import('./GenericToolCalling.js').GenericTool} Generic tool definition
   */
  createSearchTool(name, description) {
    return {
      id: name,
      name: normalizeToolName(name),
      description,
      parameters: {
        type: 'object',
        properties: {
          query: {
            type: 'string',
            description: 'The search query'
          },
          limit: {
            type: 'integer',
            description: 'Maximum number of results',
            default: 10
          }
        },
        required: ['query']
      }
    };
  },

  /**
   * Create a web API tool definition
   * @param {string} name - Tool name
   * @param {string} description - Tool description
   * @param {Object} parameters - Custom parameters schema
   * @returns {import('./GenericToolCalling.js').GenericTool} Generic tool definition
   */
  createApiTool(name, description, parameters = {}) {
    return {
      id: name,
      name: normalizeToolName(name),
      description,
      parameters: {
        type: 'object',
        properties: {
          endpoint: {
            type: 'string',
            description: 'API endpoint URL'
          },
          method: {
            type: 'string',
            enum: ['GET', 'POST', 'PUT', 'DELETE'],
            default: 'GET',
            description: 'HTTP method'
          },
          ...parameters.properties
        },
        required: ['endpoint', ...(parameters.required || [])]
      }
    };
  }
};

/**
 * Error types for tool calling operations
 */
export class ToolCallingError extends Error {
  constructor(message, provider, operation) {
    super(message);
    this.name = 'ToolCallingError';
    this.provider = provider;
    this.operation = operation;
  }
}

export class UnsupportedProviderError extends ToolCallingError {
  constructor(provider) {
    super(`Unsupported provider: ${provider}`, provider, 'provider_check');
    this.name = 'UnsupportedProviderError';
  }
}

export class ConversionError extends ToolCallingError {
  constructor(message, provider, operation) {
    super(message, provider, operation);
    this.name = 'ConversionError';
  }
}