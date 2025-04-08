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

// Store active client connections
const clients = new Map();

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

    // Get API key from environment
    const apiKey = getApiKeyForModel(modelId);
    if (!apiKey) {
      return res.status(500).json({ 
        error: `API key not found for model ${model.id}`
      });
    }

    // Create request using appropriate adapter
    const request = createCompletionRequest(model, messages, apiKey, { stream: false });
    
    // Execute request
    const response = await fetch(request.url, {
      method: 'POST',
      headers: request.headers,
      body: JSON.stringify(request.body)
    });
    
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
      lastActivity: new Date()
    });
    
    // Send initial connection event
    sendSSE(res, 'connected', { chatId });
    
    // Keep the connection open
    req.on('close', () => {
      // Clean up when client disconnects
      if (clients.has(chatId)) {
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

// GET /api/disclaimer - Fetch disclaimer text
app.get('/api/disclaimer', async (req, res) => {
  try {
    const disclaimer = await loadConfig('disclaimer.json');
    if (!disclaimer) {
      return res.status(500).json({ error: 'Failed to load disclaimer configuration' });
    }
    res.json(disclaimer);
  } catch (error) {
    console.error('Error fetching disclaimer:', error);
    res.status(500).json({ error: 'Internal server error' });
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

// // POST /api/apps/{appId}/chat - Start a new chat session
// app.post('/api/apps/:appId/chat', async (req, res) => {
//   try {
//     const { appId } = req.params;
//     const apps = await loadConfig('apps.json');
    
//     if (!apps) {
//       return res.status(500).json({ error: 'Failed to load apps configuration' });
//     }
    
//     const app = apps.find(a => a.id === appId);
//     if (!app) {
//       return res.status(404).json({ error: 'App not found' });
//     }
    
//     // Generate a unique chat ID
//     const chatId = Date.now().toString();
    
//     res.json({ 
//       chatId, 
//       appId, 
//       status: 'created',
//       app: {
//         name: app.name,
//         description: app.description,
//         system: app.system,
//         tokenLimit: app.tokenLimit
//       }
//     });
//   } catch (error) {
//     console.error('Error creating chat session:', error);
//     res.status(500).json({ error: 'Internal server error' });
//   }
// });

// POST /api/apps/{appId}/chat/{chatId} - Process chat messages
app.post('/api/apps/:appId/chat/:chatId', async (req, res) => {
  try {
    const { appId, chatId } = req.params;
    const { messages, modelId, temperature, style } = req.body;
    
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
      
      // Copy messages to avoid modifying the original
      let llmMessages = [...messages];
      
      // Apply prompt template if the app has one and there's no system message
      if (!llmMessages.some(msg => msg.role === 'system')) {
        // Add application system prompt with style modifications if applicable
        let systemPrompt = app.system || '';
        
        // Apply style modifications if specified
        if (style) {
          const styles = await loadConfig('styles.json');
          if (styles && styles[style]) {
            systemPrompt += `\n\n${styles[style]}`;
          }
        }
        
        llmMessages.unshift({ role: 'system', content: systemPrompt });
      }
      
      // Get API key for model
      const apiKey = getApiKeyForModel(model.id);
      if (!apiKey) {
        return res.status(500).json({ error: `API key not found for model: ${model.id}` });
      }
      
      // Create request without streaming
      const request = createCompletionRequest(model, llmMessages, apiKey, { 
        temperature: parseFloat(temperature) || app.preferredTemperature || 0.7,
        stream: false
      });
      
      // Execute request to LLM API
      const llmResponse = await fetch(request.url, {
        method: 'POST',
        headers: request.headers,
        body: JSON.stringify(request.body)
      });
      
      if (!llmResponse.ok) {
        const errorBody = await llmResponse.text();
        console.error(`LLM API Error (${llmResponse.status}): ${errorBody}`);
        return res.status(llmResponse.status).json({ 
          error: `LLM API request failed with status ${llmResponse.status}` 
        });
      }
      
      // Return the complete response
      const responseData = await llmResponse.json();
      return res.json(responseData);
    }
    
    // If we have an SSE connection, stream the response
    const clientRes = clients.get(chatId).response;
    
    // Update last activity timestamp
    clients.set(chatId, {
      response: clientRes,
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
    
    // Copy messages to avoid modifying the original
    let llmMessages = [...messages];
    
    // Apply prompt template if the app has one and there's no system message
    if (!llmMessages.some(msg => msg.role === 'system')) {
      // Add application system prompt with style modifications if applicable
      let systemPrompt = app.system || '';
      
      // Apply style modifications if specified
      if (style) {
        const styles = await loadConfig('styles.json');
        if (styles && styles[style]) {
          systemPrompt += `\n\n${styles[style]}`;
        }
      }
      
      llmMessages.unshift({ role: 'system', content: systemPrompt });
    }
    
    // Get API key for model
    const apiKey = getApiKeyForModel(model.id);
    if (!apiKey) {
      sendSSE(clientRes, 'error', { message: `API key not found for model: ${model.id}` });
      return res.json({ status: 'error', message: `API key not found for model: ${model.id}` });
    }
    
    // Create request using appropriate adapter
    const request = createCompletionRequest(model, llmMessages, apiKey, { 
      temperature: parseFloat(temperature) || app.preferredTemperature || 0.7,
      stream: true
    });
    
    // Send processing event
    sendSSE(clientRes, 'processing', { message: 'Processing your request...' });
    
    // Execute request to LLM API in the background
    fetch(request.url, {
      method: 'POST',
      headers: request.headers,
      body: JSON.stringify(request.body)
    }).then(async (llmResponse) => {
      if (!llmResponse.ok) {
        // Handle error case
        const errorBody = await llmResponse.text();
        console.error(`LLM API Error (${llmResponse.status}): ${errorBody}`);
        sendSSE(clientRes, 'error', { message: `LLM API request failed with status ${llmResponse.status}` });
        return;
      }
      
      // Stream the response back to the client
      const reader = llmResponse.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';
      
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
          // For Google/Gemini, process each chunk individually
          const result = processResponseBuffer(model.provider, chunk);
          console.log(`Processing chunk: ${chunk} => ${JSON.stringify(result ? result : {})}`);
          
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
        console.error('Error processing response stream:', error);
        sendSSE(clientRes, 'error', { message: `Error processing response stream: ${error.message}` });
      }
    }).catch(error => {
      console.error('Error executing LLM request:', error);
      sendSSE(clientRes, 'error', { message: 'Error executing LLM request' });
    });
    
    // Return immediate response to the POST request
    return res.json({ status: 'streaming', chatId });
    
  } catch (error) {
    console.error('Error in app chat:', error);
    return res.status(500).json({ error: 'Internal server error' });
  }
});

// POST /api/apps/{appId}/chat/{chatId}/stop - Stop a streaming chat session
app.post('/api/apps/:appId/chat/:chatId/stop', (req, res) => {
  const { chatId } = req.params;
  
  if (clients.has(chatId)) {
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
      lastActivity: clients.get(chatId).lastActivity 
    });
  }
  
  return res.status(200).json({ active: false });
});

// Cleanup inactive clients every minute
setInterval(() => {
  const now = new Date();
  for (const [chatId, client] of clients.entries()) {
    if (now - client.lastActivity > 5 * 60 * 1000) { // 5 minutes
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

// Start server
app.listen(PORT, () => {
  console.log(`Server is running on port ${PORT}`);
});