// Import required modules
import express from 'express';
import cors from 'cors';
import fs from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';
import dotenv from 'dotenv';
import http from 'http';
import https from 'https';

// Import adapters and utilities
import { createCompletionRequest, processResponseBuffer, formatMessages } from './adapters/index.js';
import { sendSSE, getApiKeyForModel, getModelInfo, getErrorDetails, logInteraction, trackSession, logNewSession } from './utils.js';

// Initialize environment variables
dotenv.config();

// Determine if we're running from a packaged binary
// Either via process.pkg (when using pkg directly) or APP_ROOT_DIR env var (our shell script approach)
const isPackaged = process.pkg !== undefined || process.env.APP_ROOT_DIR !== undefined;

// Set up directory paths
const __filename = fileURLToPath(import.meta.url);
const { dirname } = path;
const __dirname = dirname(__filename);

// Handle paths differently when running from a packaged binary vs normal execution
// In packaged mode, use APP_ROOT_DIR environment variable if available
let rootDir;
if (isPackaged) {
  rootDir = process.env.APP_ROOT_DIR || path.dirname(process.execPath);
  console.log(`Running in packaged binary mode with APP_ROOT_DIR: ${rootDir}`);
} else {
  rootDir = path.join(__dirname, '..');
  console.log(`Running in normal mode`);
}
console.log(`Root directory: ${rootDir}`);

// Get the contents directory, either from environment variable or use default 'contents'
const contentsDir = process.env.CONTENTS_DIR || 'contents';
console.log(`Using contents directory: ${contentsDir}`);

// Create Express application
const app = express();
const PORT = process.env.PORT || 3000;
const HOST = process.env.HOST || '0.0.0.0'; // Default to all interfaces

// Configure request timeouts
const DEFAULT_TIMEOUT = parseInt(process.env.REQUEST_TIMEOUT || '60000', 10); // 60 seconds default

// Store active client connections
const clients = new Map();
const activeRequests = new Map();

// --- Additional code to handle macOS port reuse ---
// Enable port reuse to avoid EADDRINUSE errors on quick restarts
const serverOptions = {
  // This allows the server to use a port that is in TIME_WAIT state
  // (which can happen if the server is restarted quickly)
  // Note: These are only applied when creating HTTP/HTTPS servers directly
  ...(process.platform === 'darwin' ? { reuseAddr: true, reusePort: true } : {})
};

/**
 * Gets the localized value from a potentially multi-language object
 * Similar to client-side getLocalizedContent utility
 * 
 * @param {Object|string} content - Content that might be a translation object or direct string
 * @param {string} language - Current language code (e.g., 'en', 'de')
 * @param {string} [fallbackLanguage='en'] - Fallback language if requested language is not available
 * @returns {string} - The localized content
 */
function getLocalizedContent(content, language = 'en', fallbackLanguage = 'en') {
  // Handle null or undefined content
  if (content === null || content === undefined) {
    return '';
  }
  
  // If the content is a string, return it directly
  if (typeof content === 'string') {
    return content;
  }
  
  // If content is an object with language keys
  if (typeof content === 'object') {
    try {
      // Try to get the content in the requested language
      if (content[language]) {
        return content[language];
      }
      
      // Fall back to the fallback language
      if (content[fallbackLanguage]) {
        return content[fallbackLanguage];
      }
      
      // If neither the requested language nor fallback exist, get the first available translation
      const availableLanguages = Object.keys(content);
      if (availableLanguages.length > 0) {
        // Only log missing keys for non-English languages to reduce noise
        if (language !== 'en') {
          console.error(`Missing translation for language: ${language}`);
        }
        return content[availableLanguages[0]];
      }
      
      return '';
    } catch (error) {
      // Keep error logging for actual errors
      console.error('Error accessing content object:', error);
      return '';
    }
  }
  
  // For any other type, convert to string
  try {
    return String(content);
  } catch (e) {
    console.error('Failed to convert content to string:', e);
    return '';
  }
}

/**
 * Gets a localized error message from the translations
 * 
 * @param {string} errorKey - The key for the error message in serverErrors
 * @param {Object} params - Parameters to replace in the message
 * @param {string} language - The language code
 * @returns {string} - The localized error message
 */
async function getLocalizedError(errorKey, params = {}, language = 'en') {
  try {
    // Load translations for the requested language
    const translations = await loadUnifiedContent(`locales/${language}.json`);
    
    if (!translations || !translations.serverErrors || !translations.serverErrors[errorKey]) {
      // Try English as fallback
      if (language !== 'en') {
        const enTranslations = await loadUnifiedContent('locales/en.json');
        if (enTranslations && enTranslations.serverErrors && enTranslations.serverErrors[errorKey]) {
          let message = enTranslations.serverErrors[errorKey];
          
          // Replace any parameters in the message
          Object.entries(params).forEach(([key, value]) => {
            message = message.replace(`{${key}}`, value);
          });
          
          return message;
        }
      }
      
      // Default fallback message if nothing else works
      return `Error: ${errorKey}`;
    }
    
    let message = translations.serverErrors[errorKey];
    
    // Replace any parameters in the message
    Object.entries(params).forEach(([key, value]) => {
      message = message.replace(`{${key}}`, value);
    });
    
    return message;
  } catch (error) {
    console.error(`Error getting localized error message for ${errorKey}:`, error);
    return `Error: ${errorKey}`; // Fallback
  }
}

// Check if API keys are configured and log warnings at startup
function validateApiKeys() {
  const providers = ['openai', 'anthropic', 'google'];
  const missingKeys = [];
  
  for (const provider of providers) {
    const envVar = `${provider.toUpperCase()}_API_KEY`;
    if (!process.env[envVar]) {
      missingKeys.push(provider);
    }
  }
  
  if (missingKeys.length > 0) {
    console.warn(`⚠️ WARNING: Missing API keys for providers: ${missingKeys.join(', ')}`);
    console.warn('Some models may not work. Please check your .env file configuration.');
  } else {
    console.log('✓ All provider API keys are configured');
  }
}

// Middleware
app.use(cors());
app.use(express.json({ limit: '50mb' })); // Increased limit for file uploads
app.use(express.urlencoded({ limit: '50mb', extended: true })); // Also handle URL-encoded data

// Determine static file path based on environment and packaging
let staticPath;
if (isPackaged) {
  // When running as a packaged binary, serve from the public directory next to the executable
  staticPath = path.join(rootDir, 'public');
} else if (process.env.NODE_ENV === 'production') {
  // In production but not packaged, use relative path
  staticPath = path.join(__dirname, '../public');
} else {
  // In development, serve from client/dist
  staticPath = path.join(__dirname, '../client/dist');
}

console.log(`Serving static files from: ${staticPath}`);
app.use(express.static(staticPath));

// Helper function to load configuration files with caching
const configCache = new Map();
const CONFIG_CACHE_TTL = 60 * 1000; // 60 seconds cache

/**
 * Unified content loading function to handle both JSON and raw file content (like markdown)
 * with caching for better performance.
 * 
 * @param {string} filename - The path to the file (relative to the contents directory or with prefix like config/)
 * @param {Object} options - Options for content loading
 * @param {boolean} options.parseJson - Whether to parse the content as JSON (default true)
 * @param {boolean} options.useCache - Whether to use cache for this content (default true)
 * @param {string} options.basePath - Base path to use instead of 'contents' (optional)
 * @returns {Promise<any>} - The loaded content (parsed JSON or raw string)
 */
async function loadUnifiedContent(filename, options = {}) {
  const { parseJson = true, useCache = true, basePath = null } = options;
  
  try {
    // Cache key based on the full requested path and parse option to distinguish
    const cacheKey = `${filename}:${parseJson}`;
    
    // Return cached content if available and caching is enabled
    if (useCache) {
      const cachedEntry = configCache.get(cacheKey);
      if (cachedEntry && (Date.now() - cachedEntry.timestamp) < CONFIG_CACHE_TTL) {
        return cachedEntry.data;
      }
    }
    
    // Safely handle paths with subdirectories while preventing traversal
    // First normalize the path to prevent traversal attacks (removes ../, etc)
    const normalizedPath = path.normalize(filename).replace(/^(\.\.[\/\\])+/, '');
    
    // Handle cases where the file path already includes the base directory
    const baseDir = basePath || contentsDir;
    let fullPath;
    
    // If the path already starts with the base directory, don't add it again
    const pathWithoutLeadingSlash = normalizedPath.replace(/^\//, '');
    if (pathWithoutLeadingSlash.startsWith(`${baseDir}/`)) {
      // The path already includes the base directory
      if (isPackaged) {
        fullPath = path.join(rootDir, pathWithoutLeadingSlash);
      } else {
        fullPath = path.join(__dirname, '..', pathWithoutLeadingSlash);
      }
    } else {
      // Add the base directory to the path
      if (isPackaged) {
        fullPath = path.join(rootDir, baseDir, pathWithoutLeadingSlash);
      } else {
        fullPath = path.join(__dirname, '..', baseDir, pathWithoutLeadingSlash);
      }
    }
    
    console.log(`Loading content from: ${fullPath}`);
    
    // Determine the allowed directory paths that content can be loaded from
    const allowedDirPaths = [];
    
    // Add the standard path
    if (isPackaged) {
      allowedDirPaths.push(path.join(rootDir));
    } else {
      allowedDirPaths.push(path.join(__dirname, '..'));
    }
    
    // Add the custom contents directory path if it's different
    const customContentsPath = path.resolve(__dirname, '..', contentsDir);
    if (customContentsPath !== path.join(__dirname, '..', 'contents')) {
      allowedDirPaths.push(customContentsPath);
    }
    
    // Check if the path is within any of the allowed directories
    const isPathAllowed = allowedDirPaths.some(dirPath => fullPath.startsWith(dirPath));
    
    if (!isPathAllowed) {
      console.error(`Security warning: Attempted to access file outside allowed directories: ${filename}`);
      console.error(`Allowed paths: ${allowedDirPaths.join(', ')}`);
      console.error(`Requested path: ${fullPath}`);
      return null;
    }
    
    // Read the file content
    const data = await fs.readFile(fullPath, 'utf8');
    
    // Parse as JSON if requested, otherwise return raw content
    let result;
    if (parseJson) {
      result = JSON.parse(data);
    } else {
      result = data;
    }
    
    // Update cache if caching is enabled
    if (useCache) {
      configCache.set(cacheKey, {
        data: result,
        timestamp: Date.now()
      });
    }
    
    return result;
  } catch (error) {
    console.error(`Error loading ${filename}:`, error);
    return null;
  }
}

// Helper to verify API key exists for a model and provide a meaningful error
async function verifyApiKey(model, res, clientRes = null, language = 'en') {
  try {
    const apiKey = await getApiKeyForModel(model.id);
    
    if (!apiKey) {
      // Log the error in English for server logs
      console.error(`API key not found for model: ${model.id} (${model.provider}). Please set ${model.provider.toUpperCase()}_API_KEY in your environment.`);
      
      // Get a localized error message for the client
      const localizedErrorMessage = await getLocalizedError('apiKeyNotFound', 
        { provider: model.provider }, 
        language);
      
      // Send a localized error via SSE if we have a streaming connection
      if (clientRes) {
        sendSSE(clientRes, 'error', { message: localizedErrorMessage });
      }
      
      // Don't automatically send a response here, just return false
      // Let the calling code handle sending the appropriate response
      return false;
    }
    
    return apiKey;
  } catch (error) {
    console.error(`Error getting API key for model ${model.id}:`, error);
    
    // Get a localized error message for unexpected errors
    const localizedErrorMessage = await getLocalizedError('internalError',
      {},
      language);
    
    if (clientRes) {
      sendSSE(clientRes, 'error', { message: localizedErrorMessage });
    }
    
    return false;
  }
}

// --- API Endpoints ---

// GET /api/apps - Fetch all available apps
app.get('/api/apps', async (req, res) => {
  try {
    const apps = await loadUnifiedContent('config/apps.json');
    if (!apps) {
      return res.status(500).json({ error: 'Failed to load apps configuration' });
    }
    res.json(apps);
  } catch (error) {
    console.error('Error fetching apps:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// GET /api/apps/{appId} - Fetch specific app details
app.get('/api/apps/:appId', async (req, res) => {
  try {
    const { appId } = req.params;
    const language = req.headers['accept-language']?.split(',')[0] || 'en'; // Extract language from headers
    const apps = await loadUnifiedContent('config/apps.json');
    
    if (!apps) {
      return res.status(500).json({ error: 'Failed to load apps configuration' });
    }
    
    const app = apps.find(a => a.id === appId);
    if (!app) {
      const errorMessage = await getLocalizedError('appNotFound', {}, language);
      return res.status(404).json({ error: errorMessage });
    }
    
    res.json(app);
  } catch (error) {
    console.error('Error fetching app details:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// GET /api/models - Fetch all available models
app.get('/api/models', async (req, res) => {
  try {
    const models = await loadUnifiedContent('config/models.json');
    if (!models) {
      return res.status(500).json({ error: 'Failed to load models configuration' });
    }
    res.json(models);
  } catch (error) {
    console.error('Error fetching models:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// GET /api/models/{modelId} - Fetch specific model details
app.get('/api/models/:modelId', async (req, res) => {
  try {
    const { modelId } = req.params;
    const language = req.headers['accept-language']?.split(',')[0] || 'en'; // Extract language from headers
    const models = await loadUnifiedContent('config/models.json');
    
    if (!models) {
      return res.status(500).json({ error: 'Failed to load models configuration' });
    }
    
    const model = models.find(m => m.id === modelId);
    if (!model) {
      const errorMessage = await getLocalizedError('modelNotFound', {}, language);
      return res.status(404).json({ error: errorMessage });
    }
    
    res.json(model);
  } catch (error) {
    console.error('Error fetching model details:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// API endpoint to fetch page content by ID
app.get('/api/pages/:pageId', async (req, res) => {
  const { pageId } = req.params;
  const lang = req.query.lang || 'en'; // Default to English if no language specified
  
  try {
    // Load UI configuration using the unified content loader
    const uiConfig = await loadUnifiedContent('config/ui.json');
    
    if (!uiConfig || !uiConfig.pages || !uiConfig.pages[pageId]) {
      return res.status(404).json({ error: 'Page not found' });
    }
    
    // Get the file path for the requested language
    const pageConfig = uiConfig.pages[pageId];
    const langFilePath = pageConfig.filePath[lang] || pageConfig.filePath['en']; // Fallback to English
    
    if (!langFilePath) {
      return res.status(404).json({ error: 'Page content not available for the requested language' });
    }
    
    // Load the markdown content using the unified content loader
    const content = await loadUnifiedContent(langFilePath, { parseJson: false });
    
    if (!content) {
      return res.status(404).json({ error: 'Page content file not found' });
    }
    
    // Return the page content and metadata
    res.json({
      id: pageId,
      title: pageConfig.title[lang] || pageConfig.title['en'],
      content
    });
  } catch (error) {
    console.error('Error fetching page content:', error);
    res.status(500).json({ error: 'Failed to fetch page content' });
  }
});

// GET /api/models/{modelId}/chat/test - Test model chat completion without streaming
app.get('/api/models/:modelId/chat/test', async (req, res) => {
  try {
    const { modelId } = req.params;
    
    // Simple test message
    const messages = [
      { role: "user", content: "Say hello!" }
    ];

    // Load models configuration
    const models = await loadUnifiedContent('config/models.json');
    if (!models) {
      return res.status(500).json({ error: 'Failed to load models configuration' });
    }
    
    // Find the specified model
    const model = models.find(m => m.id === modelId);
    if (!model) {
      return res.status(404).json({ error: 'Model not found' });
    }

    // Get and verify API key for model
    const apiKey = await verifyApiKey(model, res, null, req.headers['accept-language']?.split(',')[0] || 'en');
    if (!apiKey) {
      return res.status(500).json({ 
        error: `API key not found for model: ${model.id} (${model.provider})`,
        provider: model.provider
      });
    }

    // Create request using appropriate adapter
    const request = createCompletionRequest(model, messages, apiKey, { stream: false });
    
    // Set up timeout for the request
    let timeoutId;
    const timeoutPromise = new Promise((_, reject) => {
      timeoutId = setTimeout(() => {
        reject(new Error(`Request timed out after ${DEFAULT_TIMEOUT/1000} seconds`));
      }, DEFAULT_TIMEOUT);
    });
    
    // Race between the fetch and the timeout
    try {
      const responsePromise = fetch(request.url, {
        method: 'POST',
        headers: request.headers,
        body: JSON.stringify(request.body)
      });
      
      const llmResponse = await Promise.race([responsePromise, timeoutPromise]);
      
      clearTimeout(timeoutId);
      
      if (!llmResponse.ok) {
        const errorBody = await llmResponse.text();
        console.error(`LLM API Error (${llmResponse.status}): ${errorBody}`);
        return res.status(llmResponse.status).json({ 
          error: `LLM API request failed with status ${llmResponse.status}`,
          details: errorBody
        });
      }
      
      // Return the complete response
      const responseData = await llmResponse.json();
      
      // Add messageId to the response for client-side feedback
      responseData.messageId = messageId;
      
      return res.json(responseData);
    } catch (fetchError) {
      clearTimeout(timeoutId);
      
      if (fetchError.message.includes('timed out')) {
        return res.status(504).json({ 
          error: 'Request timed out', 
          message: `Request to ${model.provider} API timed out after ${DEFAULT_TIMEOUT/1000} seconds`
        });
      } else {
        // Get enhanced error details for the non-streaming case
        const errorDetails = getErrorDetails(fetchError, model);
        
        return res.status(500).json({ 
          error: errorDetails.message,
          code: errorDetails.code,
          modelId: model.id,
          provider: model.provider,
          recommendation: errorDetails.recommendation,
          details: fetchError.message
        });
      }
    }
  } catch (error) {
    console.error('Error in test chat completion:', error);
    res.status(500).json({ error: 'Internal server error', message: error.message });
  }
});

// GET /api/apps/{appId}/chat/{chatId} - Stream chat responses via SSE
app.get('/api/apps/:appId/chat/:chatId', async (req, res) => {
  try {
    const { appId, chatId } = req.params;
    
    // Set up SSE headers
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    
    // Register client
    clients.set(chatId, {
      response: res,
      lastActivity: new Date(),
      appId: appId
    });
    
    // Send initial connection event
    sendSSE(res, 'connected', { chatId });
    
    // Keep the connection open
    req.on('close', () => {
      // Clean up when client disconnects
      if (clients.has(chatId)) {
        // Cancel any active request for this chat
        if (activeRequests.has(chatId)) {
          try {
            const controller = activeRequests.get(chatId);
            controller.abort();
            activeRequests.delete(chatId);
            console.log(`Aborted request for chat ID: ${chatId}`);
          } catch (e) {
            console.error(`Error aborting request for chat ID: ${chatId}`, e);
          }
        }
        
        clients.delete(chatId);
        console.log(`Client disconnected: ${chatId}`);
      }
    });
    
  } catch (error) {
    console.error('Error establishing SSE connection:', error);
    
    // If headers haven't been sent yet, return JSON error
    if (!res.headersSent) {
      return res.status(500).json({ error: 'Internal server error' });
    }
    
    // Otherwise use SSE to report error
    sendSSE(res, 'error', { message: 'Internal server error' });
    res.end();
  }
});

// POST /api/feedback - Submit user feedback for a message
app.post('/api/feedback', async (req, res) => {
  try {
    const { messageId, appId, chatId, messageContent, rating, feedback, modelId } = req.body;
    const language = req.headers['accept-language']?.split(',')[0] || 'en'; // Extract language from headers
    
    if (!messageId || !rating || !appId || !chatId) {
      const errorMessage = await getLocalizedError('missingFeedbackFields', {}, language);
      return res.status(400).json({ error: errorMessage });
    }
    
    // Get the session ID from request headers
    const userSessionId = req.headers['x-session-id'];
    
    // IMPORTANT: Use the exact messageId without any modification to ensure consistency in logs
    
    // Log the feedback to interactions log
    await logInteraction(
      "feedback",
    {
      messageId, // Use the exact messageId as received from the client
      appId,
      modelId,
      sessionId: chatId,
      userSessionId,
      responseType: 'feedback',
      feedback: {
        messageId, // Also store the same messageId in the feedback object
        rating, // 'positive' or 'negative'
        comment: feedback || '',
        contentSnippet: messageContent ? messageContent.substring(0, 300) : ''
      }
    });
    
    console.log(`Feedback received for message ${messageId} in chat ${chatId}: ${rating}`);
    
    return res.status(200).json({ success: true });
  } catch (error) {
    console.error('Error processing feedback:', error);
    return res.status(500).json({ error: 'Internal server error', message: error.message });
  }
});

// GET /api/styles  - Fetch styles text
app.get('/api/styles', async (req, res) => {
  try {
    const styles = await loadUnifiedContent('config/styles.json');
    if (!styles) {
      return res.status(500).json({ error: 'Failed to load styles configuration' });
    }
    res.json(styles);
  } catch (error) {
    console.error('Error fetching styles:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// GET /api/translations/:lang - Fetch translations for a specific language
app.get('/api/translations/:lang', async (req, res) => {
  try {
    let { lang } = req.params;
    
    // Sanitize language parameter to prevent path traversal
    // Only allow alphanumeric characters and hyphens, limit length
    if (!/^[a-zA-Z0-9-]{1,10}$/.test(lang)) {
      console.warn(`Suspicious language parameter received: ${lang}`);
      lang = 'en'; // Default to English for suspicious inputs
    }
    
    const supportedLanguages = ['en', 'de']; // Add more as needed
    
    // Handle complex language codes (e.g., 'en-US', 'en-GB', 'de-DE')
    // Extract the base language code
    const baseLanguage = lang.split('-')[0].toLowerCase();
    
    // If the requested language isn't directly supported, try falling back to the base language
    if (!supportedLanguages.includes(lang) && supportedLanguages.includes(baseLanguage)) {
      console.log(`Language '${lang}' not directly supported, falling back to '${baseLanguage}'`);
      lang = baseLanguage;
    }
    
    // Validate language parameter
    if (!supportedLanguages.includes(lang)) {
      console.log(`Language '${lang}' not supported, falling back to default language 'en'`);
      lang = 'en'; // Default fallback
    }
    
    // Load translations (corrected path to include locales directory)
    const translations = await loadUnifiedContent(`locales/${lang}.json`);
    if (!translations) {
      console.error(`Failed to load translations for language: ${lang}`);
      // Fall back to English if translation file can't be loaded
      if (lang !== 'en') {
        const enTranslations = await loadUnifiedContent('locales/en.json');
        if (enTranslations) {
          return res.json(enTranslations);
        }
      }
      return res.status(500).json({ error: `Failed to load translations for language: ${lang}` });
    }
    
    res.json(translations);
  } catch (error) {
    console.error(`Error fetching translations for language ${req.params.lang}:`, error);
    // Try to return English translations as fallback on error
    try {
      const enTranslations = await loadUnifiedContent('locales/en.json');
      if (enTranslations) {
        return res.json(enTranslations);
      }
    } catch (fallbackError) {
      console.error('Failed to load fallback translations:', fallbackError);
    }
    res.status(500).json({ error: 'Internal server error' });
  }
});

// --- UI Configuration ---

// GET /api/ui - Fetch UI configuration (title, footer, header links, disclaimer)
app.get('/api/ui', async (req, res) => {
  try {
    const uiConfig = await loadUnifiedContent('config/ui.json');
    if (!uiConfig) {
      return res.status(500).json({ error: 'Failed to load UI configuration' });
    }
    res.json(uiConfig);
  } catch (error) {
    console.error('Error fetching UI configuration:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// POST /api/apps/{appId}/chat/{chatId} - Process chat messages
app.post('/api/apps/:appId/chat/:chatId', async (req, res) => {
  try {
    const { appId, chatId } = req.params;
    const { messages, modelId, temperature, style, outputFormat, language, maxTokens } = req.body;
    
    // Extract client language from request headers or use provided language in the request
    const clientLanguage = language || req.headers['accept-language']?.split(',')[0] || 'en';
    
    // Check for messageId in the last user message - this is our consistent ID for tracking
    // This is sent from the client in the messageForAPI object
    let messageId = null;
    if (messages && Array.isArray(messages) && messages.length > 0) {
      const lastMessage = messages[messages.length - 1];
      if (lastMessage && lastMessage.messageId) {
        messageId = lastMessage.messageId;
        console.log(`Using client-provided messageId: ${messageId}`);
      }
    }
    
    // Get the session ID from request headers
    const userSessionId = req.headers['x-session-id'];
    
    // Log the language being used for debugging
    console.log(`Processing chat with language: ${clientLanguage}`);
    
    if (!messages || !Array.isArray(messages)) {
      const errorMessage = await getLocalizedError('messagesRequired', {}, clientLanguage);
      return res.status(400).json({ error: errorMessage });
    }

    // Track the session for analytics
    trackSession(chatId, { appId, userSessionId, userAgent: req.headers['user-agent'] });
    
    // Check if client has an SSE connection
    if (!clients.has(chatId)) {
      console.log(`No active SSE connection for chat ID: ${chatId}. Creating response without streaming.`);
      
      // Process without streaming if no SSE connection exists
      // Load app details
      const apps = await loadUnifiedContent('config/apps.json');
      if (!apps) {
        return res.status(500).json({ error: 'Failed to load apps configuration' });
      }
      
      const app = apps.find(a => a.id === appId);
      if (!app) {
        const errorMessage = await getLocalizedError('appNotFound', {}, clientLanguage);
        return res.status(404).json({ error: errorMessage });
      }
      
      // Load models
      const models = await loadUnifiedContent('config/models.json');
      if (!models) {
        return res.status(500).json({ error: 'Failed to load models configuration' });
      }
      
      // Determine which model to use
      const model = models.find(m => m.id === (modelId || app.preferredModel));
      if (!model) {
        const errorMessage = await getLocalizedError('modelNotFound', {}, clientLanguage);
        return res.status(404).json({ error: errorMessage });
      }
      
      // Prepare messages with proper formatting
      const llmMessages = await processMessageTemplates(messages, app, style, outputFormat, clientLanguage);
      
      // Log the interaction before sending to LLM - use the exact client-provided messageId
      await logInteraction(
        "chat_request",
      {
        messageId, // Use client-provided ID
        appId,
        modelId: model.id,
        sessionId: chatId,
        userSessionId,
        messages: llmMessages,
        options: {
          temperature,
          maxTokens: parseInt(maxTokens) || app.tokenLimit || 1024,
          style,
          outputFormat,
          language: clientLanguage,
          streaming: false
        }
      });
      
      // Get and verify API key for model
      const apiKey = await verifyApiKey(model, res, null, clientLanguage);
      if (!apiKey) {
        const errorMessage = await getLocalizedError('apiKeyNotFound', { provider: model.provider }, clientLanguage);
        return res.status(500).json({ error: errorMessage });
      }

      const requestedTokens = parseInt(maxTokens) || app.tokenLimit || 1024;
      const modelTokenLimit = model.tokenLimit || requestedTokens;
      const finalTokens = Math.min(requestedTokens, modelTokenLimit);
      
      // Create request without streaming
      const request = createCompletionRequest(model, llmMessages, apiKey, { 
        temperature: parseFloat(temperature) || app.preferredTemperature || 0.7,
        maxTokens: finalTokens,
        stream: false
      });
      
      // Set up timeout for the request
      let timeoutId;
      const timeoutPromise = new Promise((_, reject) => {
        timeoutId = setTimeout(() => {
          reject(new Error(`Request timed out after ${DEFAULT_TIMEOUT/1000} seconds`));
        }, DEFAULT_TIMEOUT);
      });
      
      // Execute request to LLM API with timeout
      try {
        const responsePromise = fetch(request.url, {
          method: 'POST',
          headers: request.headers,
          body: JSON.stringify(request.body)
        });
        
        const llmResponse = await Promise.race([responsePromise, timeoutPromise]);
        
        clearTimeout(timeoutId);
        
        if (!llmResponse.ok) {
          const errorBody = await llmResponse.text();
          console.error(`LLM API Error (${llmResponse.status}): ${errorBody}`);

          // Log error interaction
          await logInteraction(
            "chat_error",
          {
            messageId, // Use the same ID to link these logs
            appId,
            modelId: model.id,
            sessionId: chatId,
            userSessionId,
            messages: llmMessages,
            options: {
              temperature,
              style,
              outputFormat,
              language: clientLanguage,
              streaming: false
            },
            responseType: 'error',
            error: {
              message: `LLM API request failed with status ${llmResponse.status}`,
              code: llmResponse.status.toString()
            }
          });
          
          return res.status(llmResponse.status).json({ 
            error: `LLM API request failed with status ${llmResponse.status}`,
            details: errorBody
          });
        }
        
        // Return the complete response
        const responseData = await llmResponse.json();
        
        // Add messageId to the response for client-side feedback
        responseData.messageId = messageId;
        
        // Extract and log the model's response
        let aiResponse = '';
        if (responseData.choices && responseData.choices.length > 0) {
          aiResponse = responseData.choices[0].message?.content || '';
        }

        // Log successful interaction with response
        await logInteraction(
          "chat_response",
        {
          messageId, // Use the same ID to link these logs
          appId,
          modelId: model.id,
          sessionId: chatId,
          userSessionId,
          messages: llmMessages,
          options: {
            temperature,
            style,
            outputFormat,
            language: clientLanguage,
            streaming: false
          },
          responseType: 'success',
          response: aiResponse.substring(0, 1000) // Truncate long responses
        });
        
        return res.json(responseData);
      } catch (fetchError) {
        clearTimeout(timeoutId);
        
        if (fetchError.message.includes('timed out')) {
          // Log timeout error
          await logInteraction(
            "chat_error",
          {
            messageId, // Use the same ID to link these logs
            appId,
            modelId: model.id,
            sessionId: chatId,
            userSessionId,
            messages: llmMessages,
            options: {
              temperature,
              style, 
              outputFormat,
              language: clientLanguage,
              streaming: false
            },
            responseType: 'error',
            error: {
              message: `Request timed out after ${DEFAULT_TIMEOUT/1000} seconds`,
              code: 'TIMEOUT'
            }
          });
          
          return res.status(504).json({ 
            error: 'Request timed out', 
            message: `Request to ${model.provider} API timed out after ${DEFAULT_TIMEOUT/1000} seconds`
          });
        } else {
          // Get enhanced error details for the non-streaming case
          const errorDetails = getErrorDetails(fetchError, model);
          
          // Log detailed error
          await logInteraction(
            "chat_error",
          {
            messageId, // Use the same ID to link these logs
            appId,
            modelId: model.id,
            sessionId: chatId,
            userSessionId,
            messages: llmMessages,
            options: {
              temperature,
              style,
              outputFormat,
              language: clientLanguage,
              streaming: false
            },
            responseType: 'error',
            error: {
              message: errorDetails.message,
              code: errorDetails.code
            }
          });
          
          return res.status(500).json({ 
            error: errorDetails.message,
            code: errorDetails.code,
            modelId: model.id,
            provider: model.provider,
            recommendation: errorDetails.recommendation,
            details: fetchError.message
          });
        }
      }
    } else {
      // If we have an SSE connection, stream the response
      const clientRes = clients.get(chatId).response;
      
      // Update last activity timestamp
      clients.set(chatId, {
        ...clients.get(chatId),
        lastActivity: new Date()
      });
      
      // Load app details
      const apps = await loadUnifiedContent('config/apps.json');
      if (!apps) {
        const errorMessage = await getLocalizedError('internalError', {}, clientLanguage);
        sendSSE(clientRes, 'error', { message: errorMessage });
        return res.json({ status: 'error', message: errorMessage });
      }
      
      const app = apps.find(a => a.id === appId);
      if (!app) {
        const errorMessage = await getLocalizedError('appNotFound', {}, clientLanguage);
        sendSSE(clientRes, 'error', { message: errorMessage });
        return res.json({ status: 'error', message: errorMessage });
      }
      
      // Load models
      const models = await loadUnifiedContent('config/models.json');
      if (!models) {
        const errorMessage = await getLocalizedError('internalError', {}, clientLanguage);
        sendSSE(clientRes, 'error', { message: errorMessage });
        return res.json({ status: 'error', message: errorMessage });
      }
      
      console.log(`Using modelId: ${modelId} || ${app.preferredModel}`);
      // Determine which model to use
      const model = models.find(m => m.id === (modelId || app.preferredModel));
      if (!model) {
        const errorMessage = await getLocalizedError('modelNotFound', {}, clientLanguage);
        sendSSE(clientRes, 'error', { message: errorMessage });
        return res.json({ status: 'error', message: errorMessage });
      }
      
      // Prepare messages with proper formatting
      const llmMessages = await processMessageTemplates(messages, app, style, outputFormat, clientLanguage);
      
      // Log the interaction before sending to LLM
      await logInteraction(
        "chat_request",
      {
        messageId, // Use client-provided ID
        appId,
        modelId: model.id,
        sessionId: chatId,
        userSessionId,
        messages: llmMessages,
        options: {
          temperature,
          style,
          outputFormat,
          language: clientLanguage,
          streaming: true
        }
      });
      
      // Get and verify API key with proper error handling for SSE
      const apiKey = await verifyApiKey(model, null, clientRes, clientLanguage);
      if (!apiKey) {
        // Log the API key error
        await logInteraction(
          "chat_error",
        {
          messageId, // Use the same ID to link these logs
          appId,
          modelId: model.id,
          sessionId: chatId,
          userSessionId,
          messages: llmMessages,
          options: {
            temperature,
            style,
            outputFormat,
            language: clientLanguage,
            streaming: true
          },
          responseType: 'error',
          error: {
            message: `API key not found for model: ${model.id}`,
            code: 'API_KEY_NOT_FOUND'
          }
        });
        
        // Already sent error via SSE, just return response to the HTTP request
        return res.json({ status: 'error', message: `API key not found for model: ${model.id}` });
      }
      
      // Create request using appropriate adapter
      // Ensure maxTokens doesn't exceed model's token limit
      const requestedTokens = parseInt(maxTokens) || app.tokenLimit || 1024;
      const modelTokenLimit = model.tokenLimit || requestedTokens;
      const finalTokens = Math.min(requestedTokens, modelTokenLimit);
      
      const request = createCompletionRequest(model, llmMessages, apiKey, { 
        temperature: parseFloat(temperature) || app.preferredTemperature || 0.7,
        maxTokens: finalTokens,
        stream: true
      });
      
      // Send processing event
      sendSSE(clientRes, 'processing', { message: 'Processing your request...' });
      
      // Set up abort controller for this request
      const controller = new AbortController();
      activeRequests.set(chatId, controller);
      
      // Set up timeout for the request
      const timeoutId = setTimeout(async () => {
        console.log(`Request timeout for chat ${chatId}`);
        controller.abort();
        const errorMessage = await getLocalizedError('requestTimeout', { timeout: DEFAULT_TIMEOUT/1000 }, clientLanguage);
        sendSSE(clientRes, 'error', { 
          message: errorMessage 
        });
        activeRequests.delete(chatId);
      }, DEFAULT_TIMEOUT);
      
      // Execute request to LLM API in the background
      fetch(request.url, {
        method: 'POST',
        headers: request.headers,
        body: JSON.stringify(request.body),
        signal: controller.signal
      }).then(async (llmResponse) => {
        // Clear timeout as we got a response
        clearTimeout(timeoutId);
        
        if (!llmResponse.ok) {
          // Handle error case
          const errorBody = await llmResponse.text();
          console.error(`LLM API Error (${llmResponse.status}): ${errorBody}`);
          let errorMessage = await getLocalizedError('llmApiError', { status: llmResponse.status }, clientLanguage);
          
          // Provide more helpful error messages for common errors
          if (llmResponse.status === 401) {
            errorMessage = await getLocalizedError('authenticationFailed', { provider: model.provider }, clientLanguage);
          } else if (llmResponse.status === 429) {
            errorMessage = await getLocalizedError('rateLimitExceeded', { provider: model.provider }, clientLanguage);
          } else if (llmResponse.status >= 500) {
            errorMessage = await getLocalizedError('serviceError', { provider: model.provider }, clientLanguage);
          }
          
          // Log the LLM error
          await logInteraction(
            "chat_error",
          {
            messageId, // Use the same ID to link these logs
            appId,
            modelId: model.id,
            sessionId: chatId,
            userSessionId,
            messages: llmMessages,
            options: {
              temperature,
              style,
              outputFormat,
              language: clientLanguage,
              streaming: true
            },
            responseType: 'error',
            error: {
              message: errorMessage,
              code: llmResponse.status.toString(),
              details: errorBody
            }
          });
          
          sendSSE(clientRes, 'error', { message: errorMessage, details: errorBody });
          activeRequests.delete(chatId);
          return;
        }
        
        // Stream the response back to the client
        const reader = llmResponse.body.getReader();
        const decoder = new TextDecoder();
        
        // Collect the entire response for logging
        let fullResponse = '';
        
        try {
          while (true) {
            const { done, value } = await reader.read();
            
            // Check if client is still connected
            if (!clients.has(chatId)) {
              reader.cancel();
              break;
            }
            
            if (done) break;
            
            // Decode the chunk and add to buffer
            const chunk = decoder.decode(value, { stream: true });
            
            // Process the chunk with the appropriate adapter
            const result = processResponseBuffer(model.provider, chunk);
            
            // Send any extracted content to the client
            if (result && result.content && result.content.length > 0) {
              for (const textContent of result.content) {
                sendSSE(clientRes, 'chunk', { content: textContent });
                // Accumulate the full response for logging
                fullResponse += textContent;
              }
            }
            
            // Handle errors if any occurred during processing
            if (result && result.error) {
              // Log processing error
              await logInteraction(
                "chat_error",
              {
                messageId, // Use the same ID to link these logs
                appId,
                modelId: model.id,
                sessionId: chatId,
                userSessionId,
                messages: llmMessages,
                options: {
                  temperature,
                  style,
                  outputFormat,
                  language: clientLanguage,
                  streaming: true
                },
                responseType: 'error',
                error: {
                  message: result.errorMessage || 'Error processing response',
                  code: 'PROCESSING_ERROR'
                },
                response: fullResponse // Include any partial response received before the error
              });
              
              sendSSE(clientRes, 'error', { message: result.errorMessage || 'Error processing response' });
              break;
            }
            
            // Check for completion
            if (result && result.complete) {
              sendSSE(clientRes, 'done', {});
              
              // Log the completed interaction with the full response
              await logInteraction(
                "chat_response",
                {
                messageId, // Use the same ID to link these logs
                appId,
                modelId: model.id,
                sessionId: chatId,
                userSessionId,
                messages: llmMessages,
                options: {
                  temperature,
                  style,
                  outputFormat,
                  language: clientLanguage,
                  streaming: true
                },
                responseType: 'success',
                response: fullResponse
              });
              
              break; // Stop processing more chunks
            }
          }
        } catch (error) {
          if (error.name === 'AbortError') {
            console.log(`Request aborted for chat ${chatId}`);
            // Don't send an error event if timeout already sent one
          } else {
            console.error('Error processing response stream:', error);
            const errorMessage = await getLocalizedError('responseStreamError', { error: error.message }, clientLanguage);
            sendSSE(clientRes, 'error', { message: errorMessage });
          }
        } finally {
          activeRequests.delete(chatId);
        }
      }).catch(async (error) => {
        clearTimeout(timeoutId);
        
        if (error.name === 'AbortError') {
          console.log(`Request aborted for chat ${chatId}`);
          // Don't log or send event if it was an intentional abort
        } else {
          console.error('Error executing LLM request:', error);
          
          // Get enhanced error details
          const errorDetails = getErrorDetails(error, model);
          
          // Check for connection refused errors
          if (errorDetails.code === 'ECONNREFUSED') {
            const errorMessage = await getLocalizedError('connectionRefused', 
              { provider: model.provider, model: model.id }, 
              clientLanguage);
            
            // Log the connection error
            logInteraction(
              "chat_error",
            {
              messageId, // Use the same ID to link these logs
              appId,
              modelId: model.id,
              sessionId: chatId,
              userSessionId,
              messages: llmMessages,
              options: {
                temperature,
                style,
                outputFormat,
                language: clientLanguage,
                streaming: true
              },
              responseType: 'error',
              error: {
                message: errorMessage,
                code: errorDetails.code
              }
            }).catch(logError => {
              console.error('Error logging interaction error:', logError);
            });
            
            // Send localized error message to the client
            sendSSE(clientRes, 'error', { 
              message: errorMessage,
              modelId: model.id,
              provider: model.provider,
              recommendation: errorDetails.recommendation
            });
          } else {
            // Handle other types of errors with existing code
            logInteraction(
              "chat_error",
            {
              messageId, // Use the same ID to link these logs
              appId,
              modelId: model.id,
              sessionId: chatId,
              userSessionId,
              messages: llmMessages,
              options: {
                temperature,
                style,
                outputFormat,
                language: clientLanguage,
                streaming: true
              },
              responseType: 'error',
              error: {
                message: errorDetails.message,
                code: errorDetails.code
              }
            }).catch(logError => {
              console.error('Error logging interaction error:', logError);
            });
            
            // Send a more helpful error message to the client
            const errorMessage = {
              message: errorDetails.message,
              modelId: model.id,
              provider: model.provider,
              recommendation: errorDetails.recommendation,
              details: error.message
            };
            
            sendSSE(clientRes, 'error', errorMessage);
          }
        }
        
        activeRequests.delete(chatId);
      });
      
      // Return immediate response to the POST request
      return res.json({ status: 'streaming', chatId });
    }
    
  } catch (error) {
    console.error('Error in app chat:', error);
    return res.status(500).json({ error: 'Internal server error', message: error.message });
  }
});

// POST /api/apps/{appId}/chat/{chatId}/stop - Stop a streaming chat session
app.post('/api/apps/:appId/chat/:chatId/stop', (req, res) => {
  const { chatId } = req.params;
  
  if (clients.has(chatId)) {
    // Abort any ongoing request
    if (activeRequests.has(chatId)) {
      try {
        const controller = activeRequests.get(chatId);
        controller.abort();
        activeRequests.delete(chatId);
        console.log(`Aborted request for chat ID: ${chatId}`);
      } catch (e) {
        console.error(`Error aborting request for chat ID: ${chatId}`, e);
      }
    }
    
    const client = clients.get(chatId);
    
    // Send a final event indicating the stream was stopped
    sendSSE(client.response, 'stopped', { message: 'Chat stream stopped by client' });
    
    // End the response stream
    client.response.end();
    
    // Remove the client from the map
    clients.delete(chatId);
    
    console.log(`Chat stream stopped for chat ID: ${chatId}`);
    return res.status(200).json({ success: true, message: 'Chat stream stopped' });
  }
  
  return res.status(404).json({ success: false, message: 'Chat session not found' });
});

// GET /api/apps/{appId}/chat/{chatId}/status - Check if a chat session is active
app.get('/api/apps/:appId/chat/:chatId/status', (req, res) => {
  const { chatId } = req.params;
  
  if (clients.has(chatId)) {
    return res.status(200).json({ 
      active: true, 
      lastActivity: clients.get(chatId).lastActivity,
      processing: activeRequests.has(chatId)
    });
  }
  
  return res.status(200).json({ active: false });
});

// --- Session Management ---

// POST /api/session/start - Log a new user session when the application loads
app.post('/api/session/start', async (req, res) => {
  try {
    const { sessionId, type, metadata } = req.body;
    
    if (!sessionId) {
      return res.status(400).json({ error: 'Session ID is required' });
    }
    
    // Add IP and user agent data from the request
    const enrichedMetadata = {
      ...metadata,
      userAgent: req.headers['user-agent'] || metadata?.userAgent || 'unknown',
      ipAddress: req.ip || req.connection.remoteAddress || 'unknown',
      language: req.headers['accept-language'] || metadata?.language || 'en',
      referrer: req.headers['referer'] || metadata?.referrer || 'direct'
    };
    
    // Log the application initialization with session ID
    console.log(`[APP LOADED] New session started: ${sessionId} | IP: ${enrichedMetadata.ipAddress.split(':').pop()}`);
    
    // Store in log file
    await logNewSession(sessionId, 'app_loaded', enrichedMetadata);
    
    res.status(200).json({ success: true });
  } catch (error) {
    console.error('Error logging session start:', error);
    res.status(500).json({ error: 'Failed to log session start' });
  }
});

// Helper function to extract messages and format them
async function processMessageTemplates(messages, app, style = null, outputFormat = null, language = 'en') {
  // Log the language being used for localization 
  console.log(`Using language '${language}' for message templates`);
  
  // Copy messages to avoid modifying the original
  let llmMessages = [...messages].map(msg => {
    // Process user messages with prompt templates and variables
    if (msg.role === 'user' && msg.promptTemplate && msg.variables) {
      // Start with the prompt template or original content if no template
      // Handle localized content in prompt templates with the specified language
      let processedContent = typeof msg.promptTemplate === 'object'
        ? getLocalizedContent(msg.promptTemplate, language)
        : (msg.promptTemplate || msg.content);
      
      if (typeof processedContent !== 'string') {
        console.log(`Type of processedContent is not string: ${typeof processedContent}`);
        processedContent = String(processedContent || '');
      }
      
      // Ensure the original user content is available as {{content}} variable
      const variables = { ...msg.variables, content: msg.content };
      
      // Replace variable placeholders in the prompt
      if (variables && Object.keys(variables).length > 0) {
        for (const [key, value] of Object.entries(variables)) {
          // Ensure value is a string before using replace
          const strValue = typeof value === 'string' ? value : String(value || '');
          processedContent = processedContent.replace(`{{${key}}}`, strValue);
        }
      }
      
      // Create processed message, only including imageData and fileData if they exist and aren't null
      const processedMsg = { 
        role: 'user', 
        content: processedContent
      };
      
      // Only include imageData if it actually exists and isn't null
      if (msg.imageData) {
        processedMsg.imageData = msg.imageData;
      }
      
      // Only include fileData if it actually exists and isn't null
      if (msg.fileData) {
        processedMsg.fileData = msg.fileData;
      }
      
      return processedMsg;
    }
    
    // For non-user messages or messages without templates
    const processedMsg = { 
      role: msg.role, 
      content: msg.content
    };
    
    // Only include imageData if it actually exists and isn't null
    if (msg.imageData) {
      processedMsg.imageData = msg.imageData;
    }
    
    // Only include fileData if it actually exists and isn't null
    if (msg.fileData) {
      processedMsg.fileData = msg.fileData;
    }
    
    return processedMsg;
  });
  
  // Check for variables from the most recent message that might need to be applied to system prompt
  let userVariables = {};
  const lastUserMessage = messages.findLast(msg => msg.role === 'user');
  if (lastUserMessage && lastUserMessage.variables) {
    userVariables = lastUserMessage.variables;
  }
  
  // Apply prompt template if the app has one and there's no system message
  if (app && !llmMessages.some(msg => msg.role === 'system')) {
    // Add application system prompt with style modifications if applicable
    // Handle localized content in system prompt with the specified language
    let systemPrompt = typeof app.system === 'object'
      ? getLocalizedContent(app.system, language)
      : (app.system || '');
    
    if (typeof systemPrompt !== 'string') {
      console.log(`Type of systemPrompt is not string: ${typeof systemPrompt}`);
      systemPrompt = String(systemPrompt || '');
    }
    
    // Replace variable placeholders in the system prompt
    if (Object.keys(userVariables).length > 0) {
      for (const [key, value] of Object.entries(userVariables)) {
        // Skip properties that are functions or objects
        if (typeof value === 'function' || (typeof value === 'object' && value !== null)) {
          continue;
        }
        
        // Replace placeholders in the system prompt
        const strValue = String(value || '');
        systemPrompt = systemPrompt.replace(`{{${key}}}`, strValue);
      }
    }
    
    // Load file source content if app has a sourcePath (for FAQ bots, etc.)
    if (app.sourcePath && systemPrompt.includes('{{source}}')) {
      // Get the file path - either from user variables (if provided) or from app config
      const sourcePath = userVariables.source_path || app.sourcePath;
      
      console.log(`Loading source content from file: ${sourcePath}`);
      try {
        // Load the file content using unified content loader
        const sourceContent = await loadUnifiedContent(sourcePath.replace(/^\//, ''), { parseJson: false });
        
        // Replace the {{source}} placeholder with the file content
        systemPrompt = systemPrompt.replace('{{source}}', sourceContent || '');
        console.log(`Loaded source content (${sourceContent?.length || 0} characters)`);
      } catch (error) {
        console.error(`Error loading source content from ${sourcePath}:`, error);
        systemPrompt = systemPrompt.replace('{{source}}', 
          `Error loading content from ${sourcePath}: ${error.message}. Please check the file path and try again.`);
      }
    }
    
    // Apply style modifications if specified
    if (style) {
      try {
        const styles = await loadUnifiedContent('config/styles.json');
        if (styles && styles[style]) {
          systemPrompt += `\n\n${styles[style]}`;
        }
      } catch (err) {
        console.error('Error loading styles:', err);
      }
    }
    
    // Add output format instructions if specified
    if (outputFormat === 'markdown') {
      systemPrompt += '\n\nPlease format your response using Markdown syntax for better readability.';
    } else if (outputFormat === 'html') {
      systemPrompt += '\n\nPlease format your response using HTML tags for better readability and structure.';
    }
    
    llmMessages.unshift({ role: 'system', content: systemPrompt });
  }
  
  return llmMessages;
}

// Cleanup inactive clients every minute
setInterval(() => {
  const now = new Date();
  for (const [chatId, client] of clients.entries()) {
    if (now - client.lastActivity > 5 * 60 * 1000) { // 5 minutes
      // Abort any ongoing request
      if (activeRequests.has(chatId)) {
        try {
          const controller = activeRequests.get(chatId);
          controller.abort();
          activeRequests.delete(chatId);
        } catch (e) {
          console.error(`Error aborting request for chat ID: ${chatId}`, e);
        }
      }
      
      client.response.end();
      clients.delete(chatId);
      console.log(`Removed inactive client: ${chatId}`);
    }
  }
}, 60 * 1000);

// Fall back to client-side routing for SPA
app.get('*', (req, res) => {
  // Determine the index.html path based on packaging mode
  let indexPath;
  if (isPackaged) {
    indexPath = path.join(rootDir, 'public/index.html');
  } else if (process.env.NODE_ENV === 'production') {
    indexPath = path.join(__dirname, '../public/index.html');
  } else {
    indexPath = path.join(__dirname, '../client/dist/index.html');
  }
  
  console.log(`Serving SPA from: ${indexPath}`);
  res.sendFile(indexPath);
});

// Validate API keys at startup
validateApiKeys();

// Check for SSL configuration
let server;
if (process.env.SSL_KEY && process.env.SSL_CERT) {
  try {
    // Import synchronous file system operations for SSL cert loading
    const fsSync = await import('fs');
    
    // SSL configuration
    const httpsOptions = {
      key: fsSync.readFileSync(process.env.SSL_KEY),
      cert: fsSync.readFileSync(process.env.SSL_CERT),
      // Add macOS-specific options for socket reuse
      ...(process.platform === 'darwin' ? serverOptions : {})
    };
    
    // Add CA certificate if provided
    if (process.env.SSL_CA) {
      httpsOptions.ca = fsSync.readFileSync(process.env.SSL_CA);
    }
    
    // Create HTTPS server
    server = https.createServer(httpsOptions, app);
    console.log(`Starting HTTPS server with SSL certificate from ${process.env.SSL_CERT}`);
  } catch (error) {
    console.error('Error setting up HTTPS server:', error);
    console.log('Falling back to HTTP server');
    server = http.createServer(serverOptions, app);
  }
} else {
  // Create regular HTTP server with socket reuse options
  server = http.createServer(serverOptions, app);
  console.log('Starting HTTP server (no SSL configuration provided)');
}

// Start server
server.listen(PORT, HOST, () => {
  const protocol = server instanceof https.Server ? 'https' : 'http';
  console.log(`Server is running on ${protocol}://${HOST}:${PORT}`);
  console.log(`Open ${protocol}://${HOST}:${PORT} in your browser to use AI Hub Apps`);
});

// Import necessary modules
const fsSync = await import('fs');
const pathSync = await import('path');