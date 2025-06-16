// Provider adapters registry
import OpenAIAdapter from './openai.js';
import AnthropicAdapter from './anthropic.js';
import GoogleAdapter from './google.js';
export { parseSSEBuffer } from './streamUtils.js';

// Adapter registry
const adapters = {
  'openai': OpenAIAdapter,
  'anthropic': AnthropicAdapter,
  'google': GoogleAdapter
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
export function createCompletionRequest(model, messages, apiKey, options = {}) {
  const adapter = getAdapter(model.provider);
  return adapter.createCompletionRequest(model, messages, apiKey, options);
}

/**
 * Process a streaming response from the model
 * @param {string} provider - The provider name
 * @param {string} buffer - The response buffer to process
 * @returns {Object} Result containing content, completion status and a normalized finish reason
 */
export function processResponseBuffer(provider, buffer) {
  const adapter = getAdapter(provider);
  return adapter.processResponseBuffer(buffer);
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