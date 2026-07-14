/**
 * Tool Calling Converter - Main Interface
 *
 * This is the main interface for the generic tool calling system.
 * It provides unified methods to convert between any provider format
 * and the generic format.
 */

import * as OpenAIConverter from './OpenAIConverter.js';
import * as OpenAIResponsesConverter from './OpenAIResponsesConverter.js';
import * as AnthropicConverter from './AnthropicConverter.js';
import * as GoogleConverter from './GoogleConverter.js';
import * as MistralConverter from './MistralConverter.js';
import * as VLLMConverter from './VLLMConverter.js';
import * as BedrockConverter from './BedrockConverter.js';

// GenericToolCalling exports are re-exported from converters, not directly used here

/**
 * Provider converter mappings
 */
const CONVERTERS = {
  openai: OpenAIConverter,
  'openai-responses': OpenAIResponsesConverter,
  anthropic: AnthropicConverter,
  google: GoogleConverter,
  mistral: MistralConverter,
  local: VLLMConverter, // vLLM uses dedicated converter with schema sanitization
  bedrock: BedrockConverter
};

/**
 * Convert tools from any provider format to generic format
 * @param {Object[]} tools - Tools in provider format
 * @param {string} sourceProvider - Source provider name
 * @returns {import('./GenericToolCalling.js').GenericTool[]} Generic tools
 */
export function convertToolsToGeneric(tools, sourceProvider) {
  const converter = CONVERTERS[sourceProvider];
  if (!converter) {
    throw new Error(`Unsupported provider for tool conversion: ${sourceProvider}`);
  }

  const converterFunction = converter[`convert${capitalize(sourceProvider)}ToolsToGeneric`];
  if (!converterFunction) {
    throw new Error(`No tool converter found for provider: ${sourceProvider}`);
  }

  return converterFunction(tools);
}

/**
 * Convert tools from generic format to any provider format
 * @param {import('./GenericToolCalling.js').GenericTool[]} genericTools - Generic tools
 * @param {string} targetProvider - Target provider name
 * @returns {Object[]|Object} Tools in provider format (or object with tools and toolChoice for vLLM)
 */
export function convertToolsFromGeneric(genericTools, targetProvider) {
  if (!Array.isArray(genericTools) || genericTools.length === 0) {
    return [];
  }

  const converter = CONVERTERS[targetProvider];
  if (!converter) {
    throw new Error(`Unsupported provider for tool conversion: ${targetProvider}`);
  }

  const converterFunction = converter[`convertGenericToolsTo${capitalize(targetProvider)}`];
  if (!converterFunction) {
    throw new Error(`No tool converter found for provider: ${targetProvider}`);
  }

  return converterFunction(genericTools);
}

/**
 * Convert tool calls from any provider format to generic format
 * @param {Object[]} toolCalls - Tool calls in provider format
 * @param {string} sourceProvider - Source provider name
 * @returns {import('./GenericToolCalling.js').GenericToolCall[]} Generic tool calls
 */
export function convertToolCallsToGeneric(toolCalls, sourceProvider) {
  const converter = CONVERTERS[sourceProvider];
  if (!converter) {
    throw new Error(`Unsupported provider for tool call conversion: ${sourceProvider}`);
  }

  const converterFunction =
    converter[`convert${capitalize(sourceProvider)}ToolCallsToGeneric`] ||
    converter[`convert${capitalize(sourceProvider)}ToolUseToGeneric`]; // For Anthropic
  if (!converterFunction) {
    throw new Error(`No tool call converter found for provider: ${sourceProvider}`);
  }

  return converterFunction(toolCalls);
}

/**
 * Convert tool calls from generic format to any provider format
 * @param {import('./GenericToolCalling.js').GenericToolCall[]} genericToolCalls - Generic tool calls
 * @param {string} targetProvider - Target provider name
 * @returns {Object[]} Tool calls in provider format
 */
export function convertToolCallsFromGeneric(genericToolCalls, targetProvider) {
  const converter = CONVERTERS[targetProvider];
  if (!converter) {
    throw new Error(`Unsupported provider for tool call conversion: ${targetProvider}`);
  }

  const converterFunction = converter[`convertGenericToolCallsTo${capitalize(targetProvider)}`];
  if (!converterFunction) {
    throw new Error(`No tool call converter found for provider: ${targetProvider}`);
  }

  return converterFunction(genericToolCalls);
}

/**
 * Convert streaming response from any provider format to generic format
 * @param {string} data - Raw response data
 * @param {string} sourceProvider - Source provider name
 * @param {string} streamId - Stream identifier for stateful processing
 * @returns {Promise<import('./GenericToolCalling.js').GenericStreamingResponse>} Generic streaming response
 */
export async function convertResponseToGeneric(data, sourceProvider, streamId = 'default') {
  const converter = CONVERTERS[sourceProvider];
  if (!converter) {
    throw new Error(`Unsupported provider for response conversion: ${sourceProvider}`);
  }

  const converterFunction = converter[`convert${capitalize(sourceProvider)}ResponseToGeneric`];
  if (!converterFunction) {
    throw new Error(`No response converter found for provider: ${sourceProvider}`);
  }

  return await converterFunction(data, streamId);
}

/**
 * Discard accumulated per-stream state (e.g. pending tool call accumulation) for a
 * stream that errored, was aborted, or otherwise ended without reaching its natural
 * completion event. Providers without stateful streaming (e.g. Google, Mistral) have
 * no clear function and this is a no-op for them.
 * @param {string} sourceProvider - Source provider name
 * @param {string} streamId - Stream identifier to clear
 */
export function clearStreamingState(sourceProvider, streamId = 'default') {
  const converter = CONVERTERS[sourceProvider];
  if (!converter) return;

  const clearFunction = converter[`clear${capitalize(sourceProvider)}StreamingState`];
  if (clearFunction) {
    clearFunction(streamId);
  }
}

/**
 * Convert streaming response from generic format to any provider format
 * @param {import('./GenericToolCalling.js').GenericStreamingResponse} genericResponse - Generic response
 * @param {string} targetProvider - Target provider name
 * @param {Object} options - Additional options (completionId, modelId, isFirstChunk, etc.)
 * @returns {Object} Response in provider format
 */
export function convertResponseFromGeneric(genericResponse, targetProvider, options = {}) {
  const converter = CONVERTERS[targetProvider];
  if (!converter) {
    throw new Error(`Unsupported provider for response conversion: ${targetProvider}`);
  }

  const converterFunction = converter[`convertGenericResponseTo${capitalize(targetProvider)}`];
  if (!converterFunction) {
    throw new Error(`No response converter found for provider: ${targetProvider}`);
  }

  return converterFunction(
    genericResponse,
    options.completionId,
    options.modelId,
    options.isFirstChunk
  );
}

/**
 * Utility function to capitalize provider names for function name generation
 * @param {string} str - String to capitalize
 * @returns {string} Capitalized string with proper casing for function names
 */
function capitalize(str) {
  // Handle special cases for provider naming
  switch (str.toLowerCase()) {
    case 'openai':
      return 'OpenAI';
    case 'openai-responses':
      return 'OpenaiResponses';
    case 'local':
      return 'VLLM'; // Local uses VLLM converter functions
    default:
      return str.charAt(0).toUpperCase() + str.slice(1);
  }
}
