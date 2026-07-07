// Provider adapters registry
import OpenAIAdapter from './openai.js';
import OpenAIResponsesAdapter from './openai-responses.js';
import AnthropicAdapter from './anthropic.js';
import GoogleAdapter from './google.js';
import MistralAdapter from './mistral.js';
import VLLMAdapter from './vllm.js';
import IAssistantConversationAdapter from './iassistant-conversation.js';
import BedrockAdapter from './bedrock.js';

function getAdapterRegistry() {
  return {
    openai: OpenAIAdapter,
    'openai-responses': OpenAIResponsesAdapter,
    anthropic: AnthropicAdapter,
    google: GoogleAdapter,
    mistral: MistralAdapter,
    local: VLLMAdapter, // vLLM uses dedicated adapter with schema sanitization
    'iassistant-conversation': IAssistantConversationAdapter,
    bedrock: BedrockAdapter
  };
}

/**
 * Get the appropriate adapter for a model
 * @param {string} provider - The provider name
 * @returns {Object} The provider adapter
 * @throws {Error} If the provider is not registered
 */
export function getAdapter(provider) {
  const adapters = getAdapterRegistry();
  const adapter = adapters[provider];
  if (!adapter) {
    throw new Error(
      `Unknown provider "${provider}". Supported providers: ${Object.keys(adapters).join(', ')}`
    );
  }
  return adapter;
}

/**
 * Create a completion request for the model
 * @param {Object} model - The model configuration
 * @param {Array} messages - The messages to send
 * @param {string} apiKey - The API key
 * @param {Object} options - Additional options like temperature
 * @returns {Promise<Object>} Request details including URL, headers, and body
 */
export async function createCompletionRequest(model, messages, apiKey, options = {}) {
  const adapter = getAdapter(model.provider);
  return await adapter.createCompletionRequest(model, messages, apiKey, options);
}

/**
 * Process a streaming response from the model
 * @param {string} provider - The provider name
 * @param {string} buffer - The response buffer to process
 * @returns {Promise<Object>} Result containing content, completion status and a normalized finish reason
 */
export async function processResponseBuffer(provider, buffer) {
  const adapter = getAdapter(provider);
  return await adapter.processResponseBuffer(buffer);
}

/**
 * Format messages for the provider's API
 * @param {string} provider - The provider name
 * @param {Array} messages - The messages to format
 * @returns {Array} Formatted messages for the provider
 */
export function formatMessages(provider, messages) {
  const adapter = getAdapter(provider);
  return adapter.formatMessages(messages);
}

/**
 * Get the provider-specific config schema declared by the adapter (if any).
 * The schema describes fields that are written to `model.config[key]` and
 * is consumed by the admin Model Form Editor for dynamic field rendering.
 *
 * @param {string} provider - The provider name
 * @returns {Promise<object|null>}
 */
export async function getProviderConfigSchema(provider) {
  if (!provider) return null;
  switch (provider) {
    case 'bedrock': {
      const mod = await import('./bedrock.js');
      return mod.providerConfigSchema || null;
    }
    default:
      return null;
  }
}
