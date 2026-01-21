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
import { buildServerPath } from '../utils/basePath.js';
import { getGenAIInstrumentation } from '../telemetry.js';
import { recordAppUsage, recordError, recordConversation } from '../telemetry/metrics.js';

export default function registerOpenAIProxyRoutes(app, { getLocalizedError, basePath = '' } = {}) {
  const base = buildServerPath('/api/inference', basePath);
  app.use(`${base}/v1`, authRequired);

  /**
   * @swagger
   * /inference/v1/models:
   *   get:
   *     summary: List available models (OpenAI Compatible)
   *     description: Returns a list of available models in OpenAI-compatible format
   *     tags:
   *       - OpenAI Compatible
   *     security:
   *       - bearerAuth: []
   *       - sessionAuth: []
   *     responses:
   *       200:
   *         description: List of available models
   *         content:
   *           application/json:
   *             schema:
   *               type: object
   *               properties:
   *                 object:
   *                   type: string
   *                   example: "list"
   *                 data:
   *                   type: array
   *                   items:
   *                     type: object
   *                     properties:
   *                       object:
   *                         type: string
   *                         example: "model"
   *                       id:
   *                         type: string
   *                         description: Model identifier
   *       401:
   *         description: Authentication required
   */
  app.get(`${base}/v1/models`, async (req, res) => {
    const { data: models = [] } = configCache.getModels();
    let filtered = models;
    if (req.user && req.user.permissions) {
      const allowed = req.user.permissions.models || new Set();
      filtered = filterResourcesByPermissions(models, allowed, 'models');
    }
    res.json({ object: 'list', data: filtered.map(m => ({ object: 'model', id: m.id })) });
  });

  /**
   * @swagger
   * /inference/v1/chat/completions:
   *   post:
   *     summary: Create chat completion (OpenAI Compatible)
   *     description: Creates a completion for the chat message in OpenAI-compatible format
   *     tags:
   *       - OpenAI Compatible
   *     security:
   *       - bearerAuth: []
   *       - sessionAuth: []
   *     requestBody:
   *       required: true
   *       content:
   *         application/json:
   *           schema:
   *             type: object
   *             required:
   *               - model
   *               - messages
   *             properties:
   *               model:
   *                 type: string
   *                 description: ID of the model to use
   *               messages:
   *                 type: array
   *                 description: A list of messages comprising the conversation so far
   *                 items:
   *                   type: object
   *                   properties:
   *                     role:
   *                       type: string
   *                       enum: [system, user, assistant, tool]
   *                     content:
   *                       type: string
   *                       description: The contents of the message
   *               temperature:
   *                 type: number
   *                 minimum: 0
   *                 maximum: 2
   *                 default: 0.7
   *                 description: Sampling temperature to use
   *               stream:
   *                 type: boolean
   *                 default: false
   *                 description: Whether to stream back partial results
   *               max_tokens:
   *                 type: integer
   *                 description: Maximum number of tokens to generate
   *               tools:
   *                 type: array
   *                 description: List of tools the model may call
   *               tool_choice:
   *                 oneOf:
   *                   - type: string
   *                     enum: [none, auto]
   *                   - type: object
   *                 description: Controls which tool is called by the model
   *     responses:
   *       200:
   *         description: Chat completion response
   *         content:
   *           application/json:
   *             schema:
   *               type: object
   *               properties:
   *                 id:
   *                   type: string
   *                 object:
   *                   type: string
   *                   example: "chat.completion"
   *                 created:
   *                   type: integer
   *                 model:
   *                   type: string
   *                 choices:
   *                   type: array
   *                   items:
   *                     type: object
   *       401:
   *         description: Authentication required
   *       400:
   *         description: Bad request
   */
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

    // Track inference API usage
    recordAppUsage('inference-api', req.user?.id, {
      'model.id': modelId,
      'api.endpoint': '/v1/chat/completions'
    });

    // Track if this is a follow-up message (more than 1 message in history)
    const isFollowUp = messages && messages.length > 2;
    if (messages) {
      recordConversation('inference-api', isFollowUp, {
        'model.id': modelId,
        'message.count': messages.length
      });
    }

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

    const apiKey = await getApiKeyForModel(modelId);
    if (!apiKey) {
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
        genericTools = convertToolsToGeneric(tools, 'openai');
      } catch (error) {
        console.error(`[OpenAI Proxy] Error converting tools to generic format:`, error);
        genericTools = tools; // Fallback to original tools
      }
    }

    try {
      const request = createCompletionRequest(model, messages, apiKey, {
        stream,
        temperature,
        maxTokens,
        tools: genericTools,
        toolChoice,
        user: req.user // Pass user context to adapters that need it
      });

      const startTime = Date.now();
      const llmResponse = await throttledFetch(model.id, request.url, {
        method: 'POST',
        headers: request.headers,
        body: JSON.stringify(request.body)
      });

      res.status(llmResponse.status);
      for (const [key, value] of llmResponse.headers) {
        if (key.toLowerCase() === 'content-type') {
          res.setHeader(key, value);
        }
      }
      //TODO check response status and handle errors
      if (!llmResponse.ok) {
        const errorText = await llmResponse.text();
        console.error(`[OpenAI Proxy] Error response from ${model.provider}:`, {
          status: llmResponse.status,
          statusText: llmResponse.statusText,
          errorText: errorText
        });
        
        // Record error metric
        recordError(`http_${llmResponse.status}`, 'inference_api', {
          'model.id': modelId,
          'provider': model.provider,
          'user.id': req.user?.id
        });
        
        const lang =
          req.headers['accept-language']?.split(',')[0] ||
          configCache.getPlatform()?.defaultLanguage ||
          'en';
        const msg = getLocalizedError
          ? await getLocalizedError('providerError', { provider: model.provider }, lang)
          : 'Provider error';
        return res.status(llmResponse.status).json({ error: msg, details: errorText });
      }
      if (stream) {
        // Use generic tool calling system for all providers
        const reader = llmResponse.body.getReader();
        const decoder = new TextDecoder();
        let chunkCount = 0;
        let buffer = '';

        // Generate a unique ID for this completion
        const completionId = `chatcmpl-${Date.now()}${Math.random().toString(36).substring(2, 11)}`;
        const streamId = completionId; // Use completion ID as stream ID for state isolation
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
                // Debug logging for iAssistant
                if (model.provider === 'iassistant') {
                  console.log(
                    '[OpenAI Proxy] Processing iAssistant data:',
                    data.substring(0, 200) + '...'
                  );
                }

                // Use generic tool calling system to normalize response
                const genericResult = convertResponseToGeneric(data, model.provider, streamId);

                // Handle first chunk with tool calls - need to send separate chunks for OpenAI compatibility
                const hasToolCalls =
                  genericResult.tool_calls && genericResult.tool_calls.length > 0;
                const hasContent = genericResult.content && genericResult.content.length > 0;

                if (isFirstChunk && hasToolCalls) {
                  // Send role-only chunk first
                  const roleChunk = convertResponseFromGeneric(
                    {
                      content: hasContent ? genericResult.content : [],
                      tool_calls: [],
                      complete: false
                    },
                    'openai',
                    { completionId, modelId, isFirstChunk: true }
                  );

                  if (roleChunk) {
                    chunkCount++;
                    res.write(`data: ${JSON.stringify(roleChunk)}\n\n`);
                  }

                  // Send function call chunk second
                  const toolChunk = convertResponseFromGeneric(
                    {
                      content: [],
                      tool_calls: genericResult.tool_calls,
                      complete: genericResult.complete,
                      finishReason: genericResult.finishReason
                    },
                    'openai',
                    { completionId, modelId, isFirstChunk: false }
                  );

                  if (toolChunk) {
                    chunkCount++;
                    res.write(`data: ${JSON.stringify(toolChunk)}\n\n`);
                  }

                  // Check if this chunk indicates completion
                  if (genericResult.complete) {
                    res.write('data: [DONE]\n\n');
                    res.end();
                    return; // Exit the entire streaming function
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
                    res.write(`data: ${JSON.stringify(openAIChunk)}\n\n`);

                    // Check if this chunk indicates completion
                    if (genericResult.complete) {
                      res.write('data: [DONE]\n\n');
                      res.end();
                      return; // Exit the entire streaming function
                    }
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
                  const genericResult = convertResponseToGeneric(data, model.provider, streamId);

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

        res.write('data: [DONE]\n\n');
        res.end();
      } else {
        const data = await llmResponse.text();

        // Use generic tool calling system for all providers
        try {
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
