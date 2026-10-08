import config from './config.js';
import configCache from './configCache.js';
import tokenStorageService from './services/TokenStorageService.js';
import logger from './utils/logger.js';
import { findByIdCaseInsensitive } from './utils/resourceLookup.js';
import {
  allowsMissingApiKey,
  BUILT_IN_LLM_PROVIDERS,
  getModelProviderId,
  providerEnvKeyName
} from './services/llmProviders.js';

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
    .replaceAll(/[\n\r\t\x00-\x1F\x7F]/g, '') // Remove control characters
    .replaceAll(/[`$\\]/g, String.raw`\$&`); // Escape backticks, dollar signs, backslashes
}

/**
 * @typedef {'ok'|'keyless'|'undecryptable'|'missing'|'unknown-model'} ApiKeyState
 *   - `ok`: a key was found and can be sent.
 *   - `keyless`: no key anywhere, and the model may run without one
 *     (see `allowsMissingApiKey`).
 *   - `undecryptable`: a key is stored but cannot be decrypted — the server's
 *     encryption key is not the one it was saved with — and nothing else supplies one.
 *   - `missing`: no key anywhere and the model needs one.
 *   - `unknown-model`: no model with that id is configured.
 *
 * @typedef {'model'|'provider'|'env'|'none'} ApiKeySource
 *   Where the key comes from; for `undecryptable`, where the unreadable one is stored.
 *
 * @typedef {Object} ApiKeyResolution
 * @property {ApiKeyState} state
 * @property {ApiKeySource} source
 * @property {string|null} apiKey - Set only when `state` is `ok`
 * @property {string|null} envVar - Environment variable the key came from, when `source` is `env`
 * @property {string|null} providerId - Provider entry the model takes its key from
 */

/**
 * Environment variable that supplies the key of a provider-level lookup, and
 * its value. A model linked to a custom provider only reads that provider's
 * variable (e.g. LLMHUB_API_KEY), never the one of its API type: an LLM Hub
 * model speaking the OpenAI API must not be sent OPENAI_API_KEY.
 */
function readProviderEnvKey(model, providerConfigId) {
  // Decided by the link itself, not by comparing IDs: a custom entry may be
  // named like its API type (created before those names were reserved).
  if (model.providerId && !BUILT_IN_LLM_PROVIDERS.includes(model.providerId)) {
    const envVar = providerEnvKeyName(providerConfigId);
    return { envVar, value: config[envVar] };
  }

  const provider = model.provider || '';
  switch (provider) {
    case 'openai':
      return { envVar: 'OPENAI_API_KEY', value: config.OPENAI_API_KEY };
    case 'anthropic':
      return { envVar: 'ANTHROPIC_API_KEY', value: config.ANTHROPIC_API_KEY };
    case 'mistral':
      return { envVar: 'MISTRAL_API_KEY', value: config.MISTRAL_API_KEY };
    case 'google':
      return { envVar: 'GOOGLE_API_KEY', value: config.GOOGLE_API_KEY };
    case 'local':
      return { envVar: 'LOCAL_API_KEY', value: config.LOCAL_API_KEY };
    default: {
      // A generic key named after the provider (e.g. COHERE_API_KEY), then the
      // catch-all as the last resort.
      const genericVar = `${provider.toUpperCase()}_API_KEY`;
      if (config[genericVar]) return { envVar: genericVar, value: config[genericVar] };
      return { envVar: 'DEFAULT_API_KEY', value: config.DEFAULT_API_KEY };
    }
  }
}

/**
 * Work out where a model's API key comes from, and whether it can be used.
 *
 * Checks in this order:
 * 1. Model's stored encrypted API key (from model config)
 * 2. Provider's stored encrypted API key (from providers config) — the entry
 *    named by `model.providerId`, else by `model.provider`
 * 3. Environment variable for model-specific key
 * 4. Environment variable for provider key (see `readProviderEnvKey`)
 *
 * A stored key that cannot be decrypted does not end the search — a later
 * source may still supply one — but if nothing does, the result says so
 * (`undecryptable`) instead of reporting the key as not set: those need
 * different fixes.
 *
 * Synchronous and free of side effects apart from logging, so the admin UI
 * can ask for the state of every model. Never returns the key to anything but
 * the caller.
 *
 * @param {Object} model - Model config
 * @param {Object} [options]
 * @param {boolean} [options.quiet=false] - Skip the per-lookup log lines (for bulk status reads)
 * @returns {ApiKeyResolution}
 */
export function inspectModelApiKey(model, { quiet = false } = {}) {
  const providerConfigId = getModelProviderId(model);
  const log = (level, message, meta) => {
    if (!quiet) logger[level](message, { component: 'Utils', ...meta });
  };
  const ok = (apiKey, source, envVar = null) => ({
    state: 'ok',
    source,
    apiKey,
    envVar,
    providerId: providerConfigId
  });

  // Where an unreadable stored key sits; reported only if nothing else works.
  let undecryptableSource = null;

  /** Plain value of a stored key, or null when it cannot be decrypted. */
  const readStoredKey = (stored, source, meta) => {
    if (!tokenStorageService.isEncrypted(stored)) {
      // Not encrypted: used as-is (hand-written config, or kept for
      // backwards compatibility during migration).
      log('info', `Using stored plaintext API key for ${source}`, meta);
      return stored;
    }
    try {
      const decrypted = tokenStorageService.decryptString(stored);
      log('info', `Using stored encrypted API key for ${source}`, meta);
      return decrypted;
    } catch (error) {
      undecryptableSource = undecryptableSource || source;
      log('error', `Failed to decrypt the stored API key of the ${source}`, {
        ...meta,
        error: error.message,
        hint: 'The server encryption key is not the one the key was saved with. Check TOKEN_ENCRYPTION_KEY and contents/.encryption-key on every instance, or enter the key again.'
      });
      return null;
    }
  };

  // First priority: the model's own stored key
  if (model.apiKey) {
    const key = readStoredKey(model.apiKey, 'model', { modelId: sanitizeForLog(model.id) });
    if (key) return ok(key, 'model');
  }

  // Second priority: the provider entry's stored key
  try {
    const { data: providers = [] } = configCache.getProviders(true);
    const providerConfig = providers.find(p => p.id === providerConfigId);
    if (providerConfig?.apiKey) {
      const key = readStoredKey(providerConfig.apiKey, 'provider', {
        provider: sanitizeForLog(providerConfigId)
      });
      if (key) return ok(key, 'provider');
    }
  } catch (error) {
    logger.error('Error checking provider credentials:', { component: 'Utils', error });
    // Continue to environment variable fallbacks
  }

  // Third priority: a model-specific key in the environment
  // (e.g., GPT_4_AZURE1_API_KEY for model id "gpt-4-azure1")
  const modelSpecificKeyName = `${String(model.id).toUpperCase().replaceAll('-', '_')}_API_KEY`;
  if (config[modelSpecificKeyName]) {
    log('info', 'Using environment variable API key', { envVar: modelSpecificKeyName });
    return ok(config[modelSpecificKeyName], 'env', modelSpecificKeyName);
  }

  // Fourth priority: the provider's key in the environment
  const providerEnv = readProviderEnvKey(model, providerConfigId);
  if (providerEnv.value) {
    log('info', 'Using environment variable API key', { envVar: providerEnv.envVar });
    return ok(providerEnv.value, 'env', providerEnv.envVar);
  }

  const nothing = state => ({
    state,
    source: state === 'undecryptable' ? undecryptableSource : 'none',
    apiKey: null,
    envVar: null,
    providerId: providerConfigId
  });

  if (undecryptableSource) return nothing('undecryptable');
  if (allowsMissingApiKey(model)) return nothing('keyless');

  log('error', 'No API key found for provider or model-specific key', {
    provider: sanitizeForLog(providerConfigId),
    modelSpecificKeyName
  });
  return nothing('missing');
}

/**
 * Resolve the API key state of a model by id. See `inspectModelApiKey`.
 *
 * @param {string} modelId - The model ID
 * @returns {Promise<ApiKeyResolution>}
 */
export async function resolveModelApiKey(modelId) {
  const unavailable = state => ({
    state,
    source: 'none',
    apiKey: null,
    envVar: null,
    providerId: null
  });

  try {
    const { data: models = [] } = configCache.getModels();
    const model = findByIdCaseInsensitive(models || [], modelId);
    if (!model) {
      logger.error(`Model not found: ${sanitizeForLog(modelId)}`, { component: 'Utils' });
      return unavailable('unknown-model');
    }
    return inspectModelApiKey(model);
  } catch (error) {
    logger.error('Error getting API key for model:', { component: 'Utils', error });
    return unavailable('missing');
  }
}

/**
 * Helper function to get API key for a model. See `inspectModelApiKey` for the
 * lookup order.
 *
 * Use `resolveModelApiKey` when the reason for a missing key matters: this
 * returns null for a model that runs without a key just as it does for one
 * that lacks a key it needs.
 *
 * @param {string} modelId - The model ID
 * @returns {Promise<string|null>} The API key or null if there is none
 */
export async function getApiKeyForModel(modelId) {
  return (await resolveModelApiKey(modelId)).apiKey;
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

  // Check if it's a DNS resolution error
  if (
    error.code === 'ENOTFOUND' ||
    (error.cause && error.cause.code === 'ENOTFOUND') ||
    error.message.includes('ENOTFOUND')
  ) {
    errorDetails.isConnectionError = true;
    errorDetails.code = 'ENOTFOUND';
    const hostname = error.cause?.hostname || error.hostname || '';

    if (model?.provider === 'local') {
      errorDetails.message = `Could not resolve hostname for local model server (${model.id}). Is the hostname correct?`;
      errorDetails.recommendation = 'Please check the model URL configuration.';
    } else {
      errorDetails.message = `Could not resolve hostname${hostname ? ' ' + hostname : ''} for ${model?.provider || 'unknown'} API (model ${model?.id || 'unknown'}). DNS lookup failed.`;
      errorDetails.recommendation =
        'If you are behind a corporate proxy, ensure HTTPS_PROXY or https_proxy environment variable is set. Also verify the model URL is correct.';
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
      const userQuery = userMessages.length > 0 ? userMessages.at(-1).content : '';

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
