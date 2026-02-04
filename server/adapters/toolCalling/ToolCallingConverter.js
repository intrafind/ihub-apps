/**
 * Tool Calling Converter - Main Interface
 *
 * This is the main interface for the generic tool calling system.
 * It provides unified methods to convert between any provider format
 * and the generic format, as well as cross-provider conversions.
 */

import * as OpenAIConverter from './OpenAIConverter.js';
import * as OpenAIResponsesConverter from './OpenAIResponsesConverter.js';
import * as AnthropicConverter from './AnthropicConverter.js';
import * as GoogleConverter from './GoogleConverter.js';
import * as MistralConverter from './MistralConverter.js';
import * as VLLMConverter from './VLLMConverter.js';
import * as IAssistantConverter from './IAssistantConverter.js';

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
  iassistant: IAssistantConverter
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
 * Convert tools between any two provider formats
 * @param {Object[]} tools - Tools in source provider format
 * @param {string} sourceProvider - Source provider name
 * @param {string} targetProvider - Target provider name
 * @returns {Object[]} Tools in target provider format
 */
export function convertToolsBetweenProviders(tools, sourceProvider, targetProvider) {
  if (sourceProvider === targetProvider) {
    return tools; // No conversion needed
  }

  // Convert to generic format first, then to target format
  const genericTools = convertToolsToGeneric(tools, sourceProvider);
  return convertToolsFromGeneric(genericTools, targetProvider);
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
 * @returns {import('./GenericToolCalling.js').GenericStreamingResponse} Generic streaming response
 */
export function convertResponseToGeneric(data, sourceProvider, streamId = 'default') {
  const converter = CONVERTERS[sourceProvider];
  if (!converter) {
    throw new Error(`Unsupported provider for response conversion: ${sourceProvider}`);
  }

  const converterFunction = converter[`convert${capitalize(sourceProvider)}ResponseToGeneric`];
  if (!converterFunction) {
    throw new Error(`No response converter found for provider: ${sourceProvider}`);
  }

  return converterFunction(data, streamId);
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
 * Convert streaming response between any two provider formats
 * @param {string} data - Raw response data in source format
 * @param {string} sourceProvider - Source provider name
 * @param {string} targetProvider - Target provider name
 * @param {Object} options - Additional options for target format
 * @returns {Object} Response in target provider format
 */
export function convertResponseBetweenProviders(
  data,
  sourceProvider,
  targetProvider,
  options = {}
) {
  if (sourceProvider === targetProvider) {
    // Parse and return the data for same provider
    try {
      return JSON.parse(data);
    } catch {
      return data;
    }
  }

  // Convert to generic format first, then to target format
  const genericResponse = convertResponseToGeneric(data, sourceProvider);
  return convertResponseFromGeneric(genericResponse, targetProvider, options);
}

/**
 * Process message for a specific provider format
 * @param {Object} message - Message to process
 * @param {string} provider - Target provider name
 * @returns {Object} Processed message for provider
 */
export function processMessageForProvider(message, provider) {
  const converter = CONVERTERS[provider];
  if (!converter) {
    return message; // Return as-is if no converter
  }

  const processorFunction = converter[`processMessageFor${capitalize(provider)}`];
  if (!processorFunction) {
    return message; // Return as-is if no processor
  }

  return processorFunction(message);
}

/**
 * Get supported providers
 * @returns {string[]} Array of supported provider names
 */
export function getSupportedProviders() {
  return Object.keys(CONVERTERS);
}

/**
 * Check if a provider is supported
 * @param {string} provider - Provider name to check
 * @returns {boolean} Whether the provider is supported
 */
export function isProviderSupported(provider) {
  return provider in CONVERTERS;
}

/**
 * Get converter for a specific provider
 * @param {string} provider - Provider name
 * @returns {Object} Provider converter module
 */
export function getProviderConverter(provider) {
  return CONVERTERS[provider];
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
    case 'iassistant':
      return 'Iassistant'; // Keep consistent with existing function name
    default:
      return str.charAt(0).toUpperCase() + str.slice(1);
  }
}

/**
 * Batch convert multiple responses for efficient processing
 * @param {string[]} dataArray - Array of raw response data
 * @param {string} sourceProvider - Source provider name
 * @param {string} targetProvider - Target provider name
 * @param {Object} options - Conversion options
 * @returns {Object[]} Array of converted responses
 */
export function batchConvertResponses(dataArray, sourceProvider, targetProvider, options = {}) {
  return dataArray.map((data, index) => {
    const indexedOptions = { ...options, index };
    return convertResponseBetweenProviders(data, sourceProvider, targetProvider, indexedOptions);
  });
}

/**
 * Create a unified tool calling interface for any provider
 * @param {string} provider - Provider name
 * @returns {Object} Unified interface object
 */
export function createUnifiedInterface(provider) {
  if (!isProviderSupported(provider)) {
    throw new Error(`Unsupported provider: ${provider}`);
  }

  return {
    provider,
    convertToolsToGeneric: tools => convertToolsToGeneric(tools, provider),
    convertToolsFromGeneric: genericTools => convertToolsFromGeneric(genericTools, provider),
    convertToolCallsToGeneric: toolCalls => convertToolCallsToGeneric(toolCalls, provider),
    convertToolCallsFromGeneric: genericToolCalls =>
      convertToolCallsFromGeneric(genericToolCalls, provider),
    convertResponseToGeneric: data => convertResponseToGeneric(data, provider),
    convertResponseFromGeneric: (genericResponse, options) =>
      convertResponseFromGeneric(genericResponse, provider, options),
    processMessage: message => processMessageForProvider(message, provider),

    // Convenience methods for cross-provider conversion
    convertToolsTo: (tools, targetProvider) =>
      convertToolsBetweenProviders(tools, provider, targetProvider),
    convertResponseTo: (data, targetProvider, options) =>
      convertResponseBetweenProviders(data, provider, targetProvider, options)
  };
}
