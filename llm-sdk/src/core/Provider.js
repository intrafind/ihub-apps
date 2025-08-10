import { Validator } from '../utils/Validator.js';
import { ConfigurationError, ValidationError, LLMError } from '../utils/ErrorHandler.js';
import { defaultLogger } from '../utils/Logger.js';

/**
 * Abstract base class for LLM providers
 */
export class Provider {
  constructor(config = {}) {
    this.config = this.validateConfig(config);
    this.name = this.constructor.name.toLowerCase().replace('provider', '');
    this.logger = config.logger || defaultLogger.child(`Provider:${this.name}`);
    this._initialized = false;
    
    // Initialize the provider
    this.initialize();
  }

  /**
   * Initialize provider-specific setup
   * Override in subclasses if needed
   */
  initialize() {
    this._initialized = true;
  }

  /**
   * Check if provider is initialized
   * @returns {boolean} Whether provider is initialized
   */
  isInitialized() {
    return this._initialized;
  }

  // ============================================================================
  // REQUIRED METHODS - Must be implemented by subclasses
  // ============================================================================

  /**
   * Send chat completion request (non-streaming)
   * @param {Object} request - Chat request object
   * @returns {Promise<Response>} Response object
   * @throws {Error} Must be implemented by subclass
   */
  async chat(request) {
    throw new LLMError(
      `Method 'chat' not implemented by ${this.constructor.name}`,
      'NOT_IMPLEMENTED',
      this.name
    );
  }

  /**
   * Send streaming chat completion request
   * @param {Object} request - Chat request object
   * @returns {Promise<AsyncIterator<ResponseChunk>>} Async iterator of chunks
   * @throws {Error} Must be implemented by subclass
   */
  async stream(request) {
    throw new LLMError(
      `Method 'stream' not implemented by ${this.constructor.name}`,
      'NOT_IMPLEMENTED',
      this.name
    );
  }

  /**
   * Format messages for provider's API format
   * @param {Array<Message>} messages - Messages to format
   * @returns {Array<Object>} Formatted messages
   * @throws {Error} Must be implemented by subclass
   */
  formatMessages(messages) {
    throw new LLMError(
      `Method 'formatMessages' not implemented by ${this.constructor.name}`,
      'NOT_IMPLEMENTED',
      this.name
    );
  }

  /**
   * Parse provider response to standard format
   * @param {Object} response - Provider response
   * @returns {Response} Standardized response
   * @throws {Error} Must be implemented by subclass
   */
  parseResponse(response) {
    throw new LLMError(
      `Method 'parseResponse' not implemented by ${this.constructor.name}`,
      'NOT_IMPLEMENTED',
      this.name
    );
  }

  // ============================================================================
  // CAPABILITY METHODS - Override to indicate provider capabilities
  // ============================================================================

  /**
   * Check if provider supports tool calling
   * @returns {boolean} Whether provider supports tools
   */
  supportsTools() {
    return false;
  }

  /**
   * Check if provider supports image inputs
   * @returns {boolean} Whether provider supports images
   */
  supportsImages() {
    return false;
  }

  /**
   * Check if provider supports structured output
   * @returns {boolean} Whether provider supports structured output
   */
  supportsStructuredOutput() {
    return false;
  }

  /**
   * Check if provider supports streaming
   * @returns {boolean} Whether provider supports streaming
   */
  supportsStreaming() {
    return true;
  }

  /**
   * Check if provider supports system messages
   * @returns {boolean} Whether provider supports system messages
   */
  supportsSystemMessages() {
    return true;
  }

  /**
   * Get maximum context length for this provider
   * @param {string} model - Model name
   * @returns {number|null} Maximum context length or null if unlimited
   */
  getMaxContextLength(model) {
    return null; // Override in subclasses
  }

  /**
   * Get maximum output tokens for this provider
   * @param {string} model - Model name
   * @returns {number|null} Maximum output tokens or null if unlimited
   */
  getMaxOutputTokens(model) {
    return null; // Override in subclasses
  }

  // ============================================================================
  // TOOL METHODS - Implement if supportsTools() returns true
  // ============================================================================

  /**
   * Format tools for provider's API format
   * @param {Array<Object>} tools - Tool definitions
   * @returns {Array<Object>} Formatted tools
   */
  formatTools(tools) {
    return [];
  }

  /**
   * Parse tool calls from provider response
   * @param {Object} response - Provider response
   * @returns {Array<ToolCall>} Parsed tool calls
   */
  parseToolCalls(response) {
    return [];
  }

  /**
   * Format tool execution results for provider
   * @param {Array<ToolResult>} results - Tool execution results
   * @returns {Array<Object>} Formatted tool responses
   */
  formatToolResponses(results) {
    return [];
  }

  // ============================================================================
  // VALIDATION METHODS
  // ============================================================================

  /**
   * Validate provider configuration
   * Override in subclasses for provider-specific validation
   * @param {Object} config - Configuration to validate
   * @returns {Object} Validated configuration
   * @throws {ConfigurationError} If configuration is invalid
   */
  validateConfig(config) {
    if (!config.apiKey) {
      throw new ConfigurationError(
        'API key is required',
        'apiKey',
        this.name
      );
    }

    return {
      apiKey: config.apiKey,
      baseURL: config.baseURL,
      timeout: config.timeout || 30000,
      retries: config.retries || 3,
      defaultModel: config.defaultModel,
      maxTokens: config.maxTokens,
      temperature: config.temperature || 0.7,
      ...config
    };
  }

  /**
   * Validate chat request for this provider
   * @param {Object} request - Request to validate
   * @returns {Object} Validated request
   * @throws {ValidationError} If request is invalid
   */
  validateRequest(request) {
    // Basic validation using Zod schema
    const validatedRequest = Validator.validateChatRequest(request, this.name);

    // Provider-specific validation
    this.validateModel(validatedRequest.model);
    this.validateMessages(validatedRequest.messages);
    this.validateOptions(validatedRequest);

    return validatedRequest;
  }

  /**
   * Validate model name for this provider
   * @param {string} model - Model name to validate
   * @throws {ValidationError} If model is invalid
   */
  validateModel(model) {
    const sanitized = Validator.validateModelName(model, this.name);
    const availableModels = this.getAvailableModels();
    
    if (availableModels.length > 0 && !availableModels.includes(sanitized)) {
      throw new ValidationError(
        `Model '${sanitized}' is not available for provider '${this.name}'`,
        'model',
        model,
        this.name
      );
    }
    
    return sanitized;
  }

  /**
   * Validate messages for this provider
   * @param {Array<Message>} messages - Messages to validate
   * @throws {ValidationError} If messages are invalid
   */
  validateMessages(messages) {
    const validated = Validator.validateMessages(messages, this.name);

    // Check if provider supports images
    const hasImages = validated.some(msg => msg.hasImages && msg.hasImages());
    if (hasImages && !this.supportsImages()) {
      throw new ValidationError(
        `Provider '${this.name}' does not support image inputs`,
        'messages',
        'images',
        this.name
      );
    }

    // Check system message support
    const hasSystemMessages = validated.some(msg => msg.role === 'system');
    if (hasSystemMessages && !this.supportsSystemMessages()) {
      throw new ValidationError(
        `Provider '${this.name}' does not support system messages`,
        'messages',
        'system_messages',
        this.name
      );
    }

    return validated;
  }

  /**
   * Validate request options for this provider
   * @param {Object} options - Options to validate
   * @throws {ValidationError} If options are invalid
   */
  validateOptions(options) {
    // Temperature validation
    if (options.temperature !== undefined) {
      Validator.validateTemperature(options.temperature, this.name);
    }

    // Tools validation
    if (options.tools && !this.supportsTools()) {
      throw new ValidationError(
        `Provider '${this.name}' does not support tool calling`,
        'tools',
        options.tools,
        this.name
      );
    }

    // Structured output validation
    if (options.responseFormat && !this.supportsStructuredOutput()) {
      throw new ValidationError(
        `Provider '${this.name}' does not support structured output`,
        'responseFormat',
        options.responseFormat,
        this.name
      );
    }

    // Streaming validation
    if (options.stream && !this.supportsStreaming()) {
      throw new ValidationError(
        `Provider '${this.name}' does not support streaming`,
        'stream',
        options.stream,
        this.name
      );
    }

    return options;
  }

  // ============================================================================
  // MODEL INFORMATION METHODS
  // ============================================================================

  /**
   * Get list of available models for this provider
   * Override in subclasses
   * @returns {Array<string>} List of model names
   */
  getAvailableModels() {
    return [];
  }

  /**
   * Get detailed information about a model
   * Override in subclasses
   * @param {string} modelName - Model name
   * @returns {Object|null} Model information or null if not found
   */
  getModelInfo(modelName) {
    return null;
  }

  /**
   * Get default model for this provider
   * @returns {string|null} Default model name
   */
  getDefaultModel() {
    return this.config.defaultModel || null;
  }

  // ============================================================================
  // UTILITY METHODS
  // ============================================================================

  /**
   * Create HTTP headers for API requests
   * @param {Object} additionalHeaders - Additional headers to include
   * @returns {Object} Headers object
   */
  createHeaders(additionalHeaders = {}) {
    return {
      'Content-Type': 'application/json',
      'User-Agent': 'llm-sdk/1.0.0',
      Authorization: `Bearer ${this.config.apiKey}`,
      ...additionalHeaders
    };
  }

  /**
   * Handle HTTP response errors
   * @param {Response} response - HTTP response
   * @param {string} responseText - Response text
   * @throws {Error} Appropriate error based on status code
   */
  async handleHttpError(response, responseText) {
    const { status, statusText } = response;
    
    switch (status) {
      case 400:
        throw new ValidationError(
          `Bad request: ${responseText || statusText}`,
          'request',
          null,
          this.name
        );
      case 401:
        throw new ConfigurationError(
          'Invalid API key or authentication failed',
          'apiKey',
          this.name
        );
      case 429:
        const retryAfter = response.headers.get('retry-after');
        throw new LLMError(
          'Rate limit exceeded',
          'RATE_LIMIT_ERROR',
          this.name,
          { retryAfter: retryAfter ? parseInt(retryAfter) : null }
        );
      case 500:
      case 502:
      case 503:
      case 504:
        throw new LLMError(
          `Provider server error: ${statusText}`,
          'PROVIDER_ERROR',
          this.name,
          { statusCode: status }
        );
      default:
        throw new LLMError(
          `HTTP ${status}: ${statusText}`,
          'PROVIDER_ERROR',
          this.name,
          { statusCode: status }
        );
    }
  }

  /**
   * Make HTTP request with error handling and retries
   * @param {string} url - Request URL
   * @param {Object} options - Request options
   * @returns {Promise<Response>} HTTP response
   */
  async makeRequest(url, options = {}) {
    const { retries = this.config.retries } = options;
    let lastError;

    for (let attempt = 0; attempt <= retries; attempt++) {
      try {
        const timer = this.logger.timer(`HTTP Request to ${url}`);
        
        const response = await fetch(url, {
          timeout: this.config.timeout,
          ...options,
          headers: this.createHeaders(options.headers)
        });

        timer({ status: response.status, attempt: attempt + 1 });

        if (!response.ok) {
          const responseText = await response.text();
          await this.handleHttpError(response, responseText);
        }

        return response;
      } catch (error) {
        lastError = error;
        
        if (attempt < retries && this.shouldRetry(error)) {
          const delay = this.calculateRetryDelay(attempt);
          this.logger.warn(`Request failed, retrying in ${delay}ms`, {
            attempt: attempt + 1,
            error: error.message,
            url
          });
          await new Promise(resolve => setTimeout(resolve, delay));
        } else {
          break;
        }
      }
    }

    throw lastError;
  }

  /**
   * Check if error should trigger a retry
   * @param {Error} error - Error to check
   * @returns {boolean} Whether to retry
   */
  shouldRetry(error) {
    // Retry on network errors and 5xx server errors
    return error.code === 'NETWORK_ERROR' || 
           (error.statusCode && error.statusCode >= 500);
  }

  /**
   * Calculate delay for retry attempt
   * @param {number} attempt - Attempt number (0-based)
   * @returns {number} Delay in milliseconds
   */
  calculateRetryDelay(attempt) {
    // Exponential backoff with jitter
    const baseDelay = Math.pow(2, attempt) * 1000;
    const jitter = Math.random() * 1000;
    return Math.min(baseDelay + jitter, 30000); // Max 30 seconds
  }

  /**
   * Extract text content from message
   * @param {Message|Object} message - Message object
   * @returns {string} Text content
   */
  extractTextContent(message) {
    if (typeof message.content === 'string') {
      return message.content;
    }
    if (Array.isArray(message.content)) {
      return message.content
        .filter(part => part.type === 'text')
        .map(part => part.text || part.data?.text)
        .join(' ');
    }
    return '';
  }

  /**
   * Check if message has image content
   * @param {Message|Object} message - Message object
   * @returns {boolean} Whether message has images
   */
  hasImageContent(message) {
    if (Array.isArray(message.content)) {
      return message.content.some(part => part.type === 'image');
    }
    return false;
  }

  /**
   * Get provider-specific information
   * @returns {Object} Provider information
   */
  getInfo() {
    return {
      name: this.name,
      capabilities: {
        tools: this.supportsTools(),
        images: this.supportsImages(),
        structuredOutput: this.supportsStructuredOutput(),
        streaming: this.supportsStreaming(),
        systemMessages: this.supportsSystemMessages()
      },
      models: this.getAvailableModels(),
      defaultModel: this.getDefaultModel()
    };
  }

  /**
   * Convert provider to JSON representation
   * @returns {Object} JSON representation
   */
  toJSON() {
    return {
      name: this.name,
      config: {
        ...this.config,
        apiKey: this.config.apiKey ? '[REDACTED]' : null
      },
      info: this.getInfo()
    };
  }
}