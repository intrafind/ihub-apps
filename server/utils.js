import { loadJson } from "./configLoader.js";
import config from "./config.js";
import { createCompletionRequest, processResponseBuffer } from "./adapters/index.js";
import fs from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';
import configCache from './configCache.js';

/**
 * Helper function to get API key for a model
 * @param {string} modelId - The model ID
 * @returns {string|null} The API key or null if not found
 */

export async function getApiKeyForModel(modelId) {
  try {
    // Try to get models from cache first
    let models = configCache.getModels();
    
    if (!models) {
      console.error('Failed to load models configuration');
      return null;
    }
    
    // Find the model by ID
    const model = models.find(m => m.id === modelId);
    if (!model) {
      console.error(`Model not found: ${modelId}`);
      return null;
    }
    
    // Get the provider for this model
    const provider = model.provider;
    
    // Check for provider-specific API keys
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
      default:
        // Try to find a generic API key based on provider name (e.g., COHERE_API_KEY for provider 'cohere')
        const genericKey = config[`${provider.toUpperCase()}_API_KEY`];
        if (genericKey) {
          return genericKey;
        }
        
        // Check for a default API key as last resort
        if (config.DEFAULT_API_KEY) {
          console.log(`Using DEFAULT_API_KEY for provider: ${provider}`);
          return config.DEFAULT_API_KEY;
        }
        
        console.error(`No API key found for provider: ${provider}`);
        return null;
    }
  } catch (error) {
    console.error('Error getting API key for model:', error);
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
  if (error.code === 'ECONNREFUSED' || 
      (error.cause && error.cause.code === 'ECONNREFUSED') ||
      error.message.includes('ECONNREFUSED')) {
    errorDetails.isConnectionError = true;
    errorDetails.code = 'ECONNREFUSED';
    
    // Create user-friendly messages based on the model provider
    if (model?.provider === 'local') {
      errorDetails.message = `Could not connect to local model server (${model.id}). Is the local model server running?`;
      errorDetails.recommendation = 'Please ensure your local model server is running and properly configured.';
    } else {
      errorDetails.message = `Connection refused while trying to access ${model?.provider || 'unknown'} API for model ${model?.id || 'unknown'}.`;
      errorDetails.recommendation = 'Please check your network connection and firewall settings.';
    }
  }
  
  // Check if it's a timeout error
  if (error.code === 'ETIMEDOUT' || 
      (error.cause && error.cause.code === 'ETIMEDOUT') ||
      error.message.includes('timed out') ||
      error.message.includes('timeout')) {
    errorDetails.isTimeout = true;
    errorDetails.code = 'ETIMEDOUT';
    errorDetails.message = `Request to ${model?.provider || 'unknown'} API timed out for model ${model?.id || 'unknown'}.`;
    errorDetails.recommendation = 'The service might be experiencing high load. Please try again later.';
  }
  
  // Additional provider-specific error handling
  if (model?.provider === 'local' && errorDetails.isConnectionError) {
    errorDetails.message = `Could not connect to local model server for ${model.id}. Make sure the server is running on the configured address and port.`;
    errorDetails.recommendation = `If you wanted to use a cloud model instead, you can modify your app's configuration to use a different model.`;
  }
  
  return errorDetails;
}

/**
 * Logs user interactions with the AI Hub Apps
 * 
 * @param {Object} data - The interaction data to log
 * @param {string} data.appId - The ID of the app being used
 * @param {string} data.modelId - The ID of the model being used
 * @param {string} data.sessionId - The user's session ID (chatId)
 * @param {string} [data.userSessionId] - The user's browser session ID
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
    };
    
    // Extract the user's query (last user message) if messages exist
    if (data.messages && Array.isArray(data.messages)) {
      const userMessages = data.messages.filter(m => m.role === 'user');
      const userQuery = userMessages.length > 0 ? userMessages[userMessages.length - 1].content : '';
      
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
    if (logType === 'feedback') {
      console.log(`[FEEDBACK] ${timestamp} | ID: ${interactionId} | App: ${logEntry.appId} | Model: ${logEntry.modelId || 'unknown'} | Session: ${logEntry.sessionId} | Rating: ${data.feedback?.rating || 'unknown'}`);
    } else if (logType === 'chat_response') {
      console.log(`[CHAT_RESPONSE] ${timestamp} | ID: ${interactionId} | App: ${logEntry.appId} | Model: ${logEntry.modelId || 'unknown'} | Session: ${logEntry.sessionId}`);
    } else if (logType === 'chat_request') {
      const queryPreview = logEntry.query ? `| Query: ${logEntry.query.substring(0, 50)}${logEntry.query.length > 50 ? '...' : ''}` : '';
      console.log(`[CHAT_REQUEST] ${timestamp} | ID: ${interactionId} | App: ${logEntry.appId} | Model: ${logEntry.modelId || 'unknown'} | Session: ${logEntry.sessionId} ${queryPreview}`);
    } else {
      console.log(`[INTERACTION] ${timestamp} | ID: ${interactionId} | App: ${logEntry.appId} | Model: ${logEntry.modelId || 'unknown'} | Session: ${logEntry.sessionId}`);
    }
    
    // Write to log file
    await appendToLogFile(logEntry);

    
    // Return the interaction ID so it can be used to link requests, responses, and feedback
    return interactionId;
    
  } catch (error) {
    // Don't let logging errors affect the main application flow
    console.error('Error logging interaction:', error);
    return null;
  }
}

/**
 * Append log entry to the log file
 * 
 * @param {Object} logEntry - The log entry to append
 * @returns {Promise<void>}
 */
async function appendToLogFile(logEntry) {
  try {
    const __filename = fileURLToPath(import.meta.url);
    const __dirname = path.dirname(__filename);
    
    // Create logs directory if it doesn't exist
    const logsDir = path.join(__dirname, '../logs');
    try {
      await fs.mkdir(logsDir, { recursive: true });
    } catch (err) {
      if (err.code !== 'EEXIST') throw err;
    }
    
    // Create log file path with today's date
    const today = new Date().toISOString().split('T')[0]; // YYYY-MM-DD
    const logFilePath = path.join(logsDir, `interactions-${today}.log`);
    
    // Append log entry to file
    await fs.appendFile(
      logFilePath, 
      JSON.stringify(logEntry) + '\n',
      'utf8'
    );
  } catch (error) {
    console.error('Error writing to log file:', error);
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
    
    console.log(`[CHAT STARTED] Chat ID: ${chatId} | User Session: ${userSessionId} | App: ${info.appId || 'unknown'}`);
    
    // Store the chat session info in a log file
    appendToLogFile({
      type: 'chat_started',
      timestamp: new Date().toISOString(),
      chatId: chatId,
      userSessionId: userSessionId,
      appId: info.appId || 'unknown',
      userAgent: info.userAgent || 'unknown'
    }).catch(error => {
      console.error('Error logging chat session start:', error);
    });
    
    return chatId;
  } catch (error) {
    console.error('Error tracking chat session:', error);
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
    
    // Build the log entry
    const logEntry = {
      type: 'session_start',
      timestamp,
      sessionId: chatId,
      appId: appId || 'unknown',
      userAgent: metadata.userAgent || 'unknown',
      ipAddress: metadata.ipAddress || 'unknown',
      language: metadata.language || 'en',
      referrer: metadata.referrer || 'unknown'
    };
    
    console.log(`[NEW SESSION] ${timestamp} | Session ID: ${chatId} | App: ${appId}`);
    
    // Write to log file
    await appendToLogFile(logEntry);
  } catch (error) {
    // Don't let logging errors affect the main application flow
    console.error('Error logging new session:', error);
  }
}

/**
 * Performs a simple, non-streaming completion request to a language model.
 * @param {string} prompt - The prompt to send to the model.
 * @param {object} options - Configuration options.
 * @param {string} options.model - The ID of the model to use.
 * @param {number} [options.temperature=0.7] - The temperature for the completion.
 * @returns {Promise<string>} The content of the model's response.
 */
export async function simpleCompletion(prompt, { model: modelId, temperature = 0.7 }) {
  // Try to get models from cache first
  let models = configCache.getModels();
  
  const model = models.find(m => m.id === modelId);
  if (!model) {
    throw new Error(`Model ${modelId} not found`);
  }

  const apiKey = config[`${model.provider.toUpperCase()}_API_KEY`];
  if (!apiKey) {
    throw new Error(`API key for ${model.provider} not found in environment variables.`);
  }

  const messages = [{ role: 'user', content: prompt }];
  const request = createCompletionRequest(model, messages, apiKey, {
    temperature,
    maxTokens: 4096, // Sufficient for internal tasks
    stream: false
  });

  const response = await fetch(request.url, {
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
  const parsed = processResponseBuffer(model.provider, JSON.stringify(responseData));
  return parsed.content.join('');
}
