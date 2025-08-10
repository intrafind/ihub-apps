/**
 * Type definitions and interfaces for LLM SDK
 * 
 * This file provides JavaScript implementations of types that would
 * typically be defined in TypeScript definition files.
 */

/**
 * Common content types for messages
 */
export const ContentTypes = {
  TEXT: 'text',
  IMAGE: 'image',
  TOOL_CALL: 'tool_call',
  TOOL_RESULT: 'tool_result'
};

/**
 * Message roles
 */
export const MessageRoles = {
  SYSTEM: 'system',
  USER: 'user',
  ASSISTANT: 'assistant',
  TOOL: 'tool'
};

/**
 * Finish reasons for responses
 */
export const FinishReasons = {
  STOP: 'stop',
  LENGTH: 'length',
  TOOL_CALLS: 'tool_calls',
  CONTENT_FILTER: 'content_filter'
};

/**
 * Provider capabilities
 */
export const ProviderCapabilities = {
  TOOLS: 'tools',
  IMAGES: 'images',
  STRUCTURED_OUTPUT: 'structuredOutput',
  STREAMING: 'streaming',
  SYSTEM_MESSAGES: 'systemMessages'
};

/**
 * Tool choice options
 */
export const ToolChoiceTypes = {
  AUTO: 'auto',
  NONE: 'none',
  REQUIRED: 'required',
  FUNCTION: 'function'
};

/**
 * Response format types
 */
export const ResponseFormatTypes = {
  TEXT: 'text',
  JSON_OBJECT: 'json_object',
  JSON_SCHEMA: 'json_schema'
};

/**
 * Error codes used throughout the SDK
 */
export const ErrorCodes = {
  CONFIGURATION_ERROR: 'CONFIGURATION_ERROR',
  VALIDATION_ERROR: 'VALIDATION_ERROR',
  PROVIDER_ERROR: 'PROVIDER_ERROR',
  NETWORK_ERROR: 'NETWORK_ERROR',
  RATE_LIMIT_ERROR: 'RATE_LIMIT_ERROR',
  TOOL_EXECUTION_ERROR: 'TOOL_EXECUTION_ERROR',
  STREAMING_ERROR: 'STREAMING_ERROR',
  NOT_IMPLEMENTED: 'NOT_IMPLEMENTED',
  UNKNOWN_ERROR: 'UNKNOWN_ERROR'
};

/**
 * Default configuration values
 */
export const Defaults = {
  TEMPERATURE: 0.7,
  MAX_TOKENS: 4096,
  TIMEOUT: 30000,
  RETRIES: 3,
  STREAM: false,
  TOP_P: 1.0,
  PRESENCE_PENALTY: 0,
  FREQUENCY_PENALTY: 0
};

/**
 * Well-known model identifiers
 */
export const WellKnownModels = {
  // OpenAI
  GPT_4: 'gpt-4',
  GPT_4_TURBO: 'gpt-4-turbo',
  GPT_4_VISION: 'gpt-4-vision-preview',
  GPT_3_5_TURBO: 'gpt-3.5-turbo',
  
  // Anthropic
  CLAUDE_3_5_SONNET: 'claude-3-5-sonnet-20241022',
  CLAUDE_3_HAIKU: 'claude-3-haiku-20240307',
  CLAUDE_3_OPUS: 'claude-3-opus-20240229',
  
  // Google
  GEMINI_PRO: 'gemini-pro',
  GEMINI_PRO_VISION: 'gemini-pro-vision',
  GEMINI_1_5_PRO: 'gemini-1.5-pro',
  
  // Mistral
  MISTRAL_LARGE: 'mistral-large',
  MISTRAL_MEDIUM: 'mistral-medium',
  MISTRAL_SMALL: 'mistral-small'
};

/**
 * Utility functions for type checking
 */
export const TypeGuards = {
  /**
   * Check if value is a valid message role
   * @param {string} role - Role to check
   * @returns {boolean} Whether role is valid
   */
  isValidRole(role) {
    return Object.values(MessageRoles).includes(role);
  },

  /**
   * Check if value is a valid content type
   * @param {string} type - Content type to check
   * @returns {boolean} Whether type is valid
   */
  isValidContentType(type) {
    return Object.values(ContentTypes).includes(type);
  },

  /**
   * Check if value is a valid finish reason
   * @param {string} reason - Finish reason to check
   * @returns {boolean} Whether reason is valid
   */
  isValidFinishReason(reason) {
    return Object.values(FinishReasons).includes(reason);
  },

  /**
   * Check if object looks like a message
   * @param {*} obj - Object to check
   * @returns {boolean} Whether object looks like a message
   */
  isMessage(obj) {
    return obj &&
           typeof obj === 'object' &&
           typeof obj.role === 'string' &&
           this.isValidRole(obj.role) &&
           (typeof obj.content === 'string' || Array.isArray(obj.content));
  },

  /**
   * Check if object looks like a tool call
   * @param {*} obj - Object to check
   * @returns {boolean} Whether object looks like a tool call
   */
  isToolCall(obj) {
    return obj &&
           typeof obj === 'object' &&
           typeof obj.id === 'string' &&
           typeof obj.name === 'string' &&
           typeof obj.arguments === 'object';
  },

  /**
   * Check if object looks like a response
   * @param {*} obj - Object to check
   * @returns {boolean} Whether object looks like a response
   */
  isResponse(obj) {
    return obj &&
           typeof obj === 'object' &&
           typeof obj.id === 'string' &&
           Array.isArray(obj.choices) &&
           typeof obj.usage === 'object';
  },

  /**
   * Check if object looks like a response chunk
   * @param {*} obj - Object to check
   * @returns {boolean} Whether object looks like a response chunk
   */
  isResponseChunk(obj) {
    return obj &&
           typeof obj === 'object' &&
           Array.isArray(obj.choices) &&
           typeof obj.done === 'boolean';
  }
};

/**
 * Model information structure
 */
export const ModelInfo = {
  /**
   * Create model info object
   * @param {Object} params - Model parameters
   * @returns {Object} Model info object
   */
  create({
    id,
    name,
    provider,
    capabilities = {},
    limits = {},
    pricing = {}
  }) {
    return {
      id,
      name,
      provider,
      capabilities: {
        tools: false,
        images: false,
        structuredOutput: false,
        streaming: true,
        systemMessages: true,
        ...capabilities
      },
      limits: {
        maxTokens: null,
        contextLength: null,
        ...limits
      },
      pricing: {
        input: null,
        output: null,
        ...pricing
      }
    };
  }
};

/**
 * Request builder helpers
 */
export const RequestHelpers = {
  /**
   * Create basic chat request
   * @param {Object} params - Request parameters
   * @returns {Object} Chat request object
   */
  createChatRequest({
    model,
    messages,
    provider = null,
    temperature = Defaults.TEMPERATURE,
    maxTokens = Defaults.MAX_TOKENS,
    stream = Defaults.STREAM,
    tools = null,
    toolChoice = null,
    responseFormat = null,
    ...options
  }) {
    const request = {
      model,
      messages,
      temperature,
      maxTokens,
      stream,
      ...options
    };

    if (provider) request.provider = provider;
    if (tools) request.tools = tools;
    if (toolChoice) request.toolChoice = toolChoice;
    if (responseFormat) request.responseFormat = responseFormat;

    return request;
  },

  /**
   * Create streaming request
   * @param {Object} params - Request parameters
   * @returns {Object} Streaming chat request
   */
  createStreamingRequest(params) {
    return this.createChatRequest({
      ...params,
      stream: true
    });
  },

  /**
   * Create tool calling request
   * @param {Object} params - Request parameters
   * @returns {Object} Tool calling chat request
   */
  createToolRequest({ tools, toolChoice = 'auto', ...params }) {
    return this.createChatRequest({
      ...params,
      tools,
      toolChoice
    });
  }
};