import config from './config.js';
import { createCompletionRequest } from './adapters/index.js';
import { convertResponseToGeneric } from './adapters/toolCalling/index.js';
import fs from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';
import { throttledFetch } from './requestThrottler.js';
import configCache from './configCache.js';
import tokenStorageService from './services/TokenStorageService.js';
import logger from './utils/logger.js';

// Constants
const JWT_AUTH_REQUIRED = 'JWT_AUTH_REQUIRED';

/**
 * Sanitize user-provided input for logging to prevent log injection
 * @param {string} input - User input to sanitize
 * @returns {string} Sanitized input safe for logging
 */
function sanitizeForLog(input) {
  if (!input || typeof input !== 'string') {
    return String(input);
  }
  // Remove/escape dangerous characters:
  // - Control characters (\n, \r, \t, etc.) for log injection
  // - Backticks, dollar signs, backslashes for shell injection if logs are processed
  return input
    .replace(/[\n\r\t\x00-\x1F\x7F]/g, '') // Remove control characters
    .replace(/[`$\\]/g, '\\$&'); // Escape backticks, dollar signs, backslashes
}

/**
 * Helper function to get API key for a model
 * Checks in this order:
 * 1. Model's stored encrypted API key (from model config)
 * 2. Provider's stored encrypted API key (from providers config)
 * 3. Environment variable for model-specific key
 * 4. Environment variable for provider key
 * @param {string} modelId - The model ID
 * @returns {string|null} The API key or null if not found
 */

export async function getApiKeyForModel(modelId) {
  try {
    // Try to get models from cache first
    let { data: models = [] } = configCache.getModels();

    if (!models) {
      logger.error('Failed to load models configuration', { component: 'Utils' });
      return null;
    }

    // Find the model by ID
    const model = models.find(m => m.id === modelId);
    if (!model) {
      logger.error(`Model not found: ${sanitizeForLog(modelId)}`, { component: 'Utils' });
      return null;
    }

    // Get the provider for this model
    const provider = model.provider;

    // First priority: Check if the model has a stored (encrypted) API key
    if (model.apiKey) {
      try {
        // Check if it's marked as encrypted or appears to be encrypted
        const isEncrypted = tokenStorageService.isEncrypted(model.apiKey);

        if (isEncrypted) {
          const decryptedKey = tokenStorageService.decryptString(model.apiKey);
          logger.info(`Using stored encrypted API key for model: %s`, {
            component: 'Utils',
            modelId: sanitizeForLog(modelId)
          });
          return decryptedKey;
        } else {
          // If not encrypted, use as-is (for backwards compatibility during migration)
          logger.info(`Using stored plaintext API key for model: %s`, {
            component: 'Utils',
            modelId: sanitizeForLog(modelId)
          });
          return model.apiKey;
        }
      } catch (error) {
        logger.error('Failed to decrypt API key for model', {
          component: 'Utils',
          modelId: sanitizeForLog(modelId),
          error: error.message
        });
        // Continue to fallback options
      }
    }

    // Second priority: Check provider-level encrypted API key
    try {
      const { data: providers = [] } = configCache.getProviders(true);
      const providerConfig = providers.find(p => p.id === provider);

      if (providerConfig && providerConfig.apiKey) {
        try {
          const isEncrypted = tokenStorageService.isEncrypted(providerConfig.apiKey);

          if (isEncrypted) {
            const decryptedKey = tokenStorageService.decryptString(providerConfig.apiKey);
            logger.info(`Using stored encrypted provider API key for provider`, {
              component: 'Utils',
              provider: sanitizeForLog(provider)
            });
            return decryptedKey;
          } else {
            // If not encrypted, use as-is (for backwards compatibility during migration)
            logger.info(`Using stored plaintext provider API key for provider`, {
              component: 'Utils',
              provider: sanitizeForLog(provider)
            });
            return providerConfig.apiKey;
          }
        } catch (error) {
          logger.error('Failed to decrypt provider API key', {
            component: 'Utils',
            provider: sanitizeForLog(provider),
            error: error.message
          });
          // Continue to fallback options
        }
      }
    } catch (error) {
      logger.error('Error checking provider credentials:', { component: 'Utils', error });
      // Continue to environment variable fallbacks
    }

    // Third priority: Check for model-specific API key in environment
    // (e.g., GPT_4_AZURE1_API_KEY for model id "gpt-4-azure1")
    const modelSpecificKeyName = `${model.id.toUpperCase().replace(/-/g, '_')}_API_KEY`;
    const modelSpecificKey = config[modelSpecificKeyName];
    if (modelSpecificKey) {
      logger.info(`Using environment variable API key`, {
        component: 'Utils',
        envVar: modelSpecificKeyName
      });
      return modelSpecificKey;
    }

    // Fourth priority: Check for provider-specific API keys from environment
    switch (provider) {
      case 'openai':
        return config.OPENAI_API_KEY;
      case 'anthropic':
        return config.ANTHROPIC_API_KEY;
      case 'mistral':
        return config.MISTRAL_API_KEY;
      case 'google':
        return config.GOOGLE_API_KEY;
      case 'local':
        // For local models, check if there's a specific LOCAL_API_KEY or return a default empty string
        // This allows local models to work without authentication in many cases
        return config.LOCAL_API_KEY || '';
      case 'iassistant':
        // iAssistant uses JWT tokens generated per-user, not static API keys
        // Return a placeholder that indicates JWT auth should be used
        return JWT_AUTH_REQUIRED;
      default:
        // Try to find a generic API key based on provider name (e.g., COHERE_API_KEY for provider 'cohere')
        const genericKey = config[`${provider.toUpperCase()}_API_KEY`];
        if (genericKey) {
          return genericKey;
        }

        // Check for a default API key as last resort
        if (config.DEFAULT_API_KEY) {
          logger.info(`Using DEFAULT_API_KEY for provider`, { component: 'Utils', provider });
          return config.DEFAULT_API_KEY;
        }

        logger.error(`No API key found for provider or model-specific key`, {
          component: 'Utils',
          provider,
          modelSpecificKeyName
        });
        return null;
    }
  } catch (error) {
    logger.error('Error getting API key for model:', { component: 'Utils', error });
    return null;
  }
}

/**
 * Get detailed error information from fetch errors
 * @param {Error} error - The error object
 * @param {Object} model - The model information
 * @returns {Object} Enhanced error details with user-friendly messages
 */
export function getErrorDetails(error, model) {
  const errorDetails = {
    message: error.message,
    code: error.code || 'UNKNOWN_ERROR',
    modelId: model?.id || 'unknown',
    modelProvider: model?.provider || 'unknown',
    isConnectionError: false,
    isTimeout: false,
    recommendation: ''
  };

  // Check if it's a connection error
  if (
    error.code === 'ECONNREFUSED' ||
    (error.cause && error.cause.code === 'ECONNREFUSED') ||
    error.message.includes('ECONNREFUSED')
  ) {
    errorDetails.isConnectionError = true;
    errorDetails.code = 'ECONNREFUSED';

    // Create user-friendly messages based on the model provider
    if (model?.provider === 'local') {
      errorDetails.message = `Could not connect to local model server (${model.id}). Is the local model server running?`;
      errorDetails.recommendation =
        'Please ensure your local model server is running and properly configured.';
    } else {
      errorDetails.message = `Connection refused while trying to access ${model?.provider || 'unknown'} API for model ${model?.id || 'unknown'}.`;
      errorDetails.recommendation = 'Please check your network connection and firewall settings.';
    }
  }

  // Check if it's a timeout error
  if (
    error.code === 'ETIMEDOUT' ||
    (error.cause && error.cause.code === 'ETIMEDOUT') ||
    error.message.includes('timed out') ||
    error.message.includes('timeout')
  ) {
    errorDetails.isTimeout = true;
    errorDetails.code = 'ETIMEDOUT';
    errorDetails.message = `Request to ${model?.provider || 'unknown'} API timed out for model ${model?.id || 'unknown'}.`;
    errorDetails.recommendation =
      'The service might be experiencing high load. Please try again later.';
  }

  // Additional provider-specific error handling
  if (model?.provider === 'local' && errorDetails.isConnectionError) {
    errorDetails.message = `Could not connect to local model server for ${model.id}. Make sure the server is running on the configured address and port.`;
    errorDetails.recommendation =
      "If you wanted to use a cloud model instead, you can modify your app's configuration to use a different model.";
  }

  return errorDetails;
}

/**
 * Logs user interactions with the iHub Apps
 *
 * @param {Object} data - The interaction data to log
 * @param {string} data.appId - The ID of the app being used
 * @param {string} data.modelId - The ID of the model being used
 * @param {string} data.sessionId - The user's session ID (chatId)
 * @param {string} [data.userSessionId] - The user's browser session ID
 * @param {Object} [data.user] - The authenticated user object with username, groups, and id
 * @param {Array} [data.messages] - The conversation messages
 * @param {Object} [data.options] - Additional options like temperature, style, etc.
 * @param {string} [data.responseType] - Type of response (error, success, feedback)
 * @param {string} [data.response] - The AI's response if available
 * @param {Error} [data.error] - Error object if there was an error
 * @param {Object} [data.feedback] - Feedback data if this is a feedback log
 * @param {string} [data.messageId] - Unique ID for the message (used for linking request, response, and feedback)
 * @returns {Promise<void>}
 */
export async function logInteraction(interactionType, data) {
  try {
    const timestamp = new Date().toISOString();

    // Determine the log entry type based on data provided
    let logType = interactionType || 'unknown'; // Use the provided interactionType or default to 'interaction'

    // CRITICAL CHANGE: For feedback logs, use the exact messageId that was provided
    // This ensures the feedback log has the same interactionId as the request/response logs
    let interactionId;

    if (logType === 'feedback' && data.messageId) {
      // For feedback, use the exact messageId that was provided without modification
      interactionId = data.messageId;
    } else if (data.messageId) {
      // For other types, use the messageId if provided, but ensure it has the 'msg-' prefix
      interactionId = data.messageId.startsWith('msg-') ? data.messageId : `msg-${data.messageId}`;
    } else {
      // If no messageId provided, generate a new one
      interactionId = `msg-${Date.now()}-${Math.floor(Math.random() * 1000)}`;
    }

    // Build the log entry with standard fields
    const logEntry = {
      type: logType,
      timestamp,
      interactionId, // Add consistent ID for linking related logs
      appId: data.appId || 'direct',
      modelId: data.modelId,
      sessionId: data.sessionId, // This is the chatId
      userSessionId: data.userSessionId, // This is the browser session ID
      user: data.user
        ? {
            username: data.user.username || data.user.email || 'anonymous',
            id: data.user.id || data.user.email || 'anonymous',
            email: data.user.email
          }
        : null
    };

    // Extract the user's query (last user message) if messages exist
    if (data.messages && Array.isArray(data.messages)) {
      const userMessages = data.messages.filter(m => m.role === 'user');
      const userQuery =
        userMessages.length > 0 ? userMessages[userMessages.length - 1].content : '';

      logEntry.query = userQuery;
      logEntry.messageCount = data.messages.length;
    }

    // Add options if provided
    if (data.options) {
      logEntry.options = data.options;
    }

    // Add response if provided
    if (data.response) {
      logEntry.response = data.response.substring(0, 1000); // Store response content, truncated if needed
    }

    // Add error if provided
    if (data.error) {
      logEntry.responseType = 'error'; // Mark this explicitly as an error response
      logEntry.error = {
        message: data.error.message,
        code: data.error.code
      };
    }

    // Add feedback if provided
    if (data.feedback) {
      logEntry.feedback = data.feedback;
    }

    // For debugging purposes, log to console with appropriate type prefix
    const userInfo = logEntry.user
      ? logEntry.user.username || logEntry.user.id || logEntry.user.email || 'unknown'
      : 'anonymous';

    if (logType === 'feedback') {
      logger.info({
        component: 'ChatService',
        message: 'User feedback received',
        type: 'FEEDBACK',
        id: interactionId,
        appId: logEntry.appId,
        modelId: logEntry.modelId || 'unknown',
        sessionId: logEntry.sessionId,
        user: userInfo,
        rating: data.feedback?.rating || 'unknown'
      });
    } else if (logType === 'chat_response') {
      logger.info({
        component: 'ChatService',
        message: 'Chat response generated',
        type: 'CHAT_RESPONSE',
        id: interactionId,
        appId: logEntry.appId,
        modelId: logEntry.modelId || 'unknown',
        sessionId: logEntry.sessionId,
        user: userInfo
      });
    } else if (logType === 'chat_request') {
      logger.info({
        component: 'ChatService',
        message: 'Chat request received',
        type: 'CHAT_REQUEST',
        id: interactionId,
        appId: logEntry.appId,
        modelId: logEntry.modelId || 'unknown',
        sessionId: logEntry.sessionId,
        user: userInfo,
        query: logEntry.query
      });
    } else {
      logger.info({
        component: 'ChatService',
        message: 'Interaction logged',
        type: 'INTERACTION',
        id: interactionId,
        appId: logEntry.appId,
        modelId: logEntry.modelId || 'unknown',
        sessionId: logEntry.sessionId,
        user: userInfo
      });
    }

    // Return the interaction ID so it can be used to link requests, responses, and feedback
    return interactionId;
  } catch (error) {
    // Don't let logging errors affect the main application flow
    logger.error({
      component: 'ChatService',
      message: 'Error logging interaction',
      error: error.message,
      stack: error.stack
    });
    return null;
  }
}

/**
 * Create a session tracker for chat sessions
 *
 * @param {string} chatId - The chat/session ID
 * @param {Object} info - Additional session info
 * @returns {string} The session ID
 */
export function trackSession(chatId, info = {}) {
  try {
    // Log chat session start, including both chatId and userSessionId if available
    const userSessionId = info.userSessionId || 'unknown';

    logger.info({
      component: 'ChatService',
      message: 'Chat session started',
      type: 'CHAT_STARTED',
      chatId,
      userSessionId,
      appId: info.appId || 'unknown',
      userAgent: info.userAgent || 'unknown'
    });

    return chatId;
  } catch (error) {
    logger.error({
      component: 'ChatService',
      message: 'Error tracking chat session',
      error: error.message,
      stack: error.stack
    });
    return chatId;
  }
}

/**
 * Logs a new user session when it begins
 *
 * @param {string} chatId - The chat/session ID
 * @param {string} appId - The app being used
 * @param {Object} metadata - Additional metadata about the session
 * @returns {Promise<void>}
 */
export async function logNewSession(chatId, appId, metadata = {}) {
  try {
    const timestamp = new Date().toISOString();

    logger.info({
      component: 'ChatService',
      message: 'New session started',
      type: 'SESSION_START',
      timestamp,
      sessionId: chatId,
      appId: appId || 'unknown',
      userAgent: metadata.userAgent || 'unknown',
      ipAddress: metadata.ipAddress || 'unknown',
      language: metadata.language || configCache.getPlatform()?.defaultLanguage || 'en',
      referrer: metadata.referrer || 'unknown'
    });
  } catch (error) {
    // Don't let logging errors affect the main application flow
    logger.error({
      component: 'ChatService',
      message: 'Error logging new session',
      error: error.message,
      stack: error.stack
    });
  }
}

/**
 * Performs a simple, non-streaming completion request to a language model.
 * @param {string} prompt - The prompt to send to the model.
 * @param {object} options - Configuration options.
 * @param {string} [options.modelId] - The ID of the model to use.
 * @param {string} [options.model] - Alias for modelId.
 * @param {number} [options.temperature=0.7] - The temperature for the completion.
 * @param {string} [options.responseFormat] - Desired output format ('json').
 * @param {object} [options.responseSchema] - Optional JSON schema for structured output.
 * @returns {Promise<string>} The content of the model's response.
 */
export async function simpleCompletion(
  messages,
  {
    modelId = null,
    model = null,
    temperature = 0.7,
    maxTokens = 8192,
    responseFormat = null,
    responseSchema = null,
    apiKey = null
  } = {}
) {
  const resolvedModelId = modelId || model;

  logger.info('Starting simple completion...', {
    component: 'Utils',
    messages: JSON.stringify(messages, null, 2),
    modelId: resolvedModelId,
    temperature
  });
  // Try to get models from cache first
  let { data: models = [] } = configCache.getModels();
  logger.info('Available models:', { component: 'Utils', models: models.map(m => m.id) });

  const modelConfig = models.find(m => m.id === resolvedModelId);
  logger.info('Using model:', { component: 'Utils', modelConfig });
  if (!modelConfig) {
    throw new Error(`Model ${resolvedModelId} not found`);
  }

  // Use provided API key if available, otherwise get from environment or stored config
  let resolvedApiKey = apiKey;
  if (!resolvedApiKey) {
    // Try to get API key from model/provider configuration or environment
    resolvedApiKey = await getApiKeyForModel(modelConfig.id);
    if (!resolvedApiKey) {
      throw new Error(`API key for ${modelConfig.provider} not found in environment variables.`);
    }
  }

  const msgArray = Array.isArray(messages) ? messages : [{ role: 'user', content: messages }];

  const request = createCompletionRequest(modelConfig, msgArray, resolvedApiKey, {
    temperature,
    maxTokens,
    stream: false,
    responseFormat,
    responseSchema
  });

  const response = await throttledFetch(modelConfig.id, request.url, {
    method: 'POST',
    headers: request.headers,
    body: JSON.stringify(request.body)
  });

  if (!response.ok) {
    const errorBody = await response.text();
    throw new Error(`LLM API request failed with status ${response.status}: ${errorBody}`);
  }

  const responseData = await response.json();

  // Use the adapter to parse the response
  const parsed = convertResponseToGeneric(JSON.stringify(responseData), modelConfig.provider);

  // Return both content and usage data
  return {
    content: parsed.content.join(''),
    usage: responseData.usage || {
      prompt_tokens: 0,
      completion_tokens: 0,
      total_tokens: 0
    }
  };
}

/**
 * Resolve a model ID with fallback to default model
 * @param {string} preferredModel - The preferred model ID
 * @param {string} toolName - Name of the tool for logging purposes
 * @returns {string} The resolved model ID
 */
export function resolveModelId(preferredModel = null, toolName = 'unknown') {
  try {
    // Get available models and default model
    const { data: models = [] } = configCache.getModels();
    const defaultModel = models.find(m => m.default)?.id;

    // Check if any models are available
    if (!models || models.length === 0) {
      logger.warn(`${toolName}: No models available, using fallback`, { component: 'Utils' });
      return null;
    }

    // Use preferred model if provided and exists
    if (preferredModel && models.some(m => m.id === preferredModel)) {
      return preferredModel;
    }

    // Log warning if preferred model was specified but not found
    if (preferredModel) {
      logger.warn(
        `${toolName}: Model '${preferredModel}' not found, falling back to default model '${defaultModel}'`,
        { component: 'Utils' }
      );
    }

    // Fallback to default model
    if (defaultModel && models.some(m => m.id === defaultModel)) {
      return defaultModel;
    }

    // Final fallback to first available model
    const firstModel = models[0]?.id;
    if (firstModel) {
      logger.warn(
        `${toolName}: Default model not found, using first available model '${firstModel}'`,
        { component: 'Utils' }
      );
      return firstModel;
    }

    logger.error(`${toolName}: No models available`, { component: 'Utils' });
    return null;
  } catch (error) {
    logger.error(`${toolName}: Error resolving model ID:`, { component: 'Utils', error });
    return null;
  }
}
