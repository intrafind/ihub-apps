import { getApiKeyForModel } from '../utils.js';
import { createCompletionRequest, processResponseBuffer } from '../adapters/index.js';
import { throttledFetch } from '../requestThrottler.js';
import configCache from '../configCache.js';
import { authRequired } from '../middleware/authRequired.js';
import { filterResourcesByPermissions } from '../utils/authorization.js';

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

    const request = createCompletionRequest(model, messages, apiKey, {
      stream,
      temperature,
      maxTokens,
      tools,
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

        // For OpenAI provider, pass through directly
        if (model.provider === 'openai') {
          const reader = llmResponse.body.getReader();
          const decoder = new TextDecoder();
          let chunkCount = 0;

          try {
            while (true) {
              const { done, value } = await reader.read();
              if (done) {
                console.log(
                  `[OpenAI Proxy] OpenAI streaming complete. Total chunks: ${chunkCount}`
                );
                break;
              }
              const chunk = decoder.decode(value, { stream: true });
              chunkCount++;
              console.log(`[OpenAI Proxy] OpenAI passthrough chunk:`, chunk);
              res.write(chunk);
            }
          } finally {
            reader.releaseLock();
          }
        } else {
          // For other providers, transform to OpenAI format
          const reader = llmResponse.body.getReader();
          const decoder = new TextDecoder();

          // Generate a unique ID for this completion
          const completionId = `chatcmpl-${Date.now()}${Math.random().toString(36).substring(2, 11)}`;
          let isFirstChunk = true;
          let chunkCount = 0;
          let buffer = '';

          try {
            while (true) {
              const { done, value } = await reader.read();
              if (done) break;

              const chunk = decoder.decode(value, { stream: true });
              buffer += chunk;

              // Try to process complete lines/events
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
                  continue;
                }

                // Process the data through the adapter
                console.log(`[OpenAI Proxy] Raw ${model.provider} data:`, data);
                const result = processResponseBuffer(model.provider, data);
                console.log(
                  `[OpenAI Proxy] Processed ${model.provider} result:`,
                  JSON.stringify(result, null, 2)
                );

                if (result && result.content && result.content.length > 0) {
                  for (const textContent of result.content) {
                    chunkCount++;
                    const openAIChunk = {
                      id: completionId,
                      object: 'chat.completion.chunk',
                      created: Math.floor(Date.now() / 1000),
                      model: modelId,
                      choices: [
                        {
                          index: 0,
                          delta: isFirstChunk
                            ? { role: 'assistant', content: textContent }
                            : { content: textContent },
                          finish_reason: null
                        }
                      ]
                    };
                    isFirstChunk = false;
                    console.log(
                      `[OpenAI Proxy] Sending chunk to client:`,
                      JSON.stringify(openAIChunk, null, 2)
                    );
                    res.write(`data: ${JSON.stringify(openAIChunk)}\n\n`);
                  }
                }

                // Handle tool calls
                if (result && result.tool_calls && result.tool_calls.length > 0) {
                  chunkCount++;
                  const toolCallChunk = {
                    id: completionId,
                    object: 'chat.completion.chunk',
                    created: Math.floor(Date.now() / 1000),
                    model: modelId,
                    choices: [
                      {
                        index: 0,
                        delta: isFirstChunk
                          ? { role: 'assistant', tool_calls: result.tool_calls }
                          : { tool_calls: result.tool_calls },
                        finish_reason: null
                      }
                    ]
                  };
                  isFirstChunk = false;
                  console.log(
                    `[OpenAI Proxy] Sending tool call chunk to client:`,
                    JSON.stringify(toolCallChunk, null, 2)
                  );
                  res.write(`data: ${JSON.stringify(toolCallChunk)}\n\n`);
                }

                if (result && result.complete) {
                  // Send final chunk with finish_reason
                  const finalChunk = {
                    id: completionId,
                    object: 'chat.completion.chunk',
                    created: Math.floor(Date.now() / 1000),
                    model: modelId,
                    choices: [
                      {
                        index: 0,
                        delta: {},
                        finish_reason: result.finishReason || 'stop'
                      }
                    ]
                  };
                  console.log(
                    `[OpenAI Proxy] Sending final chunk to client:`,
                    JSON.stringify(finalChunk, null, 2)
                  );
                  res.write(`data: ${JSON.stringify(finalChunk)}\n\n`);
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
                  console.log(`[OpenAI Proxy] Raw ${model.provider} buffer data:`, data);
                  const result = processResponseBuffer(model.provider, data);
                  console.log(
                    `[OpenAI Proxy] Processed ${model.provider} buffer result:`,
                    JSON.stringify(result, null, 2)
                  );
                  if (result && result.content && result.content.length > 0) {
                    for (const textContent of result.content) {
                      chunkCount++;
                      const openAIChunk = {
                        id: completionId,
                        object: 'chat.completion.chunk',
                        created: Math.floor(Date.now() / 1000),
                        model: modelId,
                        choices: [
                          {
                            index: 0,
                            delta: isFirstChunk
                              ? { role: 'assistant', content: textContent }
                              : { content: textContent },
                            finish_reason: null
                          }
                        ]
                      };
                      isFirstChunk = false;
                      console.log(
                        `[OpenAI Proxy] Sending buffer chunk to client:`,
                        JSON.stringify(openAIChunk, null, 2)
                      );
                      res.write(`data: ${JSON.stringify(openAIChunk)}\n\n`);
                    }
                  }

                  // Handle tool calls in buffer processing
                  if (result && result.tool_calls && result.tool_calls.length > 0) {
                    chunkCount++;
                    const toolCallChunk = {
                      id: completionId,
                      object: 'chat.completion.chunk',
                      created: Math.floor(Date.now() / 1000),
                      model: modelId,
                      choices: [
                        {
                          index: 0,
                          delta: isFirstChunk
                            ? { role: 'assistant', tool_calls: result.tool_calls }
                            : { tool_calls: result.tool_calls },
                          finish_reason: null
                        }
                      ]
                    };
                    isFirstChunk = false;
                    console.log(
                      `[OpenAI Proxy] Sending buffer tool call chunk to client:`,
                      JSON.stringify(toolCallChunk, null, 2)
                    );
                    res.write(`data: ${JSON.stringify(toolCallChunk)}\n\n`);
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
        }
        res.end();
      } else {
        const data = await llmResponse.text();
        console.log(`[OpenAI Proxy] Non-streaming response:`, {
          responseLength: data.length,
          responsePreview: data.substring(0, 200) + '...',
          provider: model.provider
        });

        // For OpenAI provider, pass through directly
        if (model.provider === 'openai') {
          console.log(
            `[OpenAI Proxy] OpenAI passthrough response:`,
            data.substring(0, 1000) + '...'
          );
          res.send(data);
        } else {
          // For other providers, transform to OpenAI format
          try {
            const parsed = JSON.parse(data);
            let content = '';
            let finishReason = 'stop';

            // Handle different provider response formats
            if (model.provider === 'google' && parsed.candidates) {
              content = parsed.candidates[0]?.content?.parts?.[0]?.text || '';
              finishReason = parsed.candidates[0]?.finishReason || 'stop';
            } else if (model.provider === 'anthropic' && parsed.content) {
              content = parsed.content[0]?.text || '';
              finishReason = parsed.stop_reason || 'stop';
            } else if (model.provider === 'mistral' && parsed.choices) {
              content = parsed.choices[0]?.message?.content || '';
              finishReason = parsed.choices[0]?.finish_reason || 'stop';
            }

            // Create OpenAI-compatible response
            const openAIResponse = {
              id: `chatcmpl-${Date.now()}${Math.random().toString(36).substring(2, 11)}`,
              object: 'chat.completion',
              created: Math.floor(Date.now() / 1000),
              model: modelId,
              choices: [
                {
                  index: 0,
                  message: {
                    role: 'assistant',
                    content: content
                  },
                  finish_reason: finishReason
                }
              ],
              usage: {
                prompt_tokens: 0,
                completion_tokens: 0,
                total_tokens: 0
              }
            };

            console.log(
              `[OpenAI Proxy] Sending non-streaming response to client:`,
              JSON.stringify(openAIResponse, null, 2)
            );
            res.json(openAIResponse);
          } catch (error) {
            console.error('[OpenAI Proxy] Error parsing non-streaming response:', error);
            res.send(data); // Fallback to original response
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
