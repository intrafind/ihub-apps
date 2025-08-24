/**
 * SDK Bridge Adapter
 *
 * This adapter integrates the LLM SDK with the existing server infrastructure.
 * It acts as a bridge between the server's legacy adapter interface and the new SDK.
 */

import { LegacyAdapter } from '../../llm-sdk/src/adapters/LegacyAdapter.js';
import configCache from '../configCache.js';

// Global SDK adapter instance
let sdkAdapter = null;

/**
 * Initialize the SDK adapter with current model configurations
 */
async function initializeSDKAdapter() {
  if (sdkAdapter) {
    return sdkAdapter;
  }

  try {
    // Wait for config cache to be initialized
    await configCache.initialize();

    // Load model configurations from the server
    const modelsResult = configCache.getModels(true); // include disabled models
    const modelsConfig = {};

    // Convert models array to object keyed by model ID
    if (modelsResult && modelsResult.data) {
      for (const model of modelsResult.data) {
        modelsConfig[model.id] = model;
      }
    }

    // Convert server model configs to SDK provider configs
    const providerConfigs = convertModelsToProviderConfigs(modelsConfig);

    // Create SDK adapter
    sdkAdapter = new LegacyAdapter({
      providers: providerConfigs,
      defaultProvider: 'openai',
      logger: console // Use console for now, could be enhanced
    });

    // Wait for SDK to be ready
    await sdkAdapter.client.ready();

    console.log('✅ SDK Bridge Adapter initialized with providers:', Object.keys(providerConfigs));
    return sdkAdapter;
  } catch (error) {
    console.error('❌ Failed to initialize SDK adapter:', error);
    throw error;
  }
}

/**
 * Convert server model configurations to SDK provider configurations
 * @param {Object} modelsConfig - Server models configuration
 * @returns {Object} SDK provider configurations
 */
function convertModelsToProviderConfigs(modelsConfig) {
  const providerConfigs = {};
  const apiKeys = {
    openai: process.env.OPENAI_API_KEY,
    anthropic: process.env.ANTHROPIC_API_KEY,
    google: process.env.GOOGLE_AI_API_KEY,
    mistral: process.env.MISTRAL_API_KEY,
    vllm: process.env.VLLM_API_KEY || 'no-key-required'
  };

  // Group models by provider
  for (const [modelId, modelConfig] of Object.entries(modelsConfig)) {
    const provider = modelConfig.provider;

    if (!providerConfigs[provider]) {
      providerConfigs[provider] = {
        apiKey: apiKeys[provider],
        models: []
      };

      // Add provider-specific configuration
      if (provider === 'vllm' && modelConfig.url) {
        providerConfigs[provider].baseURL = modelConfig.url;
      } else if (provider === 'google' && process.env.GOOGLE_AI_API_KEY) {
        providerConfigs[provider].apiKey = process.env.GOOGLE_AI_API_KEY;
      }
    }

    providerConfigs[provider].models.push({
      id: modelId,
      modelId: modelConfig.modelId || modelId,
      ...modelConfig
    });
  }

  // Ensure we have at least OpenAI configured as fallback
  if (!providerConfigs.openai && apiKeys.openai) {
    providerConfigs.openai = {
      apiKey: apiKeys.openai,
      models: [
        {
          id: 'gpt-3.5-turbo',
          modelId: 'gpt-3.5-turbo'
        }
      ]
    };
  }

  return providerConfigs;
}

/**
 * SDK-powered adapter that implements the legacy interface
 */
class SDKBridgeAdapter {
  constructor() {
    this.initPromise = initializeSDKAdapter();
  }

  /**
   * Ensure SDK is ready
   */
  async ensureReady() {
    if (!sdkAdapter) {
      await this.initPromise;
    }
    return sdkAdapter;
  }

  /**
   * Create completion request using SDK
   * @param {Object} model - Model configuration
   * @param {Array} messages - Messages array
   * @param {string} apiKey - API key (will be ignored, using env vars)
   * @param {Object} options - Request options
   * @returns {Object} Request configuration
   */
  async createCompletionRequest(model, messages, apiKey, options = {}) {
    const adapter = await this.ensureReady();
    return await adapter.createCompletionRequest(model, messages, apiKey, options);
  }

  /**
   * Process response buffer using SDK
   * @param {string} buffer - Response buffer
   * @returns {Object} Processed response
   */
  async processResponseBuffer(buffer) {
    const adapter = await this.ensureReady();
    // We need to determine the provider from context - for now use generic processing
    // In a full migration, this would be handled differently
    return adapter.processResponseBuffer('openai', buffer);
  }

  /**
   * Format messages using SDK
   * @param {Array} messages - Messages to format
   * @returns {Array} Formatted messages
   */
  async formatMessages(messages) {
    const adapter = await this.ensureReady();
    // Default to openai provider for message formatting
    return await adapter.formatMessages('openai', messages);
  }

  /**
   * Get SDK client for advanced operations
   * @returns {LLMClient} SDK client
   */
  async getSDKClient() {
    const adapter = await this.ensureReady();
    return adapter.getSDKClient();
  }
}

// Create singleton instance
const sdkBridgeAdapter = new SDKBridgeAdapter();

// Export SDK bridge functions that match the legacy adapter interface
export async function createCompletionRequest(model, messages, apiKey, options = {}) {
  return await sdkBridgeAdapter.createCompletionRequest(model, messages, apiKey, options);
}

export async function processResponseBuffer(provider, buffer) {
  const adapter = await sdkBridgeAdapter.ensureReady();
  return adapter.processResponseBuffer(provider, buffer);
}

export async function formatMessages(provider, messages) {
  const adapter = await sdkBridgeAdapter.ensureReady();
  return await adapter.formatMessages(provider, messages);
}

// Export the bridge adapter class
export { SDKBridgeAdapter };

// Export function to get SDK client
export async function getSDKClient() {
  return await sdkBridgeAdapter.getSDKClient();
}
