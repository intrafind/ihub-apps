/**
 * Custom error types for LLM SDK
 */

export class LLMError extends Error {
  constructor(message, code, provider, originalError) {
    super(message);
    this.name = 'LLMError';
    this.code = code;
    this.provider = provider;
    this.originalError = originalError;
    this.timestamp = new Date().toISOString();
  }

  toJSON() {
    return {
      name: this.name,
      message: this.message,
      code: this.code,
      provider: this.provider,
      timestamp: this.timestamp,
      stack: this.stack
    };
  }
}

export class ConfigurationError extends LLMError {
  constructor(message, field, provider, originalError) {
    super(message, 'CONFIGURATION_ERROR', provider, originalError);
    this.name = 'ConfigurationError';
    this.field = field;
  }
}

export class ValidationError extends LLMError {
  constructor(message, field, value, provider, originalError) {
    super(message, 'VALIDATION_ERROR', provider, originalError);
    this.name = 'ValidationError';
    this.field = field;
    this.value = value;
  }
}

export class ProviderError extends LLMError {
  constructor(message, statusCode, provider, originalError) {
    super(message, 'PROVIDER_ERROR', provider, originalError);
    this.name = 'ProviderError';
    this.statusCode = statusCode;
  }
}

export class NetworkError extends LLMError {
  constructor(message, provider, originalError) {
    super(message, 'NETWORK_ERROR', provider, originalError);
    this.name = 'NetworkError';
  }
}

export class RateLimitError extends LLMError {
  constructor(message, retryAfter, provider, originalError) {
    super(message, 'RATE_LIMIT_ERROR', provider, originalError);
    this.name = 'RateLimitError';
    this.retryAfter = retryAfter;
  }
}

export class ToolExecutionError extends LLMError {
  constructor(message, toolName, provider, originalError) {
    super(message, 'TOOL_EXECUTION_ERROR', provider, originalError);
    this.name = 'ToolExecutionError';
    this.toolName = toolName;
  }
}

export class StreamingError extends LLMError {
  constructor(message, provider, originalError) {
    super(message, 'STREAMING_ERROR', provider, originalError);
    this.name = 'StreamingError';
  }
}

/**
 * ErrorHandler class for centralized error management
 */
export class ErrorHandler {
  constructor(logger = console) {
    this.logger = logger;
  }

  /**
   * Handle HTTP response errors
   * @param {Response} response - HTTP response
   * @param {string} provider - Provider name
   * @param {string} responseText - Response text
   * @returns {Error} Appropriate error type
   */
  handleHttpError(response, provider, responseText) {
    const { status, statusText } = response;
    
    switch (status) {
      case 400:
        return new ValidationError(
          `Bad request: ${responseText || statusText}`,
          'request',
          null,
          provider
        );
      case 401:
        return new ConfigurationError(
          'Invalid API key or authentication failed',
          'apiKey',
          provider
        );
      case 403:
        return new ProviderError(
          'Access forbidden - insufficient permissions',
          status,
          provider
        );
      case 404:
        return new ProviderError(
          'Resource not found - check model name',
          status,
          provider
        );
      case 429:
        const retryAfter = response.headers.get('retry-after');
        return new RateLimitError(
          'Rate limit exceeded',
          retryAfter ? parseInt(retryAfter) : null,
          provider
        );
      case 500:
      case 502:
      case 503:
      case 504:
        return new ProviderError(
          `Provider server error: ${statusText}`,
          status,
          provider
        );
      default:
        return new ProviderError(
          `HTTP ${status}: ${statusText}`,
          status,
          provider
        );
    }
  }

  /**
   * Handle network/fetch errors
   * @param {Error} error - Network error
   * @param {string} provider - Provider name
   * @returns {NetworkError} Network error
   */
  handleNetworkError(error, provider) {
    let message = 'Network request failed';
    
    if (error.code === 'ENOTFOUND') {
      message = 'DNS resolution failed - check network connection';
    } else if (error.code === 'ECONNREFUSED') {
      message = 'Connection refused - provider may be unavailable';
    } else if (error.code === 'ETIMEDOUT') {
      message = 'Request timed out';
    } else if (error.message) {
      message = error.message;
    }

    return new NetworkError(message, provider, error);
  }

  /**
   * Handle provider-specific API errors
   * @param {Object} errorData - Error data from provider
   * @param {string} provider - Provider name
   * @returns {Error} Appropriate error type
   */
  handleProviderError(errorData, provider) {
    if (!errorData || !errorData.error) {
      return new ProviderError('Unknown provider error', null, provider);
    }

    const error = errorData.error;
    const message = error.message || error.code || 'Provider error';
    
    // Handle common provider error patterns
    if (error.type === 'invalid_request_error') {
      return new ValidationError(message, 'request', null, provider);
    }
    
    if (error.type === 'authentication_error') {
      return new ConfigurationError(message, 'apiKey', provider);
    }
    
    if (error.code === 'rate_limit_exceeded') {
      return new RateLimitError(message, null, provider);
    }

    return new ProviderError(message, null, provider, errorData);
  }

  /**
   * Log error with appropriate level
   * @param {Error} error - Error to log
   * @param {Object} context - Additional context
   */
  logError(error, context = {}) {
    const logData = {
      error: error.toJSON ? error.toJSON() : {
        name: error.name,
        message: error.message,
        stack: error.stack
      },
      context,
      timestamp: new Date().toISOString()
    };

    if (error instanceof RateLimitError || error instanceof NetworkError) {
      this.logger.warn('LLM SDK Warning:', logData);
    } else {
      this.logger.error('LLM SDK Error:', logData);
    }
  }

  /**
   * Wrap async function with error handling
   * @param {Function} fn - Function to wrap
   * @param {string} provider - Provider name
   * @param {Object} context - Additional context
   * @returns {Function} Wrapped function
   */
  wrapAsync(fn, provider, context = {}) {
    return async (...args) => {
      try {
        return await fn(...args);
      } catch (error) {
        let handledError = error;

        if (error instanceof LLMError) {
          // Already handled
          handledError = error;
        } else if (error.name === 'AbortError') {
          handledError = new NetworkError('Request was aborted', provider, error);
        } else if (error.code && error.code.startsWith('E')) {
          // Network error
          handledError = this.handleNetworkError(error, provider);
        } else {
          // Generic error
          handledError = new LLMError(
            error.message || 'Unknown error',
            'UNKNOWN_ERROR',
            provider,
            error
          );
        }

        this.logError(handledError, { ...context, originalArgs: args });
        throw handledError;
      }
    };
  }
}

// Default error handler instance
export const defaultErrorHandler = new ErrorHandler();