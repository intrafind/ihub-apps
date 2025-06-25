import { loadJson } from '../../configLoader.js';
import { createCompletionRequest } from '../../adapters/index.js';
import { getErrorDetails, logInteraction, trackSession } from '../../utils.js';
import { sendSSE, clients, activeRequests } from '../../sse.js';
import {
  prepareChatRequest,
  executeStreamingResponse,
  executeNonStreamingResponse,
  processChatWithTools
} from '../../services/chatService.js';
import { estimateTokens } from '../../usageTracker.js';

export default function registerSessionRoutes(app, { verifyApiKey, processMessageTemplates, getLocalizedError, DEFAULT_TIMEOUT }) {
  app.get('/api/models/:modelId/chat/test', async (req, res) => {
    try {
      const { modelId } = req.params;
      const messages = [{ role: 'user', content: 'Say hello!' }];
      const models = await loadJson('config/models.json');
      if (!models) {
        return res.status(500).json({ error: 'Failed to load models configuration' });
      }
      const model = models.find(m => m.id === modelId);
      if (!model) {
        return res.status(404).json({ error: 'Model not found' });
      }
      const apiKey = await verifyApiKey(model, res, null, req.headers['accept-language']?.split(',')[0] || 'en');
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

  app.get('/api/apps/:appId/chat/:chatId', async (req, res) => {
    try {
      const { appId, chatId } = req.params;
      res.setHeader('Content-Type', 'text/event-stream');
      res.setHeader('Cache-Control', 'no-cache');
      res.setHeader('Connection', 'keep-alive');
      clients.set(chatId, { response: res, lastActivity: new Date(), appId });
      sendSSE(res, 'connected', { chatId });
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
      sendSSE(res, 'error', { message: 'Internal server error' });
      res.end();
    }
  });

  app.post('/api/apps/:appId/chat/:chatId', async (req, res) => {
    try {
      const { appId, chatId } = req.params;
      const { messages, modelId, temperature, style, outputFormat, language, useMaxTokens, bypassAppPrompts } = req.body;
      const clientLanguage = language || req.headers['accept-language']?.split(',')[0] || 'en';
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
        const requestLog = buildLogData(false);
        requestLog.options.useMaxTokens = !!useMaxTokens;
        await logInteraction('chat_request', requestLog);
        if (prep.tools && prep.tools.length > 0) {
          return processChatWithTools({ prep, res, buildLogData, messageId, DEFAULT_TIMEOUT, getLocalizedError, clientLanguage });
        }
        return executeNonStreamingResponse({ request: prep.request, res, buildLogData, messageId, model: prep.model, llmMessages: prep.llmMessages, DEFAULT_TIMEOUT });
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
          await processChatWithTools({ prep, clientRes, chatId, buildLogData, messageId, DEFAULT_TIMEOUT, getLocalizedError, clientLanguage });
        } else {
          await executeStreamingResponse({ request: prep.request, chatId, clientRes, buildLogData, model: prep.model, llmMessages: prep.llmMessages, DEFAULT_TIMEOUT, getLocalizedError, clientLanguage });
        }
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
      sendSSE(client.response, 'stopped', { message: 'Chat stream stopped by client' });
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
