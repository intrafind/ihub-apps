/**
 * OpenAI-compatible inference API (`/api/inference/v1`).
 *
 * `model` names either a plain model or an iHub app
 * (`app:<appId>[/<modelId>]`, see services/inference/modelIdentifier.js):
 *
 *   - a plain model goes straight through the unified `LLMClient`, which owns
 *     key resolution, throttling, retries, provider parsing and the ledger;
 *     this route re-emits the normalized GenericChunks in OpenAI
 *     chat-completion shape. Tools are forwarded to the model and their calls
 *     returned to the caller — nothing is executed server-side on this path.
 *   - an app runs its full server-side configuration (system prompt,
 *     variables, sources, tools, output schema) through the chat pipeline,
 *     stateless: the caller sends the history, and the app's prompt template
 *     wraps the last user message only.
 *
 * Structured output (`response_format`, or the app's `outputSchema`) is
 * validated server-side before an answer is returned as a success.
 *
 * `/responses` and `/conversations` are registered from here too, so every
 * route of the API sits behind the same `authRequired` mount.
 */
import crypto from 'crypto';
import { authRequired } from '../middleware/authRequired.js';
import { filterResourcesByPermissions } from '../utils/authorization.js';
import { getLocalizedError as defaultGetLocalizedError } from '../serverHelpers.js';
import {
  convertResponseFromGeneric,
  convertToolCallsFromGeneric,
  convertToolsToGeneric
} from '../adapters/toolCalling/index.js';
import { buildServerPath } from '../utils/basePath.js';
import logger from '../utils/logger.js';
import {
  recordAppUsage,
  recordError,
  recordConversation,
  recordStructuredOutputValidation
} from '../telemetry/metrics.js';
import activityTracker from '../telemetry/ActivityTracker.js';
import defaultLlmClient, {
  usageToOpenAI,
  isLLMError,
  LLM_ERROR_CODES
} from '../services/loop/LLMClient.js';
import ChatService from '../services/chat/ChatService.js';
import { RunStreamEmitter } from '../services/loop/RunStream.js';
import { newRunId } from '../services/loop/RunLog.js';
import { SSE_V2_EVENTS } from '../../shared/runEvents.js';
import { activeRequests } from '../sse.js';
import {
  InferenceApiError,
  inferenceErrorStatus,
  isInferenceApiError,
  sendFlatError
} from '../services/inference/errors.js';
import {
  APP_MODEL_PREFIX,
  isModelPermitted,
  listInvocableApps,
  resolveInferenceTarget
} from '../services/inference/modelIdentifier.js';
import {
  assertNoPromptForModel,
  resolvePromptVariables
} from '../services/inference/promptVariables.js';
import {
  adapterOptionsFor,
  assertStructuredOutputSupported,
  createOutputValidator,
  outputValidationError,
  parseResponseFormat,
  structuredOutputSupport,
  validationRequested
} from '../services/inference/structuredOutput.js';
import {
  liftJsonToolChunk,
  liftJsonToolResult,
  runPlainTurn,
  withJsonInstruction
} from '../services/inference/plainTurn.js';
import { messagesFromChatCompletions } from '../services/inference/inputContent.js';
import { appTurnError, executeAppTurn, prepareAppTurn } from '../services/inference/appTurn.js';
import { apiUser, numberField, platformLanguage, requestLanguage } from './inference/shared.js';
import registerResponsesRoutes from './inference/responses.js';
import registerConversationsRoutes from './inference/conversations.js';

export { inferenceErrorStatus } from '../services/inference/errors.js';

const APP_ID = 'inference-api';

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

function errorEnvelope(err) {
  const body = { error: err.message, code: err.code };
  if (typeof err.details === 'string' && err.details) body.details = err.details;
  return body;
}

/** OpenAI finish reasons from the loop's. */
function openAiFinishReason(finishReason) {
  if (finishReason === 'length' || finishReason === 'max_tokens') return 'length';
  return 'stop';
}

/** The in-band error of a stream that failed after it started. */
function inBandError(error) {
  return {
    error: {
      message: error?.message || 'stream error',
      type:
        isInferenceApiError(error) && error.status < 500 ? 'invalid_request_error' : 'server_error',
      code: isInferenceApiError(error) || isLLMError(error) ? error.code : null,
      ...(isInferenceApiError(error) && error.details !== undefined
        ? { details: error.details }
        : {})
    }
  };
}

export default function registerOpenAIProxyRoutes(
  app,
  {
    llmClient = defaultLlmClient,
    // The shared chat pipeline for app models; tests inject one on a fake transport.
    chatService = new ChatService(),
    getLocalizedError = defaultGetLocalizedError,
    DEFAULT_TIMEOUT
  } = {}
) {
  const base = buildServerPath('/api/inference');
  app.use(`${base}/v1`, authRequired);

  /**
   * @swagger
   * /inference/v1/models:
   *   get:
   *     summary: List available models and apps (OpenAI Compatible)
   *     description: |
   *       Returns the models the caller may use, followed by the apps the caller may call,
   *       as `app:<appId>`. An app runs on its default model; `app:<appId>/<modelId>` picks a
   *       real model (see `GET /api/apps/{appId}` for `preferredModel` and `allowedModels`)
   *       and is accepted in requests but never listed.
   *     tags:
   *       - OpenAI Compatible
   *     security:
   *       - bearerAuth: []
   *       - sessionAuth: []
   *     responses:
   *       200:
   *         description: List of available models and apps
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
   *                         description: Model identifier, or `app:<appId>` for an app
   *                         example: "app:nda-risk-analyzer"
   *       401:
   *         description: Authentication required
   */
  app.get(`${base}/v1/models`, async (req, res) => {
    const user = apiUser(req);
    // Fails closed: without a principal carrying permissions no model is listed.
    const filtered = filterResourcesByPermissions(
      llmClient.listModels(),
      user?.permissions?.models || new Set()
    );
    let apps = [];
    try {
      apps = listInvocableApps(user);
    } catch (error) {
      logger.warn('[OpenAI Proxy] Could not list apps', { component: 'OpenAIProxy', error });
    }
    res.json({
      object: 'list',
      data: [
        ...filtered.map(m => ({ object: 'model', id: m.id })),
        ...apps.map(a => ({ object: 'model', id: `${APP_MODEL_PREFIX}${a.id}` }))
      ]
    });
  });

  /**
   * @swagger
   * /inference/v1/chat/completions:
   *   post:
   *     summary: Create chat completion (OpenAI Compatible)
   *     description: |
   *       Creates a completion for the chat message in OpenAI-compatible format. Always
   *       stateless: the caller sends the history.
   *
   *       `model` is a model id, or an app: `app:<appId>` (the app's default model) or
   *       `app:<appId>/<modelId>`. An app runs its server-side configuration — system prompt,
   *       variables, sources, tools, output schema — and its prompt template wraps the last user
   *       message. App variables go in `prompt.variables` (`extra_body` in the SDKs). The
   *       response echoes the resolved `app:<appId>/<modelId>` in `model`.
   *
   *       Structured output (`response_format`, or the app's `outputSchema`) is validated
   *       server-side; an answer that does not validate is retried once and otherwise answered
   *       with `422 output_validation_failed`. Streamed answers are validated at the end and
   *       fail in-band. Opt out with `?validate=false` or `validate: false`.
   *     tags:
   *       - OpenAI Compatible
   *     security:
   *       - bearerAuth: []
   *       - sessionAuth: []
   *     parameters:
   *       - in: query
   *         name: validate
   *         schema:
   *           type: boolean
   *           default: true
   *         description: Validate structured output server-side
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
   *                 description: Model id, `app:<appId>` or `app:<appId>/<modelId>`
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
   *                       description: |
   *                         A string, or content parts. For apps: `text`, `image_url` (data URL)
   *                         and `file` (`file_data` as a data URL; PDF, Word (.docx), PowerPoint (.pptx) and text files). System
   *                         messages are refused for apps — the app's prompt applies.
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
   *                 description: List of tools the model may call (plain models only)
   *               tool_choice:
   *                 oneOf:
   *                   - type: string
   *                     enum: [none, auto]
   *                   - type: object
   *                 description: Controls which tool is called by the model
   *               response_format:
   *                 type: object
   *                 description: |
   *                   `{ type: "text" | "json_object" }` or
   *                   `{ type: "json_schema", json_schema: { name, schema, strict } }` (plain
   *                   models only; an app's output schema comes from the app)
   *               prompt:
   *                 type: object
   *                 description: "Apps only: `{ id?, variables }` — app variables"
   *                 properties:
   *                   id:
   *                     type: string
   *                     description: Optional; must equal the app in `model`
   *                   variables:
   *                     type: object
   *                     additionalProperties: true
   *               validate:
   *                 type: boolean
   *                 default: true
   *                 description: Validate structured output server-side
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
   *       400:
   *         description: Bad request (invalid model identifier, app variables, response_format, …)
   *       401:
   *         description: Authentication required
   *       403:
   *         description: The caller may not use the model
   *       404:
   *         description: Model or app not found
   *       422:
   *         description: The answer did not match the output schema
   */
  app.post(`${base}/v1/chat/completions`, async (req, res) => {
    const modelParam = req.body?.model;
    if (typeof modelParam === 'string' && modelParam.startsWith(APP_MODEL_PREFIX)) {
      return handleAppCompletion(req, res);
    }
    return handleModelCompletion(req, res);
  });

  /** `/chat/completions` on a plain model. */
  async function handleModelCompletion(req, res) {
    const {
      model: modelId,
      messages,
      stream: clientWantsStream = false,
      stream_options: streamOptions,
      temperature = 0.7,
      tools = null,
      tool_choice: toolChoice,
      max_tokens: maxTokens,
      response_format: responseFormat,
      prompt
    } = req.body || {};
    const lang = requestLanguage(req);

    logger.info('[OpenAI Proxy] Incoming request', {
      component: 'OpenAIProxy',
      modelId,
      messageCount: Array.isArray(messages) ? messages.length : undefined,
      stream: clientWantsStream,
      temperature,
      hasTools: !!tools,
      toolNames: Array.isArray(tools) ? tools.map(t => t.function?.name ?? t.name) : null,
      toolChoice,
      maxTokens,
      responseFormat: responseFormat?.type
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
    // Check against the resolved model's canonical id, not the raw
    // (possibly differently-cased) id the caller sent. Fails closed: without a
    // principal carrying permissions the model is not allowed.
    const user = apiUser(req);
    if (!isModelPermitted(user, model)) {
      const msg = await getLocalizedError('modelAccessDenied', {}, lang);
      return res.status(403).json({ error: msg });
    }

    let format;
    try {
      assertNoPromptForModel(prompt);
      format = parseResponseFormat(responseFormat);
      assertStructuredOutputSupported(model, format, modelId);
    } catch (error) {
      if (isInferenceApiError(error)) return sendFlatError(res, error);
      throw error;
    }
    const validate = Boolean(format) && validationRequested(req);
    const upstreamMessages =
      format && structuredOutputSupport(model) === 'prompted'
        ? withJsonInstruction(messages, format)
        : messages;

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

    // Anonymous traffic stays out of the active-user count, as in setup.js.
    const userId = user && user.id !== 'anonymous' ? user.id : undefined;
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
        user: user || null,
        trigger: { type: 'api', source: APP_ID },
        refs: { appId: APP_ID }
      }
    });

    const telemetry = {
      runId: run.runId,
      purpose: APP_ID,
      toolExecution: genericTools ? 'caller' : 'none',
      appId: APP_ID,
      userId,
      chatId
    };
    const options = {
      temperature,
      maxTokens,
      tools: genericTools,
      toolChoice,
      user
    };
    const recordValidation = verdict => {
      if (!format) return;
      recordStructuredOutputValidation(
        !validate
          ? 'skipped'
          : verdict?.valid
            ? verdict.attempts > 1
              ? 'valid_after_retry'
              : 'valid'
            : 'invalid',
        { 'structured_output.source': 'request', 'gen_ai.request.model': model.id }
      );
    };

    const failUpstream = async error => {
      run.fail(error, model);
      if (clientDisconnected || error?.code === LLM_ERROR_CODES.ABORTED) return undefined;
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
          stream: clientWantsStream
        });
      }
      if (!isLLMError(error)) {
        const msg = await getLocalizedError('internalError', {}, lang);
        return res.status(500).json({ error: msg });
      }
      return res.status(inferenceErrorStatus(error)).json(errorEnvelope(error));
    };

    const completionId = newCompletionId();

    if (!clientWantsStream) {
      let result;
      try {
        // Always streamed from the provider, whatever shape the client asked
        // for: `clientWantsStream` is about our own response. Asking a provider
        // for one piece means its response headers only arrive with the
        // finished answer — on Google that is `:generateContent` — which makes
        // time-to-first-byte indistinguishable from generation time, so the
        // connect ceiling capped generation and reported the endpoint as
        // unreachable. Streaming also gets us the stream-idle guard and lets a
        // client disconnect free the provider call promptly.
        result = await runPlainTurn({
          llmClient,
          model,
          // runPlainTurn adds the JSON instruction itself.
          messages,
          options,
          format,
          validate,
          maxRetries: 1,
          signal: upstream.signal,
          language: lang,
          telemetry
        });
      } catch (error) {
        return failUpstream(error);
      }
      run.finish(result);
      recordValidation(result.structuredOutput);
      if (result.structuredOutput && !result.structuredOutput.valid) {
        return sendFlatError(res, outputValidationError(result.structuredOutput));
      }
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
    }

    let llmStream;
    try {
      llmStream = await llmClient.execute({
        model,
        messages: upstreamMessages,
        options: { ...options, ...adapterOptionsFor(format) },
        // Always streamed from the provider; see above.
        stream: true,
        signal: upstream.signal,
        language: lang,
        retries: 0,
        telemetry
      });
    } catch (error) {
      return failUpstream(error);
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
      for await (const rawChunk of llmStream) {
        if (clientDisconnected) break;
        // Anthropic answers structured output with a synthetic `json` tool
        // call; the caller sees it as content, the way OpenAI returns it.
        const chunk = liftJsonToolChunk(rawChunk, format);
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
      const result = liftJsonToolResult(llmStream.result(), format);
      run.finish(result);
      if (validate && !clientDisconnected && result.toolCalls.length === 0) {
        // The text is already on the wire, so there is no second attempt: an
        // answer that does not validate ends the stream with an in-band error.
        const verdict = { ...createOutputValidator(format)(result.content), attempts: 1 };
        recordValidation(verdict);
        if (!verdict.valid) {
          write(inBandError(outputValidationError(verdict)));
          return finish();
        }
      }
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
        return undefined;
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
    return undefined;
  }

  /** `/chat/completions` on an app (`model: "app:<appId>[/<modelId>]"`). */
  async function handleAppCompletion(req, res) {
    const body = req.body || {};
    const language = requestLanguage(req);
    const clientWantsStream = body.stream === true;
    const user = apiUser(req);
    const chatId = `${APP_ID}:${crypto.randomUUID()}`;
    let prepared;
    try {
      if (!Array.isArray(body.messages) || body.messages.length === 0) {
        throw new InferenceApiError(400, 'missing_messages', 'messages must be a non-empty array', {
          param: 'messages'
        });
      }
      const target = resolveInferenceTarget({
        model: body.model,
        user,
        findModel: id => llmClient.findModel(id)
      });
      if (parseResponseFormat(body.response_format)) {
        throw new InferenceApiError(
          400,
          'response_format_not_allowed',
          `App ${target.app.id} defines its own output format; remove response_format`,
          { param: 'response_format' }
        );
      }
      if (Array.isArray(body.tools) && body.tools.length > 0) {
        throw new InferenceApiError(
          400,
          'tools_not_allowed',
          `App ${target.app.id} runs its own tools; remove tools`,
          { param: 'tools' }
        );
      }
      const temperature = numberField(body, 'temperature', { min: 0, max: 2 });
      const maxOutputTokens =
        numberField(body, 'max_completion_tokens', { min: 1, integer: true }) ??
        numberField(body, 'max_tokens', { min: 1, integer: true });
      const resolved = resolvePromptVariables({
        prompt: body.prompt,
        app: target.app,
        language,
        fallbackLanguage: platformLanguage()
      });
      const messages = await messagesFromChatCompletions(body.messages);
      if (messages.some(message => message.role === 'system')) {
        throw new InferenceApiError(
          400,
          'system_message_not_allowed',
          `App ${target.app.id} defines its own system prompt; remove system and developer messages`,
          { param: 'messages' }
        );
      }
      prepared = await prepareAppTurn({
        chatService,
        target,
        user,
        language,
        messages,
        // Stateless: the template wraps the current turn, the last user message.
        applyTemplate: true,
        variables: resolved.variables,
        chatId,
        temperature,
        maxOutputTokens
      });
    } catch (error) {
      if (isInferenceApiError(error)) return sendFlatError(res, error);
      logger.error('[OpenAI Proxy] App request failed', { component: 'OpenAIProxy', error });
      return res.status(500).json({ error: 'Internal error', code: 'internal_error' });
    }

    const { app: appConfig, label } = prepared;
    activityTracker.recordActivity({ userId: user?.id, chatId });
    recordAppUsage(appConfig.id, user?.id, { 'gen_ai.request.model': prepared.model.id });

    const completionId = newCompletionId();
    const created = Math.floor(Date.now() / 1000);
    const runId = newRunId('chat');
    let clientDisconnected = false;
    let sentRole = false;
    let streamed = '';
    const chunk = (delta, finishReason = null) => ({
      id: completionId,
      object: 'chat.completion.chunk',
      created,
      model: label,
      choices: [{ index: 0, delta, finish_reason: finishReason }]
    });
    const write = obj => {
      if (!clientDisconnected && !res.writableEnded) res.write(`data: ${JSON.stringify(obj)}\n\n`);
    };
    const writeText = text => {
      write(chunk({ ...(sentRole ? {} : { role: 'assistant' }), content: text }));
      sentRole = true;
      streamed += text;
    };
    if (clientWantsStream) {
      res.status(200);
      res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
      res.setHeader('Cache-Control', 'no-cache');
      res.setHeader('X-Accel-Buffering', 'no');
      res.flushHeaders?.();
    }
    res.on('close', () => {
      if (!res.writableFinished) {
        clientDisconnected = true;
        // runTurn registers the turn's controller under the chat id; aborting
        // it frees the provider call the way a closed browser tab does.
        activeRequests.get(chatId)?.abort();
      }
    });

    const emitter = new RunStreamEmitter({
      streamId: chatId,
      runId,
      deliver: (_streamId, envelope) => {
        if (!clientWantsStream) return;
        if (envelope.type === SSE_V2_EVENTS.STEP_DELTA && envelope.data?.kind === 'text') {
          if (envelope.data.content) writeText(envelope.data.content);
        }
      }
    });

    let outcome;
    try {
      outcome = await executeAppTurn({
        chatService,
        prepared,
        chatId,
        runId,
        user,
        language,
        validate: validationRequested(req),
        // A streamed answer is already on the wire: a second attempt would be
        // appended to the first, so validation there has no retry.
        maxRetries: clientWantsStream ? 0 : 1,
        emitter,
        timeoutMs: DEFAULT_TIMEOUT,
        getLocalizedError
      });
    } catch (error) {
      logger.error('[OpenAI Proxy] App turn crashed', { component: 'OpenAIProxy', error });
      if (clientDisconnected) return undefined;
      const failure = new InferenceApiError(500, 'internal_error', 'Internal error');
      if (clientWantsStream) {
        write(inBandError(failure));
        res.write('data: [DONE]\n\n');
        return res.end();
      }
      return sendFlatError(res, failure);
    }
    if (clientDisconnected) return undefined;

    if (outcome.status === 'error' || outcome.status === 'aborted') {
      const error = appTurnError(outcome);
      if (clientWantsStream) {
        write(inBandError(error));
        res.write('data: [DONE]\n\n');
        return res.end();
      }
      // The SDKs retry a 409 on their own; a stopped turn must stay stopped.
      if (error.code === 'turn_aborted') res.setHeader('x-should-retry', 'false');
      return sendFlatError(res, error);
    }

    const content = outcome.content || '';
    const finishReason = openAiFinishReason(outcome.finishReason);
    const usage = outcome.usage ? usageToOpenAI(outcome.usage) : undefined;
    if (clientWantsStream) {
      // An answer that arrived whole (a passthrough tool, Anthropic's
      // structured output) has not been streamed yet.
      if (!sentRole) writeText(content);
      else if (content !== streamed && content.startsWith(streamed)) {
        writeText(content.slice(streamed.length));
      }
      write(chunk({}, finishReason));
      if (body.stream_options?.include_usage === true && usage) {
        write({
          id: completionId,
          object: 'chat.completion.chunk',
          created,
          model: label,
          choices: [],
          usage
        });
      }
      res.write('data: [DONE]\n\n');
      return res.end();
    }
    return res.json({
      id: completionId,
      object: 'chat.completion',
      created,
      model: label,
      choices: [{ index: 0, message: { role: 'assistant', content }, finish_reason: finishReason }],
      ...(usage ? { usage } : {})
    });
  }

  registerResponsesRoutes(app, { llmClient, chatService, getLocalizedError, DEFAULT_TIMEOUT });
  registerConversationsRoutes(app);
}
