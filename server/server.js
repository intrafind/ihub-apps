// Import required modules
import express from 'express';
import cors from 'cors';
import fs from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';
import dotenv from 'dotenv';

// Import adapters and utilities
import { createCompletionRequest, processResponseBuffer, formatMessages } from './adapters/index.js';
import { sendSSE, getApiKeyForModel } from './utils.js';

// Initialize environment variables
dotenv.config();

// Set up directory paths
const __filename = fileURLToPath(import.meta.url);
const { dirname } = path;
const __dirname = dirname(__filename);

// Create Express application
const app = express();
const PORT = process.env.PORT || 3000;

// Configure request timeouts
const DEFAULT_TIMEOUT = parseInt(process.env.REQUEST_TIMEOUT || '60000', 10); // 60 seconds default

// Store active client connections
const clients = new Map();
const activeRequests = new Map();

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
app.use(express.json());
app.use(express.static(path.join(__dirname, '../client/dist')));

// Helper function to load configuration files
async function loadConfig(filename) {
  try {
    const filePath = path.join(__dirname, '../config', filename);
    const data = await fs.readFile(filePath, 'utf8');
    return JSON.parse(data);
  } catch (error) {
    console.error(`Error loading ${filename}:`, error);
    return null;
  }
}

// Helper to verify API key exists for a model and provide a meaningful error
function verifyApiKey(model, res, clientRes = null) {
  const apiKey = getApiKeyForModel(model.id);
  
  if (!apiKey) {
    const errorMessage = `API key not found for model: ${model.id} (${model.provider}). Please set ${model.provider.toUpperCase()}_API_KEY in your environment.`;
    console.error(errorMessage);
    
    if (clientRes) {
      sendSSE(clientRes, 'error', { message: errorMessage });
    }
    
    // Don't automatically send a response here, just return false
    // Let the calling code handle sending the appropriate response
    return false;
  }
  
  return apiKey;
}

// --- API Endpoints ---

// GET /api/apps - Fetch all available apps
app.get('/api/apps', async (req, res) => {
  try {
    const apps = await loadConfig('apps.json');
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
    const apps = await loadConfig('apps.json');
    
    if (!apps) {
      return res.status(500).json({ error: 'Failed to load apps configuration' });
    }
    
    const app = apps.find(a => a.id === appId);
    if (!app) {
      return res.status(404).json({ error: 'App not found' });
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
    const models = await loadConfig('models.json');
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
    const models = await loadConfig('models.json');
    
    if (!models) {
      return res.status(500).json({ error: 'Failed to load models configuration' });
    }
    
    const model = models.find(m => m.id === modelId);
    if (!model) {
      return res.status(404).json({ error: 'Model not found' });
    }
    
    res.json(model);
  } catch (error) {
    console.error('Error fetching model details:', error);
    res.status(500).json({ error: 'Internal server error' });
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
    const models = await loadConfig('models.json');
    if (!models) {
      return res.status(500).json({ error: 'Failed to load models configuration' });
    }
    
    // Find the specified model
    const model = models.find(m => m.id === modelId);
    if (!model) {
      return res.status(404).json({ error: 'Model not found' });
    }

    // Get and verify API key for model
    const apiKey = verifyApiKey(model, res);
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
      
      const response = await Promise.race([responsePromise, timeoutPromise]);
      
      clearTimeout(timeoutId);
      
      if (!response.ok) {
        const errorText = await response.text();
        console.error(`${model.provider} API error:`, errorText);
        return res.status(response.status).json({ 
          error: `${model.provider} API error: ${response.status}`,
          details: errorText
        });
      }
      
      const responseData = await response.json();
      res.json({ success: true, response: responseData });
    } catch (fetchError) {
      clearTimeout(timeoutId);
      
      if (fetchError.message.includes('timed out')) {
        return res.status(504).json({ 
          error: 'Request timed out', 
          message: `Request to ${model.provider} API timed out after ${DEFAULT_TIMEOUT/1000} seconds`
        });
      } else {
        throw fetchError; // Re-throw for the catch block below
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

// GET /api/styles  - Fetch styles text
app.get('/api/styles', async (req, res) => {
  try {
    const styles = await loadConfig('styles.json');
    if (!styles) {
      return res.status(500).json({ error: 'Failed to load styles configuration' });
    }
    res.json(styles);
  } catch (error) {
    console.error('Error fetching styles:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// GET /api/ui - Fetch UI configuration (title, footer, header links, disclaimer)
app.get('/api/ui', async (req, res) => {
  try {
    const uiConfig = await loadConfig('ui.json');
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
    const { messages, modelId, temperature, style, outputFormat } = req.body;
    
    if (!messages || !Array.isArray(messages)) {
      return res.status(400).json({ error: 'Messages array is required' });
    }
    
    // Check if client has an SSE connection
    if (!clients.has(chatId)) {
      console.log(`No active SSE connection for chat ID: ${chatId}. Creating response without streaming.`);
      
      // Process without streaming if no SSE connection exists
      // Load app details
      const apps = await loadConfig('apps.json');
      if (!apps) {
        return res.status(500).json({ error: 'Failed to load apps configuration' });
      }
      
      const app = apps.find(a => a.id === appId);
      if (!app) {
        return res.status(404).json({ error: 'App not found' });
      }
      
      // Load models
      const models = await loadConfig('models.json');
      if (!models) {
        return res.status(500).json({ error: 'Failed to load models configuration' });
      }
      
      // Determine which model to use
      const model = models.find(m => m.id === (modelId || app.preferredModel));
      if (!model) {
        return res.status(404).json({ error: 'Model not found' });
      }
      
      // Prepare messages with proper formatting
      const llmMessages = processMessageTemplates(messages, app, style, outputFormat);
      
      // Get and verify API key for model
      const apiKey = verifyApiKey(model, res);
      if (!apiKey) return; // Function will handle sending error response
      
      // Create request without streaming
      const request = createCompletionRequest(model, llmMessages, apiKey, { 
        temperature: parseFloat(temperature) || app.preferredTemperature || 0.7,
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
          return res.status(llmResponse.status).json({ 
            error: `LLM API request failed with status ${llmResponse.status}`,
            details: errorBody
          });
        }
        
        // Return the complete response
        const responseData = await llmResponse.json();
        return res.json(responseData);
      } catch (fetchError) {
        clearTimeout(timeoutId);
        
        if (fetchError.message.includes('timed out')) {
          return res.status(504).json({ 
            error: 'Request timed out', 
            message: `Request to ${model.provider} API timed out after ${DEFAULT_TIMEOUT/1000} seconds`
          });
        } else {
          throw fetchError; // Re-throw for the catch block below
        }
      }
    }
    
    // If we have an SSE connection, stream the response
    const clientRes = clients.get(chatId).response;
    
    // Update last activity timestamp
    clients.set(chatId, {
      ...clients.get(chatId),
      lastActivity: new Date()
    });
    
    // Load app details
    const apps = await loadConfig('apps.json');
    if (!apps) {
      sendSSE(clientRes, 'error', { message: 'Failed to load apps configuration' });
      return res.json({ status: 'error', message: 'Failed to load apps configuration' });
    }
    
    const app = apps.find(a => a.id === appId);
    if (!app) {
      sendSSE(clientRes, 'error', { message: 'App not found' });
      return res.json({ status: 'error', message: 'App not found' });
    }
    
    // Load models
    const models = await loadConfig('models.json');
    if (!models) {
      sendSSE(clientRes, 'error', { message: 'Failed to load models configuration' });
      return res.json({ status: 'error', message: 'Failed to load models configuration' });
    }
    
    // Determine which model to use
    const model = models.find(m => m.id === (modelId || app.preferredModel));
    if (!model) {
      sendSSE(clientRes, 'error', { message: 'Model not found' });
      return res.json({ status: 'error', message: 'Model not found' });
    }
    
    // Prepare messages with proper formatting
    const llmMessages = processMessageTemplates(messages, app, style, outputFormat);
    
    // Get and verify API key with proper error handling for SSE
    const apiKey = verifyApiKey(model, null, clientRes);
    if (!apiKey) {
      // Already sent error via SSE, just return response to the HTTP request
      return res.json({ status: 'error', message: `API key not found for model: ${model.id}` });
    }
    
    // Create request using appropriate adapter
    const request = createCompletionRequest(model, llmMessages, apiKey, { 
      temperature: parseFloat(temperature) || app.preferredTemperature || 0.7,
      stream: true
    });
    
    // Send processing event
    sendSSE(clientRes, 'processing', { message: 'Processing your request...' });
    
    // Set up abort controller for this request
    const controller = new AbortController();
    activeRequests.set(chatId, controller);
    
    // Set up timeout for the request
    const timeoutId = setTimeout(() => {
      console.log(`Request timeout for chat ${chatId}`);
      controller.abort();
      sendSSE(clientRes, 'error', { 
        message: `Request timed out after ${DEFAULT_TIMEOUT/1000} seconds. The model may be experiencing high load.` 
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
        let errorMessage = `LLM API request failed with status ${llmResponse.status}`;
        
        // Provide more helpful error messages for common errors
        if (llmResponse.status === 401) {
          errorMessage = `Authentication failed for ${model.provider} API. Please check your API key.`;
        } else if (llmResponse.status === 429) {
          errorMessage = `Rate limit exceeded for ${model.provider} API. Please try again later.`;
        } else if (llmResponse.status >= 500) {
          errorMessage = `${model.provider} API service error. The service may be experiencing issues.`;
        }
        
        sendSSE(clientRes, 'error', { message: errorMessage, details: errorBody });
        activeRequests.delete(chatId);
        return;
      }
      
      // Stream the response back to the client
      const reader = llmResponse.body.getReader();
      const decoder = new TextDecoder();
      
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
            }
          }
          
          // Handle errors if any occurred during processing
          if (result && result.error) {
            sendSSE(clientRes, 'error', { message: result.errorMessage || 'Error processing response' });
            break;
          }
          
          // Check for completion
          if (result && result.complete) {
            sendSSE(clientRes, 'done', {});
            break; // Stop processing more chunks
          }
        }
      } catch (error) {
        if (error.name === 'AbortError') {
          console.log(`Request aborted for chat ${chatId}`);
          // Don't send an error event if timeout already sent one
        } else {
          console.error('Error processing response stream:', error);
          sendSSE(clientRes, 'error', { message: `Error processing response stream: ${error.message}` });
        }
      } finally {
        activeRequests.delete(chatId);
      }
    }).catch(error => {
      clearTimeout(timeoutId);
      
      if (error.name === 'AbortError') {
        console.log(`Request aborted for chat ${chatId}`);
        // Don't log or send event if it was an intentional abort
      } else {
        console.error('Error executing LLM request:', error);
        sendSSE(clientRes, 'error', { message: `Error executing LLM request: ${error.message}` });
      }
      
      activeRequests.delete(chatId);
    });
    
    // Return immediate response to the POST request
    return res.json({ status: 'streaming', chatId });
    
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

// Helper function to extract messages and format them
function processMessageTemplates(messages, app, style = null, outputFormat = null) {
  // Copy messages to avoid modifying the original
  let llmMessages = [...messages].map(msg => {
    // Process user messages with prompt templates and variables
    if (msg.role === 'user' && msg.promptTemplate && msg.variables) {
      // Start with the prompt template or original content if no template
      // Handle localized content in prompt templates
      let processedContent = typeof msg.promptTemplate === 'object'
        ? getLocalizedContent(msg.promptTemplate)
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
      
      // Replace the content with the processed template
      return { role: 'user', content: processedContent };
    }
    
    // For non-user messages or messages without templates, keep as is
    return { role: msg.role, content: msg.content };
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
    // Handle localized content in system prompt
    let systemPrompt = typeof app.system === 'object'
      ? getLocalizedContent(app.system)
      : (app.system || '');
    
    if (typeof systemPrompt !== 'string') {
      console.log(`Type of systemPrompt is not string: ${typeof systemPrompt}`);
      systemPrompt = String(systemPrompt || '');
    }
    
    // Replace variable placeholders in the system prompt
    if (Object.keys(userVariables).length > 0) {
      for (const [key, value] of Object.entries(userVariables)) {
        // Ensure value is a string before using replace
        const strValue = typeof value === 'string' ? value : String(value || '');
        systemPrompt = systemPrompt.replace(`{{${key}}}`, strValue);
      }
    }
    
    // Apply style modifications if specified
    if (style) {
      loadConfig('styles.json').then(styles => {
        if (styles && styles[style]) {
          systemPrompt += `\n\n${styles[style]}`;
        }
      }).catch(err => console.error('Error loading styles:', err));
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
  res.sendFile(path.join(__dirname, '../client/dist/index.html'));
});

// Validate API keys at startup
validateApiKeys();

// Start server
app.listen(PORT, () => {
  console.log(`Server is running on port ${PORT}`);
  console.log(`Open http://localhost:${PORT} in your browser to use AI Hub Apps`);
});