import { loadJson, loadText } from '../configLoader.js';
import { createCompletionRequest, processResponseBuffer } from '../adapters/index.js';
import { getErrorDetails, logInteraction, trackSession } from '../utils.js';
import { sendSSE, clients, activeRequests } from '../sse.js';

export default function registerChatRoutes(app, { verifyApiKey, processMessageTemplates, getLocalizedError, DEFAULT_TIMEOUT }) {
  // GET /api/models/{modelId}/chat/test - Test model chat completion without streaming
  app.get('/api/models/:modelId/chat/test', async (req, res) => {
    try {
      const { modelId } = req.params;
      
      // Simple test message
      const messages = [
        { role: "user", content: "Say hello!" }
      ];
  
      // Load models configuration
      const models = await loadJson('config/models.json');
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
      const language = req.headers['accept-language']?.split(',')[0] || 'en';

      if (!messageId || !rating || !appId || !chatId) {
        const errorMessage = await getLocalizedError('missingFeedbackFields', {}, language);
        return res.status(400).json({ error: errorMessage });
      }

      const userSessionId = req.headers['x-session-id'];

      await logInteraction('feedback', {
        messageId,
        appId,
        modelId,
        sessionId: chatId,
        userSessionId,
        responseType: 'feedback',
        feedback: {
          messageId,
          rating,
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
      const styles = await loadJson('config/styles.json');
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
      const translations = await loadJson(`locales/${lang}.json`);
      if (!translations) {
        console.error(`Failed to load translations for language: ${lang}`);
        // Fall back to English if translation file can't be loaded
        if (lang !== 'en') {
          const enTranslations = await loadJson('locales/en.json');
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
        const enTranslations = await loadJson('locales/en.json');
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
      const uiConfig = await loadJson('config/ui.json');
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

    // Declare variables for later use so they are accessible in buildLogData
    let model;
    let llmMessages;

    function buildLogData(streaming, extra = {}) {
      return {
        messageId,
        appId,
        modelId: model?.id,
        sessionId: chatId,
        userSessionId,
        messages: llmMessages,
        options: {
          temperature,
          style,
          outputFormat,
          language: clientLanguage,
          streaming
        },
        ...extra
      };
    }
      
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
        const apps = await loadJson('config/apps.json');
        if (!apps) {
          return res.status(500).json({ error: 'Failed to load apps configuration' });
        }
        
        const app = apps.find(a => a.id === appId);
        if (!app) {
          const errorMessage = await getLocalizedError('appNotFound', {}, clientLanguage);
          return res.status(404).json({ error: errorMessage });
        }
        
        // Load models
        const models = await loadJson('config/models.json');
        if (!models) {
          return res.status(500).json({ error: 'Failed to load models configuration' });
        }
        
        // Determine which model to use
        model = models.find(m => m.id === (modelId || app.preferredModel));
        if (!model) {
          const errorMessage = await getLocalizedError('modelNotFound', {}, clientLanguage);
          return res.status(404).json({ error: errorMessage });
        }
        
        // Prepare messages with proper formatting
        llmMessages = await processMessageTemplates(messages, app, style, outputFormat, clientLanguage);
        
        // Log the interaction before sending to LLM
        const requestLog = buildLogData(false);
        requestLog.options.maxTokens = parseInt(maxTokens) || app.tokenLimit || 1024;
        await logInteraction('chat_request', requestLog);
        
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

            const errorLog = buildLogData(false, {
              responseType: 'error',
              error: {
                message: `LLM API request failed with status ${llmResponse.status}`,
                code: llmResponse.status.toString()
              }
            });
            await logInteraction('chat_error', errorLog);
            
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
          const responseLog = buildLogData(false, {
            responseType: 'success',
            response: aiResponse.substring(0, 1000)
          });
          await logInteraction('chat_response', responseLog);
          
          return res.json(responseData);
        } catch (fetchError) {
          clearTimeout(timeoutId);
          
          if (fetchError.message.includes('timed out')) {
            // Log timeout error
            await logInteraction('chat_error', buildLogData(false, {
              responseType: 'error',
              error: {
                message: `Request timed out after ${DEFAULT_TIMEOUT/1000} seconds`,
                code: 'TIMEOUT'
              }
            }));
            
            return res.status(504).json({ 
              error: 'Request timed out', 
              message: `Request to ${model.provider} API timed out after ${DEFAULT_TIMEOUT/1000} seconds`
            });
          } else {
            // Get enhanced error details for the non-streaming case
            const errorDetails = getErrorDetails(fetchError, model);
            
            // Log detailed error
            await logInteraction('chat_error', buildLogData(false, {
              responseType: 'error',
              error: {
                message: errorDetails.message,
                code: errorDetails.code
              }
            }));
            
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
        const apps = await loadJson('config/apps.json');
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
        const models = await loadJson('config/models.json');
        if (!models) {
          const errorMessage = await getLocalizedError('internalError', {}, clientLanguage);
          sendSSE(clientRes, 'error', { message: errorMessage });
          return res.json({ status: 'error', message: errorMessage });
        }
        
        console.log(`Using modelId: ${modelId} || ${app.preferredModel}`);
        // Determine which model to use
        model = models.find(m => m.id === (modelId || app.preferredModel));
        if (!model) {
          const errorMessage = await getLocalizedError('modelNotFound', {}, clientLanguage);
          sendSSE(clientRes, 'error', { message: errorMessage });
          return res.json({ status: 'error', message: errorMessage });
        }
        
        // Prepare messages with proper formatting
        llmMessages = await processMessageTemplates(messages, app, style, outputFormat, clientLanguage);
        
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
          await logInteraction('chat_error', buildLogData(true, {
            responseType: 'error',
            error: {
              message: `API key not found for model: ${model.id}`,
              code: 'API_KEY_NOT_FOUND'
            }
          }));
          
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
                const errorLog = buildLogData(true, {
                  responseType: 'error',
                  error: {
                    message: result.errorMessage || 'Error processing response',
                    code: 'PROCESSING_ERROR'
                  },
                  response: fullResponse
                });
                await logInteraction('chat_error', errorLog);
                
                sendSSE(clientRes, 'error', { message: result.errorMessage || 'Error processing response' });
                break;
              }
              
              // Check for completion
              if (result && result.complete) {
                sendSSE(clientRes, 'done', {});
                
                // Log the completed interaction with the full response
                const doneLog = buildLogData(true, {
                  responseType: 'success',
                  response: fullResponse
                });
                await logInteraction('chat_response', doneLog);
                
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
              logInteraction('chat_error', buildLogData(true, {
                responseType: 'error',
                error: {
                  message: errorMessage,
                  code: errorDetails.code
                }
              })).catch(logError => {
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
              logInteraction('chat_error', buildLogData(true, {
                responseType: 'error',
                error: {
                  message: errorDetails.message,
                  code: errorDetails.code
                }
              })).catch(logError => {
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
  
}
