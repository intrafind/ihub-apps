/**
 * LLM SDK - Unified interface for multiple LLM providers
 */

// Core classes
export { LLMClient } from './core/LLMClient.js';
export { Provider } from './core/Provider.js';
export {
  Message,
  ContentPart,
  ToolCall,
  createConversation,
  estimateTokenCount
} from './core/Message.js';
export {
  Response,
  ResponseChoice,
  ResponseChunk,
  ResponseDelta,
  ResponseChoiceDelta,
  ResponseAggregator,
  Usage
} from './core/Response.js';

// Configuration
export { ModelConfig, Model } from './config/ModelConfig.js';
export { ProviderConfig } from './config/ProviderConfig.js';

// Utilities
export {
  LLMError,
  ConfigurationError,
  ValidationError,
  ProviderError,
  NetworkError,
  RateLimitError,
  ToolExecutionError,
  StreamingError,
  ErrorHandler,
  defaultErrorHandler
} from './utils/ErrorHandler.js';

export {
  Validator,
  messageSchema,
  chatRequestSchema,
  toolDefinitionSchema,
  providerConfigSchema,
  modelConfigSchema
} from './utils/Validator.js';

export { Logger, LogLevel, createLogger, defaultLogger } from './utils/Logger.js';

// Re-export common types and schemas
export * from './types/index.js';

/**
 * Create a new LLM client instance
 * @param {Object} config - Client configuration
 * @returns {LLMClient} Client instance
 */
export function createClient(config) {
  return new LLMClient(config);
}

/**
 * Create a simple client with basic configuration
 * @param {string} provider - Provider name
 * @param {string} apiKey - API key
 * @param {Object} options - Additional options
 * @returns {LLMClient} Client instance
 */
export function createSimpleClient(provider, apiKey, options = {}) {
  return new LLMClient({
    providers: {
      [provider]: {
        apiKey,
        ...options
      }
    },
    defaultProvider: provider
  });
}

// Version information
export const VERSION = '1.0.0';
export const SDK_NAME = 'llm-sdk';

// Default export
export default {
  LLMClient,
  Provider,
  Message,
  Response,
  createClient,
  createSimpleClient,
  VERSION,
  SDK_NAME
};
