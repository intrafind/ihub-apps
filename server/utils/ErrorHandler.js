import configCache from '../configCache.js';
import logger from './logger.js';

class ChatError extends Error {
  constructor(message, code, details = null) {
    super(message);
    this.name = this.constructor.name;
    this.code = code;
    this.details = details;
  }
}

class ApiKeyError extends ChatError {
  constructor(message, provider, code = 'API_KEY_ERROR') {
    super(message, code);
    this.provider = provider;
  }
}

class ModelError extends ChatError {
  constructor(message, modelId, provider, code = 'MODEL_ERROR') {
    super(message, code);
    this.modelId = modelId;
    this.provider = provider;
  }
}

class ToolError extends ChatError {
  constructor(message, toolId, code = 'TOOL_ERROR', details = null) {
    super(message, code);
    this.toolId = toolId;
    this.details = details;
  }
}

class RequestTimeoutError extends ChatError {
  constructor(timeout, code = 'REQUEST_TIMEOUT') {
    super(`Request timed out after ${timeout / 1000} seconds`, code);
    this.timeout = timeout;
  }
}

class LLMApiError extends ChatError {
  constructor(message, status, provider, code = 'LLM_API_ERROR', details = null) {
    super(message, code);
    this.status = status;
    this.provider = provider;
    this.details = details;
  }
}

class ErrorHandler {
  constructor() {
    this.defaultLanguage = 'en';
  }

  async getLocalizedError(errorKey, params = {}, language) {
    const defaultLang = configCache.getPlatform()?.defaultLanguage || this.defaultLanguage;
    const lang = language || defaultLang;

    try {
      let localeData = configCache.getLocalizations(lang);

      // The locale data is wrapped in { data: {...}, etag: ... }
      let translations = localeData?.data;

      const hasServer = translations?.serverErrors && translations.serverErrors[errorKey];
      const hasTool = translations?.toolErrors && translations.toolErrors[errorKey];

      if (!translations || (!hasServer && !hasTool)) {
        if (lang !== defaultLang) {
          let enLocaleData = configCache.getLocalizations(defaultLang);
          if (!enLocaleData) {
            await configCache.loadAndCacheLocale(defaultLang);
            enLocaleData = configCache.getLocalizations(defaultLang);
          }
          let enTranslations = enLocaleData?.data;
          const enServer = enTranslations?.serverErrors?.[errorKey];
          const enTool = enTranslations?.toolErrors?.[errorKey];
          if (enServer || enTool) {
            let message = enServer || enTool;
            Object.entries(params).forEach(([k, v]) => {
              message = message.replace(`{${k}}`, v);
            });
            return message;
          }
        }
        return `Error: ${errorKey}`;
      }

      let message = translations.serverErrors?.[errorKey] || translations.toolErrors?.[errorKey];
      Object.entries(params).forEach(([k, v]) => {
        message = message.replace(`{${k}}`, v);
      });
      return message;
    } catch (error) {
      logger.error(`Error getting localized error message for ${errorKey}:`, error);
      return `Error: ${errorKey}`;
    }
  }

  async createApiKeyError(provider, language) {
    const message = await this.getLocalizedError('apiKeyNotFound', { provider }, language);
    return new ApiKeyError(message, provider);
  }

  async createModelError(modelId, provider, language) {
    const message = await this.getLocalizedError('modelNotFound', { modelId, provider }, language);
    return new ModelError(message, modelId, provider);
  }

  async createToolError(toolId, errorMessage, language, details = null) {
    const message = await this.getLocalizedError(
      'toolExecutionFailed',
      { toolId, error: errorMessage },
      language
    );
    return new ToolError(message, toolId, 'TOOL_EXECUTION_ERROR', details);
  }

  async createRequestTimeoutError(timeout, language) {
    await this.getLocalizedError('requestTimeout', { timeout: timeout / 1000 }, language);
    return new RequestTimeoutError(timeout, 'REQUEST_TIMEOUT');
  }

  async createLLMApiError(status, provider, language, details = null) {
    let errorKey = 'llmApiError';
    if (status === 401) {
      errorKey = 'authenticationFailed';
    } else if (status === 429) {
      errorKey = 'rateLimitExceeded';
    } else if (status >= 500) {
      errorKey = 'serviceError';
    }

    const message = await this.getLocalizedError(errorKey, { status, provider }, language);
    return new LLMApiError(message, status, provider, errorKey.toUpperCase(), details);
  }

  /**
   * Detects if an error is related to context window/token limits
   * @param {string} errorBody - The error message body
   * @param {number} status - HTTP status code
   * @returns {boolean} True if it's a context window error
   */
  isContextWindowError(errorBody, _status) {
    if (!errorBody) return false;

    const errorBodyLower = errorBody.toLowerCase();

    // First, exclude API key errors - these should NOT be treated as context window errors
    if (
      errorBodyLower.includes('api key') ||
      errorBodyLower.includes('api_key') ||
      errorBodyLower.includes('apikey') ||
      errorBodyLower.includes('api-key') ||
      errorBodyLower.includes('authentication') ||
      errorBodyLower.includes('unauthorized')
    ) {
      return false;
    }

    // Common patterns for context window errors across providers
    const contextPatterns = [
      // OpenAI patterns
      'context_length_exceeded',
      'maximum context length',
      'max_tokens',
      'token limit',
      'reduce the length of the messages',

      // Anthropic patterns
      'max_tokens_to_sample',
      'token limit exceeded',
      'prompt is too long',
      'maximum number of tokens',

      // Google patterns - removed 'invalid_argument' as it's too generic
      'token limit',
      'maximum input length',
      'request entity too large',
      'prompt size exceeds',

      // Azure OpenAI patterns
      'invalidrequesterror',
      'token limit exceeded',
      'context length exceeded',

      // General patterns
      'too many tokens',
      'exceeds the limit',
      'context too long',
      'message too long',
      'payload too large'
    ];

    // Check if any pattern matches
    return contextPatterns.some(pattern => errorBodyLower.includes(pattern));
  }

  async createEnhancedLLMApiError(llmResponse, model, language) {
    const errorBody = await llmResponse.text();
    let errorMessage = await this.getLocalizedError(
      'llmApiError',
      { status: llmResponse.status },
      language
    );
    let errorCode = llmResponse.status.toString();

    if (llmResponse.status === 401) {
      errorMessage = await this.getLocalizedError(
        'authenticationFailed',
        { provider: model.provider },
        language
      );
      errorCode = 'AUTH_FAILED';
    } else if (llmResponse.status === 400 || llmResponse.status === 413) {
      const errorBodyLower = errorBody.toLowerCase();

      // Check if it's an API key error FIRST (before context window check)
      if (
        errorBodyLower.includes('api key') ||
        errorBodyLower.includes('api_key') ||
        errorBodyLower.includes('apikey') ||
        errorBodyLower.includes('api-key') ||
        (errorBodyLower.includes('invalid_argument') && errorBodyLower.includes('key'))
      ) {
        errorMessage = await this.getLocalizedError(
          'authenticationFailed',
          { provider: model.provider },
          language
        );
        errorCode = 'AUTH_FAILED';
      }
      // Check for context window errors second
      else if (this.isContextWindowError(errorBody, llmResponse.status)) {
        errorMessage = await this.getLocalizedError(
          'contextWindowExceeded',
          {
            provider: model.provider,
            modelId: model.id,
            tokenLimit: model.tokenLimit || 'unknown'
          },
          language
        );
        errorCode = 'CONTEXT_WINDOW_EXCEEDED';
      } else {
        // Generic bad request
        errorMessage = await this.getLocalizedError(
          'invalidRequest',
          { provider: model.provider },
          language
        );
        errorCode = 'INVALID_REQUEST';
      }
    } else if (llmResponse.status === 429) {
      errorMessage = await this.getLocalizedError(
        'rateLimitExceeded',
        { provider: model.provider },
        language
      );
      errorCode = 'RATE_LIMIT';
    } else if (llmResponse.status === 503) {
      // Check if the 503 might be due to context size
      if (this.isContextWindowError(errorBody, llmResponse.status)) {
        errorMessage = await this.getLocalizedError(
          'contextWindowExceeded',
          {
            provider: model.provider,
            modelId: model.id,
            tokenLimit: model.tokenLimit || 'unknown'
          },
          language
        );
        errorCode = 'CONTEXT_WINDOW_EXCEEDED';
      } else {
        errorMessage = await this.getLocalizedError(
          'serviceUnavailable',
          { provider: model.provider },
          language
        );
        errorCode = 'SERVICE_UNAVAILABLE';
      }
    } else if (llmResponse.status >= 500) {
      errorMessage = await this.getLocalizedError(
        'serviceError',
        { provider: model.provider },
        language
      );
      errorCode = 'SERVICE_ERROR';
    }

    return {
      message: errorMessage,
      code: errorCode,
      httpStatus: llmResponse.status,
      details: errorBody,
      isContextWindowError: this.isContextWindowError(errorBody, llmResponse.status)
    };
  }

  formatErrorResponse(error) {
    const response = {
      error: error.message,
      code: error.code
    };

    if (error instanceof ApiKeyError) {
      response.provider = error.provider;
    } else if (error instanceof ModelError) {
      response.modelId = error.modelId;
      response.provider = error.provider;
    } else if (error instanceof ToolError) {
      response.toolId = error.toolId;
      if (error.details) response.details = error.details;
    } else if (error instanceof LLMApiError) {
      response.status = error.status;
      response.provider = error.provider;
      if (error.details) response.details = error.details;
    }

    return response;
  }

  isRetryableError(error) {
    if (error instanceof LLMApiError) {
      return error.status === 429 || error.status >= 500;
    }
    return false;
  }
}

export default ErrorHandler;
export { ChatError, ApiKeyError, ModelError, ToolError, RequestTimeoutError, LLMApiError };
