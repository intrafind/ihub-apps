/**
 * OpenTelemetry Gen-AI Semantic Convention Attributes
 * Implements https://opentelemetry.io/docs/specs/semconv/gen-ai/
 */

// Provider name mappings to semantic convention values
const PROVIDER_MAP = {
  openai: 'openai',
  anthropic: 'anthropic',
  google: 'gcp.gemini',
  mistral: 'mistral_ai',
  vllm: 'openai' // vLLM uses OpenAI-compatible API
};

// Operation name mappings
const OPERATION_MAP = {
  chat: 'chat',
  completion: 'text_completion',
  generate_content: 'generate_content',
  embeddings: 'embeddings'
};

/**
 * Build provider-specific attributes
 * @param {string} provider - Provider identifier (openai, anthropic, google, mistral)
 * @returns {Object} Provider attributes
 */
export function buildProviderAttributes(provider) {
  const normalizedProvider = provider?.toLowerCase() || 'unknown';
  return {
    'gen_ai.provider.name': PROVIDER_MAP[normalizedProvider] || normalizedProvider
  };
}

/**
 * Build operation attributes
 * @param {string} operation - Operation type (chat, completion, etc.)
 * @returns {Object} Operation attributes
 */
export function buildOperationAttributes(operation) {
  const normalizedOp = operation?.toLowerCase() || 'chat';
  return {
    'gen_ai.operation.name': OPERATION_MAP[normalizedOp] || normalizedOp
  };
}

/**
 * Build request attributes from model and options
 * @param {Object} model - Model configuration
 * @param {Object} options - Request options
 * @returns {Object} Request attributes
 */
export function buildRequestAttributes(model, options = {}) {
  const attributes = {};

  // Required and conditionally required attributes
  if (model?.modelId) {
    attributes['gen_ai.request.model'] = model.modelId;
  }

  // Recommended attributes
  if (options.temperature !== undefined) {
    attributes['gen_ai.request.temperature'] = parseFloat(options.temperature);
  }

  if (options.maxTokens !== undefined) {
    attributes['gen_ai.request.max_tokens'] = parseInt(options.maxTokens, 10);
  }

  if (options.topP !== undefined) {
    attributes['gen_ai.request.top_p'] = parseFloat(options.topP);
  }

  if (options.topK !== undefined) {
    attributes['gen_ai.request.top_k'] = parseFloat(options.topK);
  }

  if (options.frequencyPenalty !== undefined) {
    attributes['gen_ai.request.frequency_penalty'] = parseFloat(options.frequencyPenalty);
  }

  if (options.presencePenalty !== undefined) {
    attributes['gen_ai.request.presence_penalty'] = parseFloat(options.presencePenalty);
  }

  if (options.stopSequences && Array.isArray(options.stopSequences)) {
    attributes['gen_ai.request.stop_sequences'] = options.stopSequences;
  }

  if (options.seed !== undefined) {
    attributes['gen_ai.request.seed'] = parseInt(options.seed, 10);
  }

  if (options.choiceCount !== undefined && options.choiceCount !== 1) {
    attributes['gen_ai.request.choice.count'] = parseInt(options.choiceCount, 10);
  }

  // Output type
  if (options.responseFormat) {
    const formatMap = {
      json: 'json',
      text: 'text',
      markdown: 'text'
    };
    attributes['gen_ai.output.type'] = formatMap[options.responseFormat] || 'text';
  }

  return attributes;
}

/**
 * Build response attributes from API response
 * @param {Object} response - API response object
 * @returns {Object} Response attributes
 */
export function buildResponseAttributes(response = {}) {
  const attributes = {};

  // Response ID
  if (response.id) {
    attributes['gen_ai.response.id'] = response.id;
  }

  // Response model (actual model used)
  if (response.model) {
    attributes['gen_ai.response.model'] = response.model;
  }

  // Finish reasons
  if (response.finishReasons && Array.isArray(response.finishReasons)) {
    attributes['gen_ai.response.finish_reasons'] = response.finishReasons;
  } else if (response.finishReason) {
    attributes['gen_ai.response.finish_reasons'] = [response.finishReason];
  }

  return attributes;
}

/**
 * Build usage/token attributes from API response
 * @param {Object} usage - Usage object from API response
 * @returns {Object} Usage attributes
 */
export function buildUsageAttributes(usage = {}) {
  const attributes = {};

  if (usage.inputTokens !== undefined) {
    attributes['gen_ai.usage.input_tokens'] = parseInt(usage.inputTokens, 10);
  } else if (usage.prompt_tokens !== undefined) {
    attributes['gen_ai.usage.input_tokens'] = parseInt(usage.prompt_tokens, 10);
  }

  if (usage.outputTokens !== undefined) {
    attributes['gen_ai.usage.output_tokens'] = parseInt(usage.outputTokens, 10);
  } else if (usage.completion_tokens !== undefined) {
    attributes['gen_ai.usage.output_tokens'] = parseInt(usage.completion_tokens, 10);
  }

  return attributes;
}

/**
 * Build server attributes from model configuration
 * @param {Object} model - Model configuration
 * @returns {Object} Server attributes
 */
export function buildServerAttributes(model = {}) {
  const attributes = {};

  if (model.url) {
    try {
      const url = new URL(model.url);
      attributes['server.address'] = url.hostname;
      if (url.port) {
        attributes['server.port'] = parseInt(url.port, 10);
      }
    } catch (error) {
      // Invalid URL, skip server attributes
    }
  }

  return attributes;
}

/**
 * Build error attributes
 * @param {Error} error - Error object
 * @returns {Object} Error attributes
 */
export function buildErrorAttributes(error) {
  const attributes = {};

  if (error) {
    // Error type - use error name or class name
    attributes['error.type'] = error.name || error.constructor?.name || 'Error';

    // Map HTTP status codes to error types
    if (error.status || error.statusCode) {
      const status = error.status || error.statusCode;
      attributes['error.type'] = `http_${status}`;

      // Common HTTP error mappings
      if (status === 429) {
        attributes['error.type'] = 'rate_limit_exceeded';
      } else if (status === 401 || status === 403) {
        attributes['error.type'] = 'authentication_error';
      } else if (status === 408) {
        attributes['error.type'] = 'timeout';
      }
    }

    // Map timeout errors
    if (error.code === 'ETIMEDOUT' || error.message?.includes('timeout')) {
      attributes['error.type'] = 'timeout';
    }
  }

  return attributes;
}

/**
 * Build custom iHub-specific attributes
 * @param {Object} context - Request context
 * @returns {Object} Custom attributes
 */
export function buildCustomAttributes(context = {}) {
  const attributes = {};

  // App ID
  if (context.appId) {
    attributes['app.id'] = context.appId;
  }

  // App name
  if (context.appName) {
    attributes['app.name'] = context.appName;
  }

  // User ID
  if (context.userId) {
    attributes['user.id'] = context.userId;
  }

  // User groups
  if (context.userGroups && Array.isArray(context.userGroups)) {
    attributes['user.groups'] = context.userGroups;
  }

  // Conversation/session ID
  if (context.conversationId || context.chatId) {
    attributes['gen_ai.conversation.id'] = context.conversationId || context.chatId;
  }

  // Thinking mode (for models that support it)
  if (context.thinkingEnabled !== undefined) {
    attributes['thinking.enabled'] = context.thinkingEnabled;
  }

  if (context.thinkingBudget !== undefined) {
    attributes['thinking.budget'] = parseInt(context.thinkingBudget, 10);
  }

  // Tool usage
  if (context.toolCount !== undefined) {
    attributes['tool.count'] = parseInt(context.toolCount, 10);
  }

  // Source usage
  if (context.sourceCount !== undefined) {
    attributes['source.count'] = parseInt(context.sourceCount, 10);
  }

  return attributes;
}

/**
 * Sanitize content to remove PII and sensitive data
 * @param {string|Object} content - Content to sanitize
 * @param {Object} config - Sanitization config
 * @returns {string|Object} Sanitized content
 */
export function sanitizeContent(content, config = {}) {
  if (!content) return content;

  const maxSize = config.maxEventSize || 1024;

  // Convert to string if object
  let sanitized = typeof content === 'string' ? content : JSON.stringify(content);

  // Truncate if too large
  if (sanitized.length > maxSize) {
    sanitized = sanitized.substring(0, maxSize) + '... [truncated]';
  }

  // TODO: Add PII detection and redaction patterns
  // - Email addresses
  // - Phone numbers
  // - Credit card numbers
  // - API keys
  // - etc.

  return sanitized;
}

/**
 * Merge multiple attribute objects
 * @param {...Object} attributeSets - Attribute objects to merge
 * @returns {Object} Merged attributes
 */
export function mergeAttributes(...attributeSets) {
  return Object.assign({}, ...attributeSets);
}
