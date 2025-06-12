import { loadJson, loadText } from '../configLoader.js';
import { createCompletionRequest } from '../adapters/index.js';
import { getErrorDetails, logInteraction, trackSession } from '../utils.js';
import { sendSSE, clients, activeRequests } from '../sse.js';
import {
  prepareChatRequest,
  executeStreamingResponse,
  executeNonStreamingResponse,
  processChatWithTools
} from '../services/chatService.js';
import { recordMagicPrompt, recordFeedback, estimateTokens } from '../usageTracker.js';

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
      // No tools for this test endpoint
      const tools = [];

      // Create request using appropriate adapter
      const request = createCompletionRequest(model, messages, apiKey, { stream: false, tools });
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

      // Record feedback for usage tracking
      await recordFeedback({
        userId: userSessionId,
        appId,
        modelId,
        rating: rating === 'positive' ? 'positive' : 'negative'
      });

      console.log(`Feedback received for message ${messageId} in chat ${chatId}: ${rating}`);
      return res.status(200).json({ success: true });
    } catch (error) {
      console.error('Error processing feedback:', error);
      return res.status(500).json({ error: 'Internal server error', message: error.message });
    }
  });

  // POST /api/magic-prompt - Generate an enhanced prompt
  app.post('/api/magic-prompt', async (req, res) => {
    try {
      const { input, prompt, modelId, appId = 'direct' } = req.body;
      const language = req.headers['accept-language']?.split(',')[0] || 'en';

      if (!input) {
        return res.status(400).json({ error: 'Missing input' });
      }

      const models = await loadJson('config/models.json');
      if (!models) {
        return res.status(500).json({ error: 'Failed to load models configuration' });
      }

      const selectedModelId = modelId || process.env.MAGIC_PROMPT_MODEL || 'gpt-3.5-turbo';
      const model = models.find(m => m.id === selectedModelId);
      if (!model) {
        return res.status(400).json({ error: 'Model not found' });
      }

      const apiKey = await verifyApiKey(model, res, null, language);
      if (!apiKey) {
        return res.status(500).json({ error: `API key not found for model: ${model.id}` });
      }

      const systemPrompt = prompt || process.env.MAGIC_PROMPT_PROMPT || 'Improve the following prompt.';

      const messages = [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: input }
      ];

      const request = createCompletionRequest(model, messages, apiKey, { stream: false });

      let timeoutId;
      const timeoutPromise = new Promise((_, reject) => {
        timeoutId = setTimeout(() => {
          reject(new Error(`Request timed out after ${DEFAULT_TIMEOUT/1000} seconds`));
        }, DEFAULT_TIMEOUT);
      });

      const responsePromise = fetch(request.url, {
        method: 'POST',
        headers: request.headers,
        body: JSON.stringify(request.body)
      });

      const llmResponse = await Promise.race([responsePromise, timeoutPromise]);
      clearTimeout(timeoutId);

      if (!llmResponse.ok) {
        const errorBody = await llmResponse.text();
        return res.status(llmResponse.status).json({
          error: `LLM API request failed with status ${llmResponse.status}`,
          details: errorBody
        });
      }

      const responseData = await llmResponse.json();

      let newPrompt = '';
      if (model.provider === 'openai') {
        newPrompt = responseData.choices?.[0]?.message?.content?.trim() || '';
      } else if (model.provider === 'google') {
        const parts = responseData.candidates?.[0]?.content?.parts || [];
        newPrompt = parts.map(p => p.text || '').join('').trim();
      } else if (model.provider === 'anthropic') {
        const content = responseData.content;
        if (Array.isArray(content)) {
          newPrompt = content.map(c => (typeof c === 'string' ? c : c.text || '')).join('').trim();
        }
      }

      const inputTokens =
        responseData.usage?.prompt_tokens ?? estimateTokens(input);
      const outputTokens =
        responseData.usage?.completion_tokens ?? estimateTokens(newPrompt);
      const userSessionId = req.headers['x-session-id'];
      await recordMagicPrompt({ userId: userSessionId, appId, modelId: model.id, inputTokens, outputTokens });

      return res.json({ prompt: newPrompt });
    } catch (error) {
      console.error('Error generating magic prompt:', error);
      return res.status(500).json({ error: 'Internal server error' });
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

        const prep = await prepareChatRequest({
          appId,
          modelId,
          messages,
          temperature,
          style,
          outputFormat,
          language: clientLanguage,
          maxTokens,
          verifyApiKey,
          processMessageTemplates,
          res
        });

        if (prep.error) {
          const errMsg = await getLocalizedError(prep.error, {}, clientLanguage);
          return res.status( prep.error === 'appNotFound' || prep.error === 'modelNotFound' ? 404 : 500 ).json({ error: errMsg });
        }

        ({ model, llmMessages } = prep);

        const requestLog = buildLogData(false);
        requestLog.options.maxTokens = parseInt(maxTokens) || prep.app.tokenLimit || 1024;
        await logInteraction('chat_request', requestLog);

        if (prep.tools && prep.tools.length > 0) {
          return processChatWithTools({
            prep,
            res,
            buildLogData,
            messageId,
            DEFAULT_TIMEOUT,
            getLocalizedError,
            clientLanguage
          });
        }

        return executeNonStreamingResponse({
          request: prep.request,
          res,
          buildLogData,
          messageId,
          model: prep.model,
          llmMessages: prep.llmMessages,
          DEFAULT_TIMEOUT
        });
      } else {
        const clientRes = clients.get(chatId).response;
        clients.set(chatId, { ...clients.get(chatId), lastActivity: new Date() });

        const prep = await prepareChatRequest({
          appId,
          modelId,
          messages,
          temperature,
          style,
          outputFormat,
          language: clientLanguage,
          maxTokens,
          verifyApiKey,
          processMessageTemplates,
          clientRes
        });

        if (prep.error) {
          const errMsg = await getLocalizedError(prep.error, {}, clientLanguage);
          sendSSE(clientRes, 'error', { message: errMsg });
          return res.json({ status: 'error', message: errMsg });
        }

        model = prep.model;
        llmMessages = prep.llmMessages;

        await logInteraction('chat_request', {
          messageId,
          appId,
          modelId: model.id,
          sessionId: chatId,
          userSessionId,
          messages: llmMessages,
          options: { temperature, style, outputFormat, language: clientLanguage, streaming: true }
        });

        if (prep.tools && prep.tools.length > 0) {
          console.log(`Processing chat with tools for chat ID: ${chatId}`);
          await processChatWithTools({
            prep,
            clientRes,
            chatId,
            buildLogData,
            messageId,
            DEFAULT_TIMEOUT,
            getLocalizedError,
            clientLanguage
          });
        } else {
          await executeStreamingResponse({
            request: prep.request,
            chatId,
            clientRes,
            buildLogData,
            model: prep.model,
            llmMessages: prep.llmMessages,
            DEFAULT_TIMEOUT,
            getLocalizedError,
            clientLanguage
          });
        }

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
