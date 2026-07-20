/**
 * Generic Tool Calling System - Main Export
 *
 * This module provides a unified interface for tool/function calling across
 * different LLM providers. It handles bidirectional conversion between
 * provider-specific formats and a normalized generic format.
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
  convertToolCallsToGeneric,
  convertToolCallsFromGeneric,
  convertResponseToGeneric,
  convertResponseFromGeneric,
  clearStreamingState
} from './ToolCallingConverter.js';

// Export generic tool calling utilities
export {
  normalizeToolName,
  createGenericTool,
  createGenericToolCall,
  createGenericStreamingResponse,
  normalizeFinishReason,
  isFailureFinishReason,
  FAILURE_FINISH_REASONS,
  sanitizeSchemaForProvider
} from './GenericToolCalling.js';

// Export individual provider converters for advanced use cases
export * as OpenAIConverter from './OpenAIConverter.js';
export * as OpenAIResponsesConverter from './OpenAIResponsesConverter.js';
export * as AnthropicConverter from './AnthropicConverter.js';
export * as GoogleConverter from './GoogleConverter.js';
export * as MistralConverter from './MistralConverter.js';
