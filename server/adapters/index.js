// Provider adapters registry
import OpenAIAdapter from './openai.js';
import AnthropicAdapter from './anthropic.js';
import GoogleAdapter from './google.js';
import MistralAdapter from './mistral.js';
import VLLMAdapter from './vllm.js';

// Import SDK Bridge (conditional)
let SDKBridge = null;
const USE_SDK = process.env.USE_LLM_SDK === 'true';

if (USE_SDK) {
  try {
    const sdkModule = await import('./sdk-bridge.js');
    SDKBridge = sdkModule;
    console.log('🚀 LLM SDK Bridge enabled');
  } catch (error) {
    console.warn('⚠️  Failed to load SDK Bridge, falling back to legacy adapters:', error.message);
  }
}

// Adapter registry
const adapters = {
  openai: OpenAIAdapter,
  anthropic: AnthropicAdapter,
  google: GoogleAdapter,
  mistral: MistralAdapter,
  local: VLLMAdapter // vLLM uses dedicated adapter with schema sanitization
};

/**
 * Get the appropriate adapter for a model
 * @param {string} provider - The provider name
 * @returns {Object} The provider adapter
 */
export function getAdapter(provider) {
  const adapter = adapters[provider] || adapters['openai']; // Fallback to OpenAI
  return adapter;
}

/**
 * Create a completion request for the model
 * @param {Object} model - The model configuration
 * @param {Array} messages - The messages to send
 * @param {string} apiKey - The API key
 * @param {Object} options - Additional options like temperature
 * @returns {Object} Request details including URL, headers, and body
 */
export async function createCompletionRequest(model, messages, apiKey, options = {}) {
  // Use SDK Bridge if available
  if (USE_SDK && SDKBridge) {
    try {
      return await SDKBridge.createCompletionRequest(model, messages, apiKey, options);
    } catch (error) {
      console.warn(
        'SDK Bridge createCompletionRequest failed, falling back to legacy:',
        error.message
      );
    }
  }

  // Fallback to legacy adapters
  const adapter = getAdapter(model.provider);
  return adapter.createCompletionRequest(model, messages, apiKey, options);
}

/**
 * Process a streaming response from the model
 * @param {string} provider - The provider name
 * @param {string} buffer - The response buffer to process
 * @returns {Object} Result containing content, completion status and a normalized finish reason
 */
export async function processResponseBuffer(provider, buffer) {
  // Use SDK Bridge if available
  if (USE_SDK && SDKBridge) {
    try {
      return await SDKBridge.processResponseBuffer(provider, buffer);
    } catch (error) {
      console.warn(
        'SDK Bridge processResponseBuffer failed, falling back to legacy:',
        error.message
      );
    }
  }

  // Fallback to legacy adapters
  const adapter = getAdapter(provider);
  return adapter.processResponseBuffer(buffer);
}

/**
 * Format messages for the provider's API
 * @param {string} provider - The provider name
 * @param {Array} messages - The messages to format
 * @returns {Array} Formatted messages for the provider
 */
export async function formatMessages(provider, messages) {
  // Use SDK Bridge if available
  if (USE_SDK && SDKBridge) {
    try {
      return await SDKBridge.formatMessages(provider, messages);
    } catch (error) {
      console.warn('SDK Bridge formatMessages failed, falling back to legacy:', error.message);
    }
  }

  // Fallback to legacy adapters
  const adapter = getAdapter(provider);
  return adapter.formatMessages(messages);
}

/**
 * Get SDK client for advanced operations (when SDK is enabled)
 * @returns {Promise<LLMClient|null>} SDK client or null if not available
 */
export async function getSDKClient() {
  if (USE_SDK && SDKBridge) {
    try {
      return await SDKBridge.getSDKClient();
    } catch (error) {
      console.warn('Failed to get SDK client:', error.message);
    }
  }
  return null;
}
