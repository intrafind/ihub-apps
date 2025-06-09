// Import required modules
import express from 'express';
import cors from 'cors';
import fs from 'fs/promises';
import path from 'path';
import dotenv from 'dotenv';
import http from 'http';
import https from 'https';
import { loadJson, loadText } from './configLoader.js';
import { getRootDir } from './pathUtils.js';

// Import adapters and utilities
import { getApiKeyForModel, getErrorDetails, logInteraction, trackSession, logNewSession } from "./utils.js";
import { sendSSE, clients, activeRequests } from "./sse.js";
import registerChatRoutes from "./routes/chatRoutes.js";
import registerStaticRoutes from "./routes/staticRoutes.js";
import { loadTools, runTool } from './toolLoader.js';

// Initialize environment variables
dotenv.config();

// Determine if we're running from a packaged binary
// Either via process.pkg (when using pkg directly) or APP_ROOT_DIR env var (our shell script approach)
const isPackaged = process.pkg !== undefined || process.env.APP_ROOT_DIR !== undefined;

// Resolve the application root directory
const rootDir = getRootDir();
if (isPackaged) {
  console.log(`Running in packaged binary mode with APP_ROOT_DIR: ${rootDir}`);
} else {
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
    const translations = await loadJson(`locales/${language}.json`);
    
    if (!translations || !translations.serverErrors || !translations.serverErrors[errorKey]) {
      // Try English as fallback
      if (language !== 'en') {
        const enTranslations = await loadJson('locales/en.json');
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
    const apps = await loadJson('config/apps.json');
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
    const apps = await loadJson('config/apps.json');
    
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
    const models = await loadJson('config/models.json');
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
    const models = await loadJson('config/models.json');
    
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

// GET /api/tools - Retrieve all available tools
app.get('/api/tools', async (req, res) => {
  try {
    const tools = await loadTools();
    res.json(tools);
  } catch (error) {
    console.error('Error fetching tools:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});
// Dynamic tool execution endpoint
app.all('/api/tools/:toolId', async (req, res) => {
  const { toolId } = req.params;
  const params = req.method === 'GET' ? req.query : req.body;
  try {
    const result = await runTool(toolId, params);
    res.json(result);
  } catch (error) {
    console.error(`Tool ${toolId} error:`, error);
    res.status(500).json({ error: 'Tool execution failed' });
  }
});

// API endpoint to fetch page content by ID
app.get('/api/pages/:pageId', async (req, res) => {
  const { pageId } = req.params;
  const lang = req.query.lang || 'en'; // Default to English if no language specified
  
  try {
    // Load UI configuration using the unified content loader
    const uiConfig = await loadJson('config/ui.json');
    
    if (!uiConfig || !uiConfig.pages || !uiConfig.pages[pageId]) {
      return res.status(404).json({ error: 'Page not found' });
    }
    
    // Get the file path for the requested language
    const pageConfig = uiConfig.pages[pageId];
    const langFilePath = pageConfig.filePath[lang] || pageConfig.filePath['en']; // Fallback to English
    
    if (!langFilePath) {
      return res.status(404).json({ error: 'Page content not available for the requested language' });
    }
    
    // Load the markdown content
    const content = await loadText(langFilePath);
    
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
registerChatRoutes(app, { verifyApiKey, processMessageTemplates, getLocalizedError, DEFAULT_TIMEOUT });


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

// Register static file and SPA routes after API routes
registerStaticRoutes(app, { isPackaged, rootDir });

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
        // Load the file content
        const sourceContent = await loadText(sourcePath.replace(/^\//, ''));
        
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
        const styles = await loadJson('config/styles.json');
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

