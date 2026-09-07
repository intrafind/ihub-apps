/**
 * OpenAI-compatible inference API (`/api/inference/v1`).
 *
 * A thin wire adapter over the unified `LLMClient`: it validates the request,
 * resolves model + permissions, hands the call to the client (which owns key
 * resolution, throttling, retries, provider parsing and the ledger) and
 * re-emits the normalized GenericChunks in OpenAI chat-completion shape.
 * Tools are forwarded to the model and their calls returned to the caller —
 * nothing is executed server-side on this surface.
 */
import crypto from 'crypto';
import configCache from '../configCache.js';
import { authRequired } from '../middleware/authRequired.js';
import { filterResourcesByPermissions } from '../utils/authorization.js';
import { getLocalizedError } from '../serverHelpers.js';
import {
  convertResponseFromGeneric,
  convertToolCallsFromGeneric,
  convertToolsToGeneric
} from '../adapters/toolCalling/index.js';
import { buildServerPath } from '../utils/basePath.js';
import logger from '../utils/logger.js';
import { recordAppUsage, recordError, recordConversation } from '../telemetry/metrics.js';
import activityTracker from '../telemetry/ActivityTracker.js';
import defaultLlmClient, {
  usageToOpenAI,
  isLLMError,
  LLM_ERROR_CODES
} from '../services/loop/LLMClient.js';

const APP_ID = 'inference-api';

function requestLanguage(req) {
  return (
    req.headers['accept-language']?.split(',')[0] ||
    configCache.getPlatform()?.defaultLanguage ||
    'en'
  );
}

function newCompletionId() {
  return `chatcmpl-${crypto.randomUUID().replace(/-/g, '')}`;
}

/** Collected tool calls (`{index,id,type,function,metadata}`) → generic tool-call shape. */
function toGenericToolCalls(toolCalls) {
  return toolCalls.map(call => ({
    id: call.id,
    name: call.function?.name || '',
    arguments: call.function?.arguments ?? '',
    index: call.index,
    metadata: call.metadata || {}
  }));
}

/**
 * Map an LLMError to the HTTP status of the JSON error envelope. Provider HTTP
 * failures keep the upstream status (as before); client-side classes get the
 * closest HTTP equivalent.
 */
export function inferenceErrorStatus(err) {
  if (!isLLMError(err)) return 500;
  if (typeof err.status === 'number' && err.status >= 400) return err.status;
  switch (err.code) {
    case LLM_ERROR_CODES.AUTH_FAILED:
      // A key that is not configured on the server is a server-side problem
      // (kept at 500 for compatibility with the previous `apiKeyNotFound` reply).
      return String(err.providerCode || '').startsWith('API_KEY') ? 500 : 401;
    case LLM_ERROR_CODES.MODEL_NOT_FOUND:
      return 404;
    case LLM_ERROR_CODES.INVALID_REQUEST:
    case LLM_ERROR_CODES.CONTEXT_WINDOW_EXCEEDED:
      return 400;
    case LLM_ERROR_CODES.RATE_LIMITED:
      return 429;
    case LLM_ERROR_CODES.TIMEOUT:
      return 504;
    case LLM_ERROR_CODES.NETWORK:
      return 502;
    default:
      return 502;
  }
}

function errorEnvelope(err) {
  const body = { error: err.message, code: err.code };
  if (typeof err.details === 'string' && err.details) body.details = err.details;
  return body;
}

export default function registerOpenAIProxyRoutes(app, { llmClient = defaultLlmClient } = {}) {
  const base = buildServerPath('/api/inference');
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
    const models = llmClient.listModels();
    let filtered = models;
    if (req.user && req.user.permissions) {
      const allowed = req.user.permissions.models || new Set();
      filtered = filterResourcesByPermissions(models, allowed);
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
   *               stream_options:
   *                 type: object
   *                 description: "`{ include_usage: true }` appends a usage chunk before [DONE]"
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
   *                 usage:
   *                   type: object
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
      stream_options: streamOptions,
      temperature = 0.7,
      tools = null,
      tool_choice: toolChoice,
      max_tokens: maxTokens
    } = req.body || {};
    const lang = requestLanguage(req);

    logger.info('[OpenAI Proxy] Incoming request', {
      component: 'OpenAIProxy',
      modelId,
      messageCount: Array.isArray(messages) ? messages.length : undefined,
      stream,
      temperature,
      hasTools: !!tools,
      toolNames: Array.isArray(tools) ? tools.map(t => t.function?.name ?? t.name) : null,
      toolChoice,
      maxTokens
    });

    if (!modelId || !messages || !Array.isArray(messages)) {
      const msg = await getLocalizedError('missingRequiredFields', {}, lang);
      return res.status(400).json({ error: msg });
    }

    const model = llmClient.findModel(modelId);
    if (!model) {
      logger.info('[OpenAI Proxy] Model not found', { component: 'OpenAIProxy', modelId });
      const msg = await getLocalizedError('modelNotFound', {}, lang);
      return res.status(404).json({ error: msg });
    }
    if (req.user && req.user.permissions) {
      const allowed = req.user.permissions.models || new Set();
      if (!allowed.has('*') && !allowed.has(modelId)) {
        const msg = await getLocalizedError('modelAccessDenied', {}, lang);
        return res.status(403).json({ error: msg });
      }
    }

    // Convert OpenAI-format tools to the generic format the adapters consume.
    let genericTools = null;
    if (Array.isArray(tools) && tools.length > 0) {
      try {
        genericTools = convertToolsToGeneric(tools, 'openai');
      } catch (error) {
        logger.error('[OpenAI Proxy] Error converting tools to generic format', {
          component: 'OpenAIProxy',
          error
        });
        genericTools = tools;
      }
    }

    const userId = req.user?.id;
    const chatId = `${APP_ID}:${userId || 'anonymous'}`;
    activityTracker.recordActivity({ userId, chatId });
    recordAppUsage(APP_ID, userId, { 'gen_ai.request.model': modelId });
    recordConversation(chatId, messages.length > 2, {
      'app.id': APP_ID,
      'gen_ai.request.model': modelId
    });

    // Abort the upstream call when the client goes away mid-stream. `res` is
    // the reliable signal here: `req` has already been fully consumed by the
    // JSON body parser, so its 'close' event has fired before we get here.
    const upstream = new AbortController();
    let clientDisconnected = false;
    res.on('close', () => {
      if (!res.writableFinished) {
        clientDisconnected = true;
        upstream.abort();
      }
    });

    const run = await llmClient.openRun({
      model,
      language: lang,
      telemetry: {
        kind: 'inference',
        purpose: APP_ID,
        user: req.user || null,
        trigger: { type: 'api', source: APP_ID },
        refs: { appId: APP_ID }
      }
    });

    let llmStream;
    try {
      llmStream = await llmClient.execute({
        model,
        messages,
        options: {
          temperature,
          maxTokens,
          tools: genericTools,
          toolChoice,
          user: req.user
        },
        stream,
        signal: upstream.signal,
        language: lang,
        retries: 0,
        telemetry: {
          runId: run.runId,
          purpose: APP_ID,
          toolExecution: genericTools ? 'caller' : 'none',
          appId: APP_ID,
          userId,
          chatId
        }
      });
    } catch (error) {
      run.fail(error, model);
      if (clientDisconnected || error?.code === LLM_ERROR_CODES.ABORTED) return;
      const status = inferenceErrorStatus(error);
      if (isLLMError(error) && typeof error.status === 'number') {
        logger.error('[OpenAI Proxy] Error response from provider', {
          component: 'OpenAIProxy',
          provider: model.provider,
          status: error.status,
          code: error.code,
          errorText: typeof error.details === 'string' ? error.details.slice(0, 2000) : undefined
        });
        recordError(`http_${error.status}`, 'inference_api', {
          'app.id': APP_ID,
          'gen_ai.request.model': modelId,
          'gen_ai.provider.name': model.provider
        });
      } else {
        logger.error('[OpenAI Proxy] Error occurred', {
          component: 'OpenAIProxy',
          error,
          modelId,
          provider: model.provider,
          stream
        });
      }
      if (!isLLMError(error)) {
        const msg = await getLocalizedError('internalError', {}, lang);
        return res.status(500).json({ error: msg });
      }
      return res.status(status).json(errorEnvelope(error));
    }

    const completionId = newCompletionId();

    if (!stream) {
      try {
        const result = await llmClient.collect(llmStream);
        run.finish(result);
        const response = {
          id: completionId,
          object: 'chat.completion',
          created: Math.floor(Date.now() / 1000),
          model: modelId,
          choices: [
            {
              index: 0,
              message: {
                role: 'assistant',
                content: result.content || null
              },
              finish_reason: result.finishReason || 'stop'
            }
          ],
          usage: usageToOpenAI(result.usage)
        };
        if (result.toolCalls.length > 0) {
          response.choices[0].message.tool_calls = convertToolCallsFromGeneric(
            toGenericToolCalls(result.toolCalls),
            'openai'
          );
        }
        return res.json(response);
      } catch (error) {
        run.fail(error, model);
        if (clientDisconnected || error?.code === LLM_ERROR_CODES.ABORTED) return;
        logger.error('[OpenAI Proxy] Error processing non-streaming response', {
          component: 'OpenAIProxy',
          provider: model.provider,
          error
        });
        if (!isLLMError(error)) {
          const msg = await getLocalizedError('internalError', {}, lang);
          return res.status(500).json({ error: msg });
        }
        return res.status(inferenceErrorStatus(error)).json(errorEnvelope(error));
      }
    }

    // ── Streaming ──────────────────────────────────────────────────────────
    res.status(200);
    res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('X-Accel-Buffering', 'no');
    res.flushHeaders?.();

    const write = obj => {
      if (!clientDisconnected && !res.writableEnded) res.write(`data: ${JSON.stringify(obj)}\n\n`);
    };
    const finish = () => {
      if (!clientDisconnected && !res.writableEnded) {
        res.write('data: [DONE]\n\n');
        res.end();
      }
    };

    let isFirstChunk = true;
    try {
      for await (const chunk of llmStream) {
        if (clientDisconnected) break;
        const hasToolCalls = chunk.tool_calls.length > 0;
        const hasContent = chunk.content.length > 0;
        const wireCtx = { completionId, modelId };

        if (isFirstChunk && hasToolCalls) {
          // OpenAI clients expect the role in its own first chunk, then the calls.
          write(
            convertResponseFromGeneric(
              { content: hasContent ? chunk.content : [], tool_calls: [], complete: false },
              'openai',
              { ...wireCtx, isFirstChunk: true }
            )
          );
          write(
            convertResponseFromGeneric(
              {
                content: [],
                tool_calls: chunk.tool_calls,
                complete: chunk.complete,
                finishReason: chunk.finishReason
              },
              'openai',
              { ...wireCtx, isFirstChunk: false }
            )
          );
          isFirstChunk = false;
        } else if (hasContent || hasToolCalls || chunk.complete) {
          write(convertResponseFromGeneric(chunk, 'openai', { ...wireCtx, isFirstChunk }));
          isFirstChunk = false;
        }
        if (chunk.complete) break;
      }
      const result = llmStream.result();
      run.finish(result);
      if (streamOptions?.include_usage === true && !clientDisconnected) {
        write({
          id: completionId,
          object: 'chat.completion.chunk',
          created: Math.floor(Date.now() / 1000),
          model: modelId,
          choices: [],
          usage: usageToOpenAI(result.usage)
        });
      }
      finish();
    } catch (error) {
      run.fail(error, model);
      if (clientDisconnected || error?.code === LLM_ERROR_CODES.ABORTED) {
        if (!res.writableEnded) res.end();
        return;
      }
      logger.error('[OpenAI Proxy] Error during stream', {
        component: 'OpenAIProxy',
        provider: model.provider,
        code: error?.code,
        error
      });
      // Mid-stream failures are reported in-band the way OpenAI does it.
      write({
        error: {
          message: error?.message || 'stream error',
          type: 'server_error',
          code: isLLMError(error) ? error.code : null
        }
      });
      finish();
    }
  });
}
