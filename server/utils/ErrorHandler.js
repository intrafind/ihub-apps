import configCache from '../configCache.js';

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
      let translations = configCache.getLocalizations(lang);

      const hasServer = translations?.serverErrors && translations.serverErrors[errorKey];
      const hasTool = translations?.toolErrors && translations.toolErrors[errorKey];

      if (!translations || (!hasServer && !hasTool)) {
        if (lang !== defaultLang) {
          let enTranslations = configCache.getLocalizations(defaultLang);
          if (!enTranslations) {
            await configCache.loadAndCacheLocale(defaultLang);
            enTranslations = configCache.getLocalizations(defaultLang);
          }
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
      console.error(`Error getting localized error message for ${errorKey}:`, error);
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

  async createEnhancedLLMApiError(llmResponse, model, language) {
    const errorBody = await llmResponse.text();
    let errorMessage = await this.getLocalizedError(
      'llmApiError',
      { status: llmResponse.status },
      language
    );

    if (llmResponse.status === 401) {
      errorMessage = await this.getLocalizedError(
        'authenticationFailed',
        { provider: model.provider },
        language
      );
    } else if (llmResponse.status === 400) {
      // Check if it's an API key error based on the error body
      const errorBodyLower = errorBody.toLowerCase();
      if (errorBodyLower.includes('api key') || errorBodyLower.includes('api_key')) {
        errorMessage = await this.getLocalizedError(
          'authenticationFailed',
          { provider: model.provider },
          language
        );
      }
    } else if (llmResponse.status === 429) {
      errorMessage = await this.getLocalizedError(
        'rateLimitExceeded',
        { provider: model.provider },
        language
      );
    } else if (llmResponse.status >= 500) {
      errorMessage = await this.getLocalizedError(
        'serviceError',
        { provider: model.provider },
        language
      );
    }

    return {
      message: errorMessage,
      code: llmResponse.status.toString(),
      details: errorBody
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
