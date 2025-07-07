import configCache from '../../configCache.js';
import { createCompletionRequest } from '../../adapters/index.js';
import { getErrorDetails, logInteraction, trackSession } from '../../utils.js';
import { clients, activeRequests } from '../../sse.js';
import { actionTracker } from '../../actionTracker.js';
import { throttledFetch } from '../../requestThrottler.js';

import {
  prepareChatRequest,
  executeStreamingResponse,
  executeNonStreamingResponse,
  processChatWithTools
} from '../../services/chatService.js';
import validate from '../../validators/validate.js';
import { chatTestSchema, chatPostSchema, chatConnectSchema } from '../../validators/index.js';

export default function registerSessionRoutes(app, { verifyApiKey, processMessageTemplates, getLocalizedError, DEFAULT_TIMEOUT }) {
  app.get('/api/models/:modelId/chat/test', validate(chatTestSchema), async (req, res) => {
    try {
      const { modelId } = req.params;
      const messages = [{ role: 'user', content: 'Say hello!' }];
      
      // Try to get models from cache first
      let models = configCache.getModels();
      
      if (!models) {
        return res.status(500).json({ error: 'Failed to load models configuration' });
      }
      const model = models.find(m => m.id === modelId);
      if (!model) {
        return res.status(404).json({ error: 'Model not found' });
      }
      const defaultLang = configCache.getPlatform()?.defaultLanguage || 'en';
      const apiKey = await verifyApiKey(model, res, null, req.headers['accept-language']?.split(',')[0] || defaultLang);
      if (!apiKey) {
        return res.status(500).json({
          error: `API key not found for model: ${model.id} (${model.provider})`,
          provider: model.provider
        });
      }
      const request = createCompletionRequest(model, messages, apiKey, { stream: false, tools: [] });
      let timeoutId;
      const timeoutPromise = new Promise((_, reject) => {
        timeoutId = setTimeout(() => reject(new Error(`Request timed out after ${DEFAULT_TIMEOUT/1000} seconds`)), DEFAULT_TIMEOUT);
      });
      try {
        const responsePromise = throttledFetch(model.id, request.url, {
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
        const responseData = await llmResponse.json();
        return res.json(responseData);
      } catch (fetchError) {
        clearTimeout(timeoutId);
        if (fetchError.message.includes('timed out')) {
          return res.status(504).json({
            error: 'Request timed out',
            message: `Request to ${model.provider} API timed out after ${DEFAULT_TIMEOUT/1000} seconds`
          });
        }
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
    } catch (error) {
      console.error('Error in test chat completion:', error);
      res.status(500).json({ error: 'Internal server error', message: error.message });
    }
  });

  app.get('/api/apps/:appId/chat/:chatId', validate(chatConnectSchema), async (req, res) => {
    try {
      const { appId, chatId } = req.params;
      res.setHeader('Content-Type', 'text/event-stream');
      res.setHeader('Cache-Control', 'no-cache');
      res.setHeader('Connection', 'keep-alive');
      clients.set(chatId, { response: res, lastActivity: new Date(), appId });
      actionTracker.trackConnected(chatId);

      req.on('close', () => {
        if (clients.has(chatId)) {
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
      if (!res.headersSent) {
        return res.status(500).json({ error: 'Internal server error' });
      }
      actionTracker.trackError(chatId, { message: 'Internal server error' });
      res.end();
    }
  });

  // Extract common chat processing logic to reduce duplication
  async function processChatRequest({ 
    prep, 
    buildLogData, 
    messageId, 
    streaming, 
    res, 
    clientRes, 
    chatId, 
    DEFAULT_TIMEOUT, 
    getLocalizedError, 
    clientLanguage 
  }) {
    const { model, llmMessages } = prep;
    
    // Log the request
    const requestLog = buildLogData(streaming);
    if (!streaming) {
      requestLog.options.useMaxTokens = requestLog.options.useMaxTokens || false;
    }
    await logInteraction('chat_request', requestLog);
    
    // Handle requests with tools
    if (prep.tools && prep.tools.length > 0) {
      const toolsParams = {
        prep,
        buildLogData,
        messageId,
        DEFAULT_TIMEOUT,
        getLocalizedError,
        clientLanguage
      };
      
      if (streaming) {
        console.log(`Processing chat with tools for chat ID: ${chatId}`);
        processChatWithTools({ ...toolsParams, clientRes, chatId });
        return;
      } else {
        return processChatWithTools({ ...toolsParams, res });
      }
    }
    
    // Handle standard requests without tools
    const executionParams = {
      request: prep.request,
      buildLogData,
      model: prep.model,
      llmMessages: prep.llmMessages,
      DEFAULT_TIMEOUT
    };
    
    if (streaming) {
      return await executeStreamingResponse({ 
        ...executionParams, 
        chatId, 
        clientRes, 
        getLocalizedError, 
        clientLanguage 
      });
    } else {
      return executeNonStreamingResponse({ 
        ...executionParams, 
        res, 
        messageId 
      });
    }
  }

  app.post('/api/apps/:appId/chat/:chatId', validate(chatPostSchema), async (req, res) => {
    try {
      const { appId, chatId } = req.params;
      const { messages, modelId, temperature, style, outputFormat, language, useMaxTokens, bypassAppPrompts } = req.body;
      const defaultLang = configCache.getPlatform()?.defaultLanguage || 'en';
      const clientLanguage = language || req.headers['accept-language']?.split(',')[0] || defaultLang;
      let messageId = null;
      if (messages && Array.isArray(messages) && messages.length > 0) {
        const lastMessage = messages[messages.length - 1];
        if (lastMessage && lastMessage.messageId) {
          messageId = lastMessage.messageId;
          console.log(`Using client-provided messageId: ${messageId}`);
        }
      }
      const userSessionId = req.headers['x-session-id'];
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
          options: { temperature, style, outputFormat, language: clientLanguage, streaming },
          ...extra
        };
      }
      console.log(`Processing chat with language: ${clientLanguage}`);
      if (!messages || !Array.isArray(messages)) {
        const errorMessage = await getLocalizedError('messagesRequired', {}, clientLanguage);
        return res.status(400).json({ error: errorMessage });
      }
      trackSession(chatId, { appId, userSessionId, userAgent: req.headers['user-agent'] });
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
          useMaxTokens,
          bypassAppPrompts,
          verifyApiKey,
          processMessageTemplates,
          res
        });
        if (prep.error) {
          const errMsg = await getLocalizedError(prep.error, {}, clientLanguage);
          return res.status(prep.error === 'appNotFound' || prep.error === 'modelNotFound' ? 404 : 500).json({ error: errMsg });
        }
        ({ model, llmMessages } = prep);

        return processChatRequest({
          prep,
          buildLogData,
          messageId,
          streaming: false,
          res,
          clientRes: null,
          chatId: null,
          DEFAULT_TIMEOUT,
          getLocalizedError,
          clientLanguage
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
          useMaxTokens,
          bypassAppPrompts,
          verifyApiKey,
          processMessageTemplates,
          clientRes
        });
        if (prep.error) {
          const errMsg = await getLocalizedError(prep.error, {}, clientLanguage);
          actionTracker.trackError(chatId, { message: errMsg });
          return res.json({ status: 'error', message: errMsg });
        }
        model = prep.model;
        llmMessages = prep.llmMessages;

        await processChatRequest({
          prep,
          buildLogData,
          messageId,
          streaming: true,
          res: null,
          clientRes,
          chatId,
          DEFAULT_TIMEOUT,
          getLocalizedError,
          clientLanguage
        });
        
        return res.json({ status: 'streaming', chatId });
      }
    } catch (error) {
      console.error('Error in app chat:', error);
      return res.status(500).json({ error: 'Internal server error', message: error.message });
    }
  });

  app.post('/api/apps/:appId/chat/:chatId/stop', (req, res) => {
    const { chatId } = req.params;
    if (clients.has(chatId)) {
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
      actionTracker.trackDisconnected(chatId, { message: 'Chat stream stopped by client' });
      client.response.end();
      clients.delete(chatId);
      console.log(`Chat stream stopped for chat ID: ${chatId}`);
      return res.status(200).json({ success: true, message: 'Chat stream stopped' });
    }
    return res.status(404).json({ success: false, message: 'Chat session not found' });
  });

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
