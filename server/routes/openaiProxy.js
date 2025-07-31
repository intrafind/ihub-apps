import { getApiKeyForModel } from '../utils.js';
import { createCompletionRequest } from '../adapters/index.js';
import { throttledFetch } from '../requestThrottler.js';
import configCache from '../configCache.js';
import { authRequired } from '../middleware/authRequired.js';
import { filterResourcesByPermissions } from '../utils/authorization.js';
import {
  convertResponseToGeneric,
  convertResponseFromGeneric,
  convertToolCallsFromGeneric,
  convertToolsToGeneric
} from '../adapters/toolCalling/index.js';

export default function registerOpenAIProxyRoutes(app, { getLocalizedError } = {}) {
  const base = '/api/inference';
  app.use(`${base}/v1`, authRequired);

  app.get(`${base}/v1/models`, async (req, res) => {
    const { data: models = [] } = configCache.getModels();
    let filtered = models;
    if (req.user && req.user.permissions) {
      const allowed = req.user.permissions.models || new Set();
      filtered = filterResourcesByPermissions(models, allowed, 'models');
    }
    res.json({ object: 'list', data: filtered.map(m => ({ object: 'model', id: m.id })) });
  });

  app.post(`${base}/v1/chat/completions`, async (req, res) => {
    const {
      model: modelId,
      messages,
      stream = false,
      temperature = 0.7,
      tools = null,
      tool_choice: toolChoice,
      max_tokens: maxTokens
    } = req.body || {};

    console.log(`[OpenAI Proxy] Incoming request:`, {
      modelId,
      messageCount: messages?.length,
      stream,
      temperature,
      hasTools: !!tools,
      tools: JSON.stringify(tools, null, 2),
      toolChoice,
      maxTokens
    });

    if (!modelId || !messages) {
      const lang =
        req.headers['accept-language']?.split(',')[0] ||
        configCache.getPlatform()?.defaultLanguage ||
        'en';
      const msg = getLocalizedError
        ? await getLocalizedError('missingRequiredFields', {}, lang)
        : 'Missing required fields';
      return res.status(400).json({ error: msg });
    }

    const { data: models = [] } = configCache.getModels();
    const model = models.find(m => m.id === modelId);
    if (!model) {
      console.log(`[OpenAI Proxy] Model not found: ${modelId}`);
      console.log(
        `[OpenAI Proxy] Available models:`,
        models.map(m => m.id)
      );
      const lang =
        req.headers['accept-language']?.split(',')[0] ||
        configCache.getPlatform()?.defaultLanguage ||
        'en';
      const msg = getLocalizedError
        ? await getLocalizedError('modelNotFound', {}, lang)
        : 'Model not found';
      return res.status(404).json({ error: msg });
    }
    if (req.user && req.user.permissions) {
      const allowed = req.user.permissions.models || new Set();
      if (!allowed.has('*') && !allowed.has(modelId)) {
        const lang =
          req.headers['accept-language']?.split(',')[0] ||
          configCache.getPlatform()?.defaultLanguage ||
          'en';
        const msg = getLocalizedError
          ? await getLocalizedError('modelAccessDenied', {}, lang)
          : 'Model access denied';
        return res.status(403).json({ error: msg });
      }
    }

    console.log(`[OpenAI Proxy] Found model:`, {
      id: model.id,
      provider: model.provider,
      modelId: model.modelId,
      url: model.url
    });

    // Log first message for debugging (truncated for privacy)
    if (messages && messages.length > 0) {
      console.log(`[OpenAI Proxy] First message:`, {
        role: messages[0].role,
        contentLength: messages[0].content?.length,
        contentPreview: messages[0].content?.substring(0, 100) + '...'
      });
    }

    const apiKey = await getApiKeyForModel(modelId);
    if (!apiKey) {
      console.log(`[OpenAI Proxy] API key not found for model: ${modelId}`);
      const lang =
        req.headers['accept-language']?.split(',')[0] ||
        configCache.getPlatform()?.defaultLanguage ||
        'en';
      const msg = getLocalizedError
        ? await getLocalizedError('apiKeyNotFound', { provider: model.provider }, lang)
        : 'API key not configured';
      return res.status(500).json({ error: msg });
    }

    // Convert OpenAI-format tools to generic format for use with our adapters
    let genericTools = null;
    if (tools && Array.isArray(tools) && tools.length > 0) {
      try {
        console.log(`[OpenAI Proxy] Converting ${tools.length} OpenAI tools to generic format`);
        genericTools = convertToolsToGeneric(tools, 'openai');
        console.log(`[OpenAI Proxy] Converted to ${genericTools.length} generic tools:`, 
                   genericTools.map(t => ({ id: t.id, name: t.name })));
      } catch (error) {
        console.error(`[OpenAI Proxy] Error converting tools to generic format:`, error);
        genericTools = tools; // Fallback to original tools
      }
    }

    const request = createCompletionRequest(model, messages, apiKey, {
      stream,
      temperature,
      maxTokens,
      tools: genericTools,
      toolChoice
    });

    console.log(`[OpenAI Proxy] Request prepared for ${model.provider}:`, {
      url: request.url,
      bodySize: JSON.stringify(request.body).length,
      stream
    });

    try {
      const startTime = Date.now();
      const llmResponse = await throttledFetch(model.id, request.url, {
        method: 'POST',
        headers: request.headers,
        body: JSON.stringify(request.body)
      });

      console.log(`[OpenAI Proxy] Response received:`, {
        status: llmResponse.status,
        statusText: llmResponse.statusText,
        responseTime: Date.now() - startTime,
        headers: Object.fromEntries(llmResponse.headers.entries())
      });

      res.status(llmResponse.status);
      for (const [key, value] of llmResponse.headers) {
        if (key.toLowerCase() === 'content-type') {
          res.setHeader(key, value);
        }
      }
      if (stream) {
        console.log(`[OpenAI Proxy] Starting streaming response for provider: ${model.provider}`);

        // Use generic tool calling system for all providers
        const reader = llmResponse.body.getReader();
        const decoder = new TextDecoder();
        let chunkCount = 0;
        let buffer = '';

        // Generate a unique ID for this completion
        const completionId = `chatcmpl-${Date.now()}${Math.random().toString(36).substring(2, 11)}`;
        let isFirstChunk = true;

        try {
          while (true) {
            const { done, value } = await reader.read();
            if (done) break;

            const chunk = decoder.decode(value, { stream: true });
            buffer += chunk;

            // Process complete lines/events
            const lines = buffer.split('\n');
            buffer = lines.pop() || ''; // Keep incomplete line in buffer

            for (const line of lines) {
              const trimmedLine = line.trim();
              if (!trimmedLine) continue;

              // Skip SSE event type lines (e.g., "event: message_start")
              if (trimmedLine.startsWith('event:')) {
                continue;
              }

              let data = trimmedLine;

              // Remove SSE data prefix if present
              if (trimmedLine.startsWith('data: ')) {
                data = trimmedLine.substring(6);
              }

              // Skip empty data lines or special SSE markers
              if (!data || data === '[DONE]') {
                if (data === '[DONE]') {
                  res.write('data: [DONE]\n\n');
                }
                continue;
              }

              try {
                // Use generic tool calling system to normalize response
                console.log(`[OpenAI Proxy] Raw ${model.provider} data:`, data);
                const genericResult = convertResponseToGeneric(data, model.provider);
                console.log(
                  `[OpenAI Proxy] Generic result:`,
                  JSON.stringify(genericResult, null, 2)
                );

                // Handle first chunk with tool calls - need to send separate chunks for OpenAI compatibility
                const hasToolCalls = genericResult.tool_calls && genericResult.tool_calls.length > 0;
                const hasContent = genericResult.content && genericResult.content.length > 0;
                
                if (isFirstChunk && hasToolCalls) {
                  // Send role-only chunk first
                  const roleChunk = convertResponseFromGeneric(
                    { content: hasContent ? genericResult.content : [], tool_calls: [], complete: false }, 
                    'openai', 
                    { completionId, modelId, isFirstChunk: true }
                  );
                  
                  if (roleChunk) {
                    chunkCount++;
                    console.log(
                      `[OpenAI Proxy] Sending role chunk:`,
                      JSON.stringify(roleChunk, null, 2)
                    );
                    res.write(`data: ${JSON.stringify(roleChunk)}\n\n`);
                  }
                  
                  // Send function call chunk second
                  const toolChunk = convertResponseFromGeneric(
                    { content: [], tool_calls: genericResult.tool_calls, complete: genericResult.complete, finishReason: genericResult.finishReason }, 
                    'openai', 
                    { completionId, modelId, isFirstChunk: false }
                  );
                  
                  if (toolChunk) {
                    chunkCount++;
                    console.log(
                      `[OpenAI Proxy] Sending tool chunk:`,
                      JSON.stringify(toolChunk, null, 2)
                    );
                    res.write(`data: ${JSON.stringify(toolChunk)}\n\n`);
                  }
                  
                  isFirstChunk = false;
                } else {
                  // Normal single chunk processing
                  const openAIChunk = convertResponseFromGeneric(genericResult, 'openai', {
                    completionId,
                    modelId,
                    isFirstChunk
                  });

                  if (
                    openAIChunk &&
                    (genericResult.content.length > 0 ||
                      genericResult.tool_calls.length > 0 ||
                      genericResult.complete)
                  ) {
                    chunkCount++;
                    isFirstChunk = false;
                    console.log(
                      `[OpenAI Proxy] Sending OpenAI chunk:`,
                      JSON.stringify(openAIChunk, null, 2)
                    );
                    res.write(`data: ${JSON.stringify(openAIChunk)}\n\n`);
                  }
                }
              } catch (error) {
                console.error(`[OpenAI Proxy] Error processing ${model.provider} chunk:`, error);
                // Continue processing other chunks
              }
            }
          }

          // Process any remaining buffer
          if (buffer.trim()) {
            const trimmedBuffer = buffer.trim();

            // Skip if it's an SSE event line
            if (!trimmedBuffer.startsWith('event:')) {
              let data = trimmedBuffer;

              // Remove SSE data prefix if present
              if (trimmedBuffer.startsWith('data: ')) {
                data = trimmedBuffer.substring(6);
              }

              // Process if it's not empty or a special marker
              if (data && data !== '[DONE]') {
                try {
                  console.log(`[OpenAI Proxy] Raw ${model.provider} buffer data:`, data);
                  const genericResult = convertResponseToGeneric(data, model.provider);
                  console.log(
                    `[OpenAI Proxy] Generic buffer result:`,
                    JSON.stringify(genericResult, null, 2)
                  );

                  const openAIChunk = convertResponseFromGeneric(genericResult, 'openai', {
                    completionId,
                    modelId,
                    isFirstChunk
                  });

                  if (
                    openAIChunk &&
                    (genericResult.content.length > 0 || genericResult.tool_calls.length > 0)
                  ) {
                    chunkCount++;
                    console.log(
                      `[OpenAI Proxy] Sending buffer chunk to client:`,
                      JSON.stringify(openAIChunk, null, 2)
                    );
                    res.write(`data: ${JSON.stringify(openAIChunk)}\n\n`);
                  }
                } catch (error) {
                  console.error(`[OpenAI Proxy] Error processing ${model.provider} buffer:`, error);
                }
              }
            }
          }
        } finally {
          reader.releaseLock();
        }

        console.log(
          `[OpenAI Proxy] ${model.provider} streaming complete. Total chunks: ${chunkCount}`
        );
        res.write('data: [DONE]\n\n');
        res.end();
      } else {
        const data = await llmResponse.text();
        console.log(`[OpenAI Proxy] Non-streaming response:`, {
          responseLength: data.length,
          responsePreview: data.substring(0, 200) + '...',
          provider: model.provider
        });

        // Use generic tool calling system for all providers
        try {
          console.log(`[OpenAI Proxy] Non-streaming response from ${model.provider}:`, {
            responseLength: data.length,
            responsePreview: data.substring(0, 200) + '...'
          });

          // Convert provider response to generic format, then to OpenAI format
          const genericResult = convertResponseToGeneric(data, model.provider);
          console.log(`[OpenAI Proxy] Generic result:`, JSON.stringify(genericResult, null, 2));

          const completionId = `chatcmpl-${Date.now()}${Math.random().toString(36).substring(2, 11)}`;

          // Convert to OpenAI non-streaming format
          const openAIResponse = {
            id: completionId,
            object: 'chat.completion',
            created: Math.floor(Date.now() / 1000),
            model: modelId,
            choices: [
              {
                index: 0,
                message: {
                  role: 'assistant',
                  content: genericResult.content.join('') || null
                },
                finish_reason: genericResult.finishReason || 'stop'
              }
            ],
            usage: {
              prompt_tokens: 0,
              completion_tokens: 0,
              total_tokens: 0
            }
          };

          // Add tool calls if present
          if (genericResult.tool_calls && genericResult.tool_calls.length > 0) {
            const openAIToolCalls = convertToolCallsFromGeneric(genericResult.tool_calls, 'openai');
            openAIResponse.choices[0].message.tool_calls = openAIToolCalls;
          }

          console.log(
            `[OpenAI Proxy] Sending non-streaming response to client:`,
            JSON.stringify(openAIResponse, null, 2)
          );
          res.json(openAIResponse);
        } catch (error) {
          console.error('[OpenAI Proxy] Error processing non-streaming response:', error);
          // Fallback: try to parse as JSON and send as-is
          try {
            const parsed = JSON.parse(data);
            res.json(parsed);
          } catch {
            res.send(data); // Last resort: send raw data
          }
        }
      }
    } catch (err) {
      console.error('[OpenAI Proxy] Error occurred:', {
        error: err.message,
        stack: err.stack,
        modelId,
        provider: model?.provider,
        stream
      });
      const lang =
        req.headers['accept-language']?.split(',')[0] ||
        configCache.getPlatform()?.defaultLanguage ||
        'en';
      const msg = getLocalizedError
        ? await getLocalizedError('internalError', {}, lang)
        : 'Internal server error';
      res.status(500).json({ error: msg });
    }
  });
}
