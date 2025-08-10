import { Provider } from './Provider.js';
import { Validator } from '../utils/Validator.js';
import { ConfigurationError, ValidationError, LLMError } from '../utils/ErrorHandler.js';
import { defaultLogger } from '../utils/Logger.js';
import { Message } from './Message.js';

/**
 * Main LLM SDK client class
 */
export class LLMClient {
  constructor(config = {}) {
    this.config = this.validateConfig(config);
    this.providers = new Map();
    this.defaultProvider = config.defaultProvider || 'openai';
    this.logger = config.logger || defaultLogger.child('LLMClient');
    
    // Initialize providers
    this.initializeProviders(config.providers || {});
    
    // Create provider proxy getters
    this.createProviderProxies();
  }

  /**
   * Validate client configuration
   * @param {Object} config - Configuration to validate
   * @returns {Object} Validated configuration
   * @throws {ConfigurationError} If configuration is invalid
   */
  validateConfig(config) {
    if (!config.providers || Object.keys(config.providers).length === 0) {
      throw new ConfigurationError(
        'At least one provider must be configured',
        'providers'
      );
    }

    return {
      providers: config.providers,
      defaultProvider: config.defaultProvider || 'openai',
      timeout: config.timeout || 30000,
      retries: config.retries || 3,
      logger: config.logger,
      ...config
    };
  }

  /**
   * Initialize provider instances
   * @param {Object} providersConfig - Providers configuration
   */
  initializeProviders(providersConfig) {
    for (const [providerName, providerConfig] of Object.entries(providersConfig)) {
      try {
        const ProviderClass = this.getProviderClass(providerName);
        const provider = new ProviderClass({
          ...providerConfig,
          logger: this.logger.child(`Provider:${providerName}`)
        });
        
        this.providers.set(providerName, provider);
        this.logger.info(`Initialized provider: ${providerName}`);
      } catch (error) {
        this.logger.error(`Failed to initialize provider ${providerName}:`, error);
        throw new ConfigurationError(
          `Failed to initialize provider '${providerName}': ${error.message}`,
          'providers',
          null,
          error
        );
      }
    }

    // Validate default provider exists
    if (!this.providers.has(this.defaultProvider)) {
      throw new ConfigurationError(
        `Default provider '${this.defaultProvider}' is not configured`,
        'defaultProvider'
      );
    }
  }

  /**
   * Get provider class by name
   * @param {string} providerName - Provider name
   * @returns {Class} Provider class constructor
   * @throws {ConfigurationError} If provider not found
   */
  getProviderClass(providerName) {
    // Dynamic imports would be used here in real implementation
    // For now, we'll throw an error indicating this needs to be implemented
    throw new ConfigurationError(
      `Provider '${providerName}' not found. Provider classes need to be imported.`,
      'provider',
      providerName
    );
  }

  /**
   * Create proxy getters for direct provider access
   */
  createProviderProxies() {
    for (const [providerName, provider] of this.providers) {
      Object.defineProperty(this, providerName, {
        get() {
          return provider;
        },
        enumerable: true,
        configurable: false
      });
    }
  }

  /**
   * Get provider instance
   * @param {string} providerName - Provider name
   * @returns {Provider} Provider instance
   * @throws {ConfigurationError} If provider not found
   */
  getProvider(providerName) {
    const provider = this.providers.get(providerName);
    if (!provider) {
      throw new ConfigurationError(
        `Provider '${providerName}' not found`,
        'provider',
        providerName
      );
    }
    return provider;
  }

  /**
   * Send chat completion request (unified interface)
   * @param {Object} request - Chat request
   * @returns {Promise<Response>} Chat response
   */
  async chat(request) {
    const timer = this.logger.timer('chat');
    
    try {
      // Validate request
      const validatedRequest = Validator.validateChatRequest(request);
      
      // Determine provider
      const providerName = request.provider || this.defaultProvider;
      const provider = this.getProvider(providerName);
      
      // Validate request for specific provider
      const providerRequest = provider.validateRequest(validatedRequest);
      
      this.logger.debug('Sending chat request', {
        provider: providerName,
        model: providerRequest.model,
        messageCount: providerRequest.messages.length,
        hasTools: !!(providerRequest.tools && providerRequest.tools.length > 0),
        stream: providerRequest.stream
      });
      
      // Send request
      const response = await provider.chat(providerRequest);
      
      this.logger.debug('Received chat response', {
        provider: providerName,
        responseId: response.id,
        choices: response.choices.length,
        usage: response.usage.toJSON()
      });
      
      timer({ 
        provider: providerName,
        success: true,
        tokens: response.usage.totalTokens
      });
      
      return response;
    } catch (error) {
      timer({ 
        provider: request.provider || this.defaultProvider,
        success: false,
        error: error.message
      });
      
      this.logger.error('Chat request failed', { error: error.message });
      throw error;
    }
  }

  /**
   * Send streaming chat completion request (unified interface)
   * @param {Object} request - Chat request
   * @returns {Promise<AsyncIterator<ResponseChunk>>} Streaming response
   */
  async stream(request) {
    const timer = this.logger.timer('stream');
    
    try {
      // Validate request
      const validatedRequest = Validator.validateChatRequest({
        ...request,
        stream: true
      });
      
      // Determine provider
      const providerName = request.provider || this.defaultProvider;
      const provider = this.getProvider(providerName);
      
      // Check streaming support
      if (!provider.supportsStreaming()) {
        throw new ValidationError(
          `Provider '${providerName}' does not support streaming`,
          'stream',
          true,
          providerName
        );
      }
      
      // Validate request for specific provider
      const providerRequest = provider.validateRequest(validatedRequest);
      
      this.logger.debug('Starting streaming chat request', {
        provider: providerName,
        model: providerRequest.model,
        messageCount: providerRequest.messages.length
      });
      
      // Start streaming
      const stream = await provider.stream(providerRequest);
      
      timer({ 
        provider: providerName,
        success: true,
        streaming: true
      });
      
      return this.wrapStream(stream, providerName);
    } catch (error) {
      timer({ 
        provider: request.provider || this.defaultProvider,
        success: false,
        error: error.message
      });
      
      this.logger.error('Streaming request failed', { error: error.message });
      throw error;
    }
  }

  /**
   * Wrap provider stream with logging and error handling
   * @param {AsyncIterator<ResponseChunk>} stream - Provider stream
   * @param {string} providerName - Provider name
   * @returns {AsyncIterator<ResponseChunk>} Wrapped stream
   */
  async* wrapStream(stream, providerName) {
    let chunkCount = 0;
    let totalTokens = 0;
    
    try {
      for await (const chunk of stream) {
        chunkCount++;
        if (chunk.usage) {
          totalTokens = chunk.usage.totalTokens || totalTokens;
        }
        
        this.logger.debug(`Stream chunk ${chunkCount}`, {
          provider: providerName,
          hasContent: chunk.hasContent(),
          isFinal: chunk.isFinal()
        });
        
        yield chunk;
      }
      
      this.logger.debug('Stream completed', {
        provider: providerName,
        chunks: chunkCount,
        totalTokens
      });
    } catch (error) {
      this.logger.error('Stream error', {
        provider: providerName,
        chunks: chunkCount,
        error: error.message
      });
      throw error;
    }
  }

  /**
   * Get available models from all providers
   * @param {string} providerName - Optional provider filter
   * @returns {Array<Object>} Available models with provider info
   */
  getAvailableModels(providerName = null) {
    const models = [];
    const providersToCheck = providerName ? 
      [this.getProvider(providerName)] : 
      Array.from(this.providers.values());
    
    for (const provider of providersToCheck) {
      const providerModels = provider.getAvailableModels();
      for (const model of providerModels) {
        models.push({
          id: model,
          name: model,
          provider: provider.name,
          capabilities: {
            tools: provider.supportsTools(),
            images: provider.supportsImages(),
            structuredOutput: provider.supportsStructuredOutput(),
            streaming: provider.supportsStreaming()
          }
        });
      }
    }
    
    return models;
  }

  /**
   * Get detailed model information
   * @param {string} modelName - Model name
   * @param {string} providerName - Provider name (optional)
   * @returns {Object|null} Model information
   */
  getModelInfo(modelName, providerName = null) {
    if (providerName) {
      const provider = this.getProvider(providerName);
      return provider.getModelInfo(modelName);
    }
    
    // Search across all providers
    for (const provider of this.providers.values()) {
      const modelInfo = provider.getModelInfo(modelName);
      if (modelInfo) {
        return {
          ...modelInfo,
          provider: provider.name
        };
      }
    }
    
    return null;
  }

  /**
   * Get list of configured providers
   * @returns {Array<string>} Provider names
   */
  getProviders() {
    return Array.from(this.providers.keys());
  }

  /**
   * Get provider information
   * @param {string} providerName - Provider name (optional)
   * @returns {Object|Array<Object>} Provider info
   */
  getProviderInfo(providerName = null) {
    if (providerName) {
      const provider = this.getProvider(providerName);
      return provider.getInfo();
    }
    
    const info = {};
    for (const [name, provider] of this.providers) {
      info[name] = provider.getInfo();
    }
    return info;
  }

  /**
   * Check if a provider is available
   * @param {string} providerName - Provider name
   * @returns {boolean} Whether provider is available
   */
  hasProvider(providerName) {
    return this.providers.has(providerName);
  }

  /**
   * Add or update a provider
   * @param {string} providerName - Provider name
   * @param {Object} config - Provider configuration
   * @throws {ConfigurationError} If provider initialization fails
   */
  addProvider(providerName, config) {
    try {
      const ProviderClass = this.getProviderClass(providerName);
      const provider = new ProviderClass({
        ...config,
        logger: this.logger.child(`Provider:${providerName}`)
      });
      
      this.providers.set(providerName, provider);
      
      // Add proxy getter
      Object.defineProperty(this, providerName, {
        get() {
          return provider;
        },
        enumerable: true,
        configurable: true
      });
      
      this.logger.info(`Added provider: ${providerName}`);
    } catch (error) {
      throw new ConfigurationError(
        `Failed to add provider '${providerName}': ${error.message}`,
        'provider',
        providerName,
        error
      );
    }
  }

  /**
   * Remove a provider
   * @param {string} providerName - Provider name
   * @throws {ConfigurationError} If provider is default or not found
   */
  removeProvider(providerName) {
    if (providerName === this.defaultProvider) {
      throw new ConfigurationError(
        'Cannot remove default provider',
        'provider',
        providerName
      );
    }
    
    if (!this.providers.has(providerName)) {
      throw new ConfigurationError(
        `Provider '${providerName}' not found`,
        'provider',
        providerName
      );
    }
    
    this.providers.delete(providerName);
    delete this[providerName];
    this.logger.info(`Removed provider: ${providerName}`);
  }

  /**
   * Set default provider
   * @param {string} providerName - Provider name
   * @throws {ConfigurationError} If provider not found
   */
  setDefaultProvider(providerName) {
    if (!this.providers.has(providerName)) {
      throw new ConfigurationError(
        `Provider '${providerName}' not found`,
        'provider',
        providerName
      );
    }
    
    this.defaultProvider = providerName;
    this.logger.info(`Set default provider: ${providerName}`);
  }

  /**
   * Test connection to a provider
   * @param {string} providerName - Provider name (optional)
   * @returns {Promise<Object>} Test result
   */
  async testProvider(providerName = null) {
    const provider = providerName ? 
      this.getProvider(providerName) : 
      this.getProvider(this.defaultProvider);
    
    const testMessages = [Message.user('Hello, this is a test message.')];
    
    try {
      const startTime = Date.now();
      const response = await provider.chat({
        model: provider.getDefaultModel() || 'test',
        messages: testMessages,
        maxTokens: 10,
        temperature: 0
      });
      const duration = Date.now() - startTime;
      
      return {
        provider: provider.name,
        success: true,
        duration,
        response: {
          id: response.id,
          content: response.content.substring(0, 100),
          usage: response.usage.toJSON()
        }
      };
    } catch (error) {
      return {
        provider: provider.name,
        success: false,
        error: {
          message: error.message,
          code: error.code,
          type: error.constructor.name
        }
      };
    }
  }

  /**
   * Get SDK information
   * @returns {Object} SDK information
   */
  getInfo() {
    return {
      sdk: 'llm-sdk',
      version: '1.0.0',
      providers: this.getProviders(),
      defaultProvider: this.defaultProvider,
      models: this.getAvailableModels()
    };
  }

  /**
   * Convert client to JSON representation
   * @returns {Object} JSON representation
   */
  toJSON() {
    return {
      info: this.getInfo(),
      providers: this.getProviderInfo(),
      config: {
        defaultProvider: this.defaultProvider,
        timeout: this.config.timeout,
        retries: this.config.retries
      }
    };
  }

  /**
   * Close client and cleanup resources
   */
  async close() {
    this.logger.info('Closing LLM client');
    
    // Clean up providers if they have cleanup methods
    for (const provider of this.providers.values()) {
      if (typeof provider.close === 'function') {
        await provider.close();
      }
    }
    
    this.providers.clear();
  }
}