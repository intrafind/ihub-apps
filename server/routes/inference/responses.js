/**
 * `POST /api/inference/v1/responses` — a subset of the OpenAI Responses API.
 *
 * Stateless by default; stateful when `conversation` names one (an iHub chat,
 * see ./conversations.js): the stored history is loaded, the turn runs, and
 * its input and output are appended to the chat. `model` is a plain model or
 * an app (`app:<appId>[/<modelId>]`); an app takes its variables through
 * `prompt.variables` and runs its full server-side configuration, a plain
 * model takes `instructions` and `text.format`.
 *
 * Structured output is validated server-side (opt out with `?validate=false`
 * or `validate: false`): an answer that does not validate gets one corrected
 * attempt, and one that still does not becomes a `422` (a `response.failed`
 * event when streaming) — never a success.
 *
 * @module routes/inference/responses
 */
import crypto from 'node:crypto';
import { buildServerPath } from '../../utils/basePath.js';
import logger from '../../utils/logger.js';
import { renderUserMessage } from '../../../shared/promptContext.js';
import { SSE_V2_EVENTS } from '../../../shared/runEvents.js';
import { RunStreamEmitter } from '../../services/loop/RunStream.js';
import { newRunId } from '../../services/loop/RunLog.js';
import { activeRequests, clearChatDurable, markChatDurable, hasChatClient } from '../../sse.js';
import { normalizeChatSettings } from '../../services/chat/ChatRepository.js';
import {
  materializeAssistantTurn,
  materializeUserTurn
} from '../../services/chat/chatMaterializer.js';
import activityTracker from '../../telemetry/ActivityTracker.js';
import { recordAppUsage, recordStructuredOutputValidation } from '../../telemetry/metrics.js';
import {
  InferenceApiError,
  fromLLMError,
  sendOpenAiError
} from '../../services/inference/errors.js';
import { resolveInferenceTarget } from '../../services/inference/modelIdentifier.js';
import {
  assertNoPromptForModel,
  resolvePromptVariables
} from '../../services/inference/promptVariables.js';
import {
  assertStructuredOutputSupported,
  outputValidationError,
  parseTextFormat,
  validationRequested
} from '../../services/inference/structuredOutput.js';
import {
  attachmentsOf,
  messagesFromResponsesInput
} from '../../services/inference/inputContent.js';
import {
  appTurnError,
  executeAppTurn,
  prepareAppTurn,
  turnPrompt
} from '../../services/inference/appTurn.js';
import { runPlainTurn } from '../../services/inference/plainTurn.js';
import {
  apiOrigin,
  assertBinding,
  bindingPatch,
  conversationIdOf,
  historyForModel,
  isFirstTurn,
  loadConversation,
  requireConversations,
  runStillAlive,
  validateMetadata
} from '../../services/inference/conversations.js';
import {
  ResponseAssembler,
  newResponseId,
  textParam
} from '../../services/inference/responsesWire.js';
import { apiUser, numberField, platformLanguage, requestLanguage } from './shared.js';

const COMPONENT = 'ResponsesApi';
const APP_ID = 'inference-api';

/**
 * Request fields outside the supported subset, refused with a reason rather
 * than ignored: each changes what the caller would get back.
 */
const UNSUPPORTED_FIELDS = {
  previous_response_id:
    'previous_response_id is not supported: responses are not stored; create a conversation and pass conversation instead',
  background: 'background responses are not supported',
  max_tool_calls: 'max_tool_calls is not supported: tools are not part of this API'
};

/** Refuse what the subset does not do. */
function assertSupportedFields(body) {
  for (const [field, message] of Object.entries(UNSUPPORTED_FIELDS)) {
    if (body[field] !== undefined && body[field] !== null && body[field] !== false) {
      throw new InferenceApiError(400, 'unsupported_parameter', message, { param: field });
    }
  }
  if (
    Array.isArray(body.tools)
      ? body.tools.length > 0
      : body.tools !== undefined && body.tools !== null
  ) {
    throw new InferenceApiError(
      400,
      'unsupported_parameter',
      'tools are not supported: OpenAI-hosted tools do not exist here, and an app (model: app:<appId>) runs its own tools on the server',
      { param: 'tools' }
    );
  }
  if (
    body.tool_choice !== undefined &&
    body.tool_choice !== null &&
    body.tool_choice !== 'auto' &&
    body.tool_choice !== 'none'
  ) {
    throw new InferenceApiError(400, 'unsupported_parameter', 'tool_choice is not supported', {
      param: 'tool_choice'
    });
  }
  if (
    body.instructions !== undefined &&
    body.instructions !== null &&
    typeof body.instructions !== 'string'
  ) {
    throw new InferenceApiError(400, 'invalid_parameter', 'instructions must be a string', {
      param: 'instructions'
    });
  }
}

/** The frames of an app turn, fed to the response assembler. */
function frameSink(assembler) {
  return (_streamId, envelope) => {
    const { type, data } = envelope;
    if (type === SSE_V2_EVENTS.STEP_DELTA && data?.kind === 'text') {
      assembler.textDelta(data.content);
    } else if (type === SSE_V2_EVENTS.TOOL_STARTED) {
      assembler.toolStarted({
        callId: data.callId,
        name: data.name || data.toolId,
        args: data.args
      });
    } else if (type === SSE_V2_EVENTS.TOOL_COMPLETED) {
      assembler.toolCompleted({
        callId: data.callId,
        name: data.name || data.toolId,
        output: data.resultPreview,
        error: data.error
      });
    }
  };
}

/** A user message of the input as a plain model receives it: documents rendered as text. */
function toModelMessage(message) {
  if (message.role !== 'user') return { role: message.role, content: message.content };
  return {
    role: 'user',
    content: renderUserMessage({ content: message.content, files: message.fileData }),
    ...(message.imageData ? { imageData: message.imageData } : {})
  };
}

export default function registerResponsesRoutes(
  app,
  { llmClient, chatService, getLocalizedError, DEFAULT_TIMEOUT }
) {
  const base = buildServerPath('/api/inference/v1');
  const findModel = id => llmClient.findModel(id);

  /**
   * @swagger
   * /inference/v1/responses:
   *   post:
   *     summary: Create a response (OpenAI Responses API subset)
   *     description: |
   *       Runs a plain model or an iHub app (`model: "app:<appId>[/<modelId>]"`). Stateless unless
   *       `conversation` names a conversation (see `/inference/v1/conversations`), whose history
   *       is then loaded and extended by this turn.
   *
   *       An app runs its server-side configuration: system prompt, variables
   *       (`prompt.variables`), sources, tools and output schema. Its tool calls appear as
   *       `ihub_tool_call` output items. A plain model takes `instructions` and `text.format`.
   *
   *       Structured output is validated server-side; an answer that does not validate is
   *       retried once, then answered with `422 output_validation_failed` (`response.failed`
   *       when streaming). Opt out with `?validate=false` or `validate: false`.
   *
   *       Streaming (`stream: true`) sends semantic events: `response.created`,
   *       `response.output_text.delta`, …, `response.completed` (carrying the final, validated
   *       output) or `response.failed`.
   *
   *       Not supported (400): `previous_response_id` (use `conversation`), `background`,
   *       `tools` and `tool_choice` other than `auto`/`none`. `store` is ignored: only a
   *       conversation persists.
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
   *             required: [model, input]
   *             properties:
   *               model:
   *                 type: string
   *                 description: Model id, `app:<appId>` or `app:<appId>/<modelId>`
   *               input:
   *                 description: |
   *                   A string, or message items (`{ role, content }`) whose content parts are
   *                   `input_text`, `input_image` (`image_url` as a data URL) or `input_file`
   *                   (`file_data` as a data URL, `filename`; PDF, Word (.docx) and text files).
   *               instructions:
   *                 type: string
   *                 description: System instructions (plain models only)
   *               prompt:
   *                 type: object
   *                 description: "Apps only: `{ id?, version?, variables }`"
   *               text:
   *                 type: object
   *                 description: "`{ format: { type: text | json_object | json_schema, name, schema, strict } }` (plain models only)"
   *               conversation:
   *                 description: A conversation id, or `{ id }`
   *               stream:
   *                 type: boolean
   *               temperature:
   *                 type: number
   *               max_output_tokens:
   *                 type: integer
   *               metadata:
   *                 type: object
   *                 additionalProperties:
   *                   type: string
   *               validate:
   *                 type: boolean
   *                 default: true
   *     responses:
   *       200:
   *         description: A `response` object (or an event stream)
   *       400:
   *         description: Invalid or unsupported request
   *       401:
   *         description: Authentication required
   *       403:
   *         description: The caller may not use the model
   *       404:
   *         description: Model, app or conversation not found
   *       409:
   *         description: Another response is running in the conversation
   *       422:
   *         description: The answer did not match the output schema
   *       503:
   *         description: Conversations are not available (chat persistence is off)
   */
  app.post(`${base}/responses`, async (req, res) => {
    const body = req.body || {};
    const language = requestLanguage(req);
    const user = apiUser(req);
    const stream = body.stream === true;
    // Set once the response is streaming: from then on a failure is an event.
    const ctx = { assembler: null };
    try {
      assertSupportedFields(body);
      const target = resolveInferenceTarget({ model: body.model, user, findModel });
      if (body.input === undefined || body.input === null || body.input === '') {
        throw new InferenceApiError(400, 'missing_input', 'input is required', { param: 'input' });
      }
      const inputMessages = await messagesFromResponsesInput(body.input);
      if (inputMessages.length === 0 || inputMessages[inputMessages.length - 1].role !== 'user') {
        throw new InferenceApiError(400, 'invalid_input', 'input must end with a user message', {
          param: 'input'
        });
      }
      const params = {
        req,
        res,
        body,
        user,
        language,
        target,
        inputMessages,
        stream,
        ctx,
        temperature: numberField(body, 'temperature', { min: 0, max: 2 }),
        maxOutputTokens: numberField(body, 'max_output_tokens', { min: 1, integer: true }),
        metadata: validateMetadata(body.metadata),
        validate: validationRequested(req),
        conversation: null
      };
      const conversationId = conversationIdOf(body.conversation);
      if (conversationId) {
        const repository = requireConversations(user);
        const chat = await loadConversation(repository, conversationId, user, 'write');
        assertBinding(chat, target);
        if (inputMessages.some(message => message.role === 'system')) {
          throw new InferenceApiError(
            400,
            'system_message_not_allowed',
            'A conversation stores user and assistant messages only; pass instructions instead',
            { param: 'input' }
          );
        }
        const { messages: stored } = await repository.getMessages(chat.id);
        params.conversation = { repository, chat, stored };
      }
      if (target.kind === 'app') await runAppResponse(params);
      else await runModelResponse(params);
    } catch (error) {
      if (ctx.assembler && res.headersSent) {
        ctx.assembler.fail(isInferenceApiErrorLike(error) ? error : fromLLMError(error));
        return;
      }
      if (res.headersSent) {
        if (!res.writableEnded) res.end();
        return;
      }
      sendTurnError(res, isInferenceApiErrorLike(error) ? error : fromLLMError(error), ctx);
    }
  });

  /**
   * Answer a failed turn. Once a conversation turn is stored, the OpenAI SDKs
   * must not repeat the request on their own (they retry 409, 429 and 5xx by
   * default): a repeat would store the question again, and re-run a turn
   * somebody stopped.
   */
  function sendTurnError(res, error, ctx) {
    if (ctx.persisted || error?.code === 'turn_aborted') res.setHeader('x-should-retry', 'false');
    return sendOpenAiError(res, error, COMPONENT);
  }

  function isInferenceApiErrorLike(error) {
    return error instanceof InferenceApiError;
  }

  /**
   * Take the conversation for this turn, or refuse with 409 while another
   * response is running in it.
   *
   * The turn was prepared from the conversation as it was read before the
   * claim. A turn that finished in between changed the history (and may have
   * bound the conversation), so the claim is given back and the request is
   * refused as busy: it stored nothing and can simply be sent again.
   */
  async function claimConversation(conversation, runId, target) {
    const { repository, chat } = conversation;
    const claim = await repository.claimRun(chat.id, runId, { isBusy: runStillAlive(chat.id) });
    if (!claim.chat) {
      throw new InferenceApiError(
        404,
        'conversation_not_found',
        `Conversation not found: ${chat.id}`,
        {
          param: 'conversation'
        }
      );
    }
    if (!claim.claimed) {
      throw new InferenceApiError(
        409,
        'conversation_busy',
        `Another response is running in conversation ${chat.id}; wait for it to finish`,
        { param: 'conversation' }
      );
    }
    const { messages: now } = await repository.getMessages(chat.id);
    const before = conversation.stored;
    const unchanged =
      now.length === before.length &&
      now[now.length - 1]?.id === before[before.length - 1]?.id &&
      (claim.chat.binding || null) === (chat.binding || null) &&
      (claim.chat.appId || null) === (chat.appId || null);
    if (!unchanged) {
      await releaseClaim(conversation, runId);
      assertBinding(claim.chat, target);
      throw new InferenceApiError(
        409,
        'conversation_busy',
        `Conversation ${chat.id} changed while this response was prepared; send it again`,
        { param: 'conversation' }
      );
    }
  }

  /**
   * Store the input items that precede this turn's user message, with the
   * documents they carried rendered into the text replayed on later turns.
   */
  async function storeEarlierInput(conversation, inputMessages, runId) {
    for (const message of inputMessages.slice(0, -1)) {
      const attachments = attachmentsOf(message);
      await conversation.repository.appendMessage(conversation.chat.id, {
        role: message.role,
        content: message.content,
        runId,
        ...(message.fileData?.length
          ? {
              renderedContent: renderUserMessage({
                content: message.content,
                files: message.fileData
              })
            }
          : {}),
        ...(attachments.length > 0 ? { attachments } : {})
      });
    }
  }

  /**
   * Give back a claim. A no-op once the turn's own end released the chat:
   * the release only applies while `runId` is still its active run.
   */
  async function releaseClaim(conversation, runId) {
    try {
      await conversation.repository.releaseRun(conversation.chat.id, runId, {
        activeRunId: null,
        status: 'active'
      });
    } catch (error) {
      logger.error('Could not release a conversation', {
        component: COMPONENT,
        chatId: conversation.chat.id,
        error: error.message
      });
    }
  }

  /** A response from an app. */
  async function runAppResponse({
    res,
    body,
    user,
    language,
    target,
    inputMessages,
    stream,
    ctx,
    temperature,
    maxOutputTokens,
    metadata,
    validate,
    conversation
  }) {
    const { app: appConfig } = target;
    if (typeof body.instructions === 'string' && body.instructions) {
      throw new InferenceApiError(
        400,
        'instructions_not_allowed',
        `App ${appConfig.id} defines its own system prompt; remove instructions`,
        { param: 'instructions' }
      );
    }
    if (parseTextFormat(body.text)) {
      throw new InferenceApiError(
        400,
        'text_format_not_allowed',
        `App ${appConfig.id} defines its own output format; remove text.format`,
        { param: 'text.format' }
      );
    }
    if (inputMessages.some(message => message.role === 'system')) {
      throw new InferenceApiError(
        400,
        'system_message_not_allowed',
        `App ${appConfig.id} defines its own system prompt; remove system and developer messages`,
        { param: 'input' }
      );
    }
    const chat = conversation?.chat || null;
    const firstTurn = !conversation || isFirstTurn(conversation.stored);
    const sendsVariables = body.prompt?.variables !== undefined && body.prompt?.variables !== null;
    const resolved = resolvePromptVariables({
      prompt: body.prompt,
      app: appConfig,
      language,
      fallbackLanguage: platformLanguage(),
      // A follow-up without variables runs on the ones the conversation
      // already has; only a turn that sets them has to set the required ones.
      enforceRequired: firstTurn || sendsVariables
    });
    const historyReplayed = appConfig.sendChatHistory !== false;
    const prompt = turnPrompt({
      firstTurn,
      resolved,
      stored: chat?.variables,
      historyReplayed
    });
    const history = conversation && historyReplayed ? historyForModel(conversation.stored) : [];
    const chatId = chat ? chat.id : `${APP_ID}:${crypto.randomUUID()}`;
    const prepared = await prepareAppTurn({
      chatService,
      target,
      user,
      language,
      messages: [...history, ...inputMessages],
      applyTemplate: prompt.applyTemplate,
      variables: prompt.variables,
      chatId,
      temperature,
      maxOutputTokens
    });

    const runId = newRunId('chat');
    const assembler = new ResponseAssembler({
      res: stream ? res : null,
      base: {
        id: newResponseId(),
        created_at: Math.floor(Date.now() / 1000),
        model: prepared.label,
        instructions: null,
        temperature: prepared.prep.temperature ?? null,
        max_output_tokens: maxOutputTokens ?? null,
        text: textParam(prepared.format),
        metadata: metadata || {},
        conversation: chat?.id || null
      }
    });

    let disconnected = false;
    res.on('close', () => {
      if (res.writableFinished) return;
      disconnected = true;
      // A stateless turn ends with its caller. A conversation turn is stored
      // whether or not anybody is still reading, like a chat turn in the UI.
      if (!chat) activeRequests.get(chatId)?.abort();
    });

    let persistence = null;
    let durable = false;
    let claimed = false;
    try {
      if (chat) {
        await claimConversation(conversation, runId, target);
        claimed = true;
        await storeEarlierInput(conversation, inputMessages, runId);
        const current = inputMessages[inputMessages.length - 1];
        persistence = {
          repository: conversation.repository,
          ownerId: chat.ownerId,
          identityMode: chat.identityMode,
          content: current.content,
          clientMessageId: null,
          attachments: attachmentsOf(current),
          settings: normalizeChatSettings({ temperature }),
          // The chat's variable set, shared with the chat UI (its start
          // form stores the same field): replaced by a turn that sets them.
          ...(prompt.storeVariables ? { variables: prompt.variables } : {}),
          message: {
            // The variables this turn was rendered with, when it was.
            ...(prompt.applyTemplate ? { variables: prompt.variables } : {}),
            renderedContent: prepared.renderedContent
          },
          chat: bindingPatch(target),
          assistant: { model: prepared.label },
          origin: apiOrigin(user),
          clientConnected: () => !disconnected
        };
        markChatDurable(chatId);
        durable = true;
      }

      activityTracker.recordActivity({ userId: user?.id, chatId });
      recordAppUsage(appConfig.id, user?.id, { 'gen_ai.request.model': prepared.model.id });
      if (stream) {
        assembler.start();
        ctx.assembler = assembler;
      }

      if (chat) ctx.persisted = true;
      const outcome = await executeAppTurn({
        chatService,
        prepared,
        chatId,
        runId,
        user,
        language,
        validate,
        maxRetries: 1,
        emitter: new RunStreamEmitter({ streamId: chatId, runId, deliver: frameSink(assembler) }),
        onAttemptRejected: () => assembler.rejectAttempt(),
        persistence,
        timeoutMs: DEFAULT_TIMEOUT,
        getLocalizedError
      });
      if (disconnected && !stream) return;

      if (outcome.status === 'error' || outcome.status === 'aborted') {
        const error = appTurnError(outcome);
        if (stream) {
          assembler.fail(error, outcome.usage);
          return;
        }
        sendTurnError(res, error, ctx);
        return;
      }
      const response = assembler.complete({
        text: outcome.content || '',
        parsed: outcome.structuredOutput?.valid ? outcome.structuredOutput.value : undefined,
        usage: outcome.usage
      });
      if (!stream) res.json(response);
    } finally {
      // The turn's own end releases the chat; this only matters when it
      // never got that far (a failure before or around the turn).
      if (claimed) await releaseClaim(conversation, runId);
      if (durable) clearChatDurable(chatId);
    }
  }

  /** A response from a plain model. */
  async function runModelResponse({
    res,
    body,
    user,
    language,
    target,
    inputMessages,
    stream,
    ctx,
    temperature,
    maxOutputTokens,
    metadata,
    validate,
    conversation
  }) {
    const { model } = target;
    assertNoPromptForModel(body.prompt);
    const format = parseTextFormat(body.text);
    assertStructuredOutputSupported(model, format, model.id);
    const instructions =
      typeof body.instructions === 'string' && body.instructions ? body.instructions : null;
    const chat = conversation?.chat || null;
    const history = conversation ? historyForModel(conversation.stored) : [];
    const current = inputMessages[inputMessages.length - 1];
    const renderedCurrent = toModelMessage(current);
    const messages = [
      ...(instructions ? [{ role: 'system', content: instructions }] : []),
      ...history,
      ...inputMessages.slice(0, -1).map(toModelMessage),
      renderedCurrent
    ];
    const chatId = chat ? chat.id : `${APP_ID}:${user?.id || 'anonymous'}`;

    const upstream = new AbortController();
    let disconnected = false;
    res.on('close', () => {
      if (res.writableFinished) return;
      disconnected = true;
      if (!chat) upstream.abort();
    });

    const run = await llmClient.openRun({
      model,
      language,
      telemetry: {
        kind: 'inference',
        purpose: APP_ID,
        user: user || null,
        trigger: { type: 'api', source: APP_ID },
        refs: { appId: APP_ID, ...(chat ? { chatId: chat.id } : {}) }
      }
    });
    const runId = run.runId || newRunId('chat');
    const assembler = new ResponseAssembler({
      res: stream ? res : null,
      base: {
        id: newResponseId(),
        created_at: Math.floor(Date.now() / 1000),
        model: model.id,
        instructions,
        temperature: temperature ?? 0.7,
        max_output_tokens: maxOutputTokens ?? null,
        text: textParam(format),
        metadata: metadata || {},
        conversation: chat?.id || null
      }
    });

    let durable = false;
    let claimed = false;
    let userTurnStored = false;
    let answerStored = false;
    const storeAnswer = async summary => {
      if (!userTurnStored || answerStored) return;
      answerStored = true;
      await materializeAssistantTurn({
        repository: conversation.repository,
        chatId: chat.id,
        runId,
        summary,
        clientConnected: !disconnected || hasChatClient(chat.id),
        message: { model: model.id }
      });
    };
    try {
      if (chat) {
        await claimConversation(conversation, runId, target);
        claimed = true;
        await storeEarlierInput(conversation, inputMessages, runId);
        markChatDurable(chat.id);
        durable = true;
        // Reachable by Stop and by a delete of the conversation, like a
        // chat turn: both abort what `activeRequests` holds for the chat.
        activeRequests.set(chat.id, upstream);
        await materializeUserTurn({
          repository: conversation.repository,
          chatId: chat.id,
          ownerId: chat.ownerId,
          identityMode: chat.identityMode,
          appId: null,
          modelId: model.id,
          settings: normalizeChatSettings({ temperature }),
          runId,
          content: current.content,
          attachments: attachmentsOf(current),
          message: { renderedContent: renderedCurrent.content },
          chat: bindingPatch(target),
          origin: apiOrigin(user)
        });
        userTurnStored = true;
        ctx.persisted = true;
      }

      activityTracker.recordActivity({ userId: user?.id, chatId });
      recordAppUsage(APP_ID, user?.id, { 'gen_ai.request.model': model.id });
      if (stream) {
        assembler.start();
        ctx.assembler = assembler;
      }

      let result;
      try {
        result = await runPlainTurn({
          llmClient,
          model,
          messages,
          options: { temperature: temperature ?? 0.7, maxTokens: maxOutputTokens, user },
          format,
          validate,
          maxRetries: 1,
          signal: upstream.signal,
          language,
          telemetry: {
            runId: run.runId,
            purpose: APP_ID,
            toolExecution: 'none',
            appId: APP_ID,
            userId: user?.id,
            chatId
          },
          onText: stream ? text => assembler.textDelta(text) : null,
          onAttemptRejected: () => assembler.rejectAttempt()
        });
      } catch (error) {
        run.fail(error, model);
        const aborted = upstream.signal.aborted;
        const failure = aborted
          ? new InferenceApiError(409, 'turn_aborted', 'The turn was stopped before it finished')
          : fromLLMError(error);
        await storeAnswer({
          status: aborted ? 'aborted' : 'error',
          content: '',
          finishReason: 'error',
          errorInfo: { code: failure.code, message: failure.message }
        });
        throw failure;
      }
      run.finish(result);
      if (format) {
        const verdict = result.structuredOutput;
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
      }
      if (result.structuredOutput && !result.structuredOutput.valid) {
        const failure = outputValidationError(result.structuredOutput);
        await storeAnswer({
          status: 'error',
          content: result.content || '',
          finishReason: 'error',
          usage: result.usage,
          errorInfo: { code: 'OUTPUT_VALIDATION_FAILED', message: failure.message }
        });
        throw failure;
      }
      await storeAnswer({
        status: 'completed',
        content: result.content || '',
        finishReason: result.finishReason || 'stop',
        usage: result.usage,
        structuredOutput: result.structuredOutput
      });
      const response = assembler.complete({
        text: result.content || '',
        parsed: result.structuredOutput?.valid ? result.structuredOutput.value : undefined,
        usage: result.usage
      });
      if (!stream && !disconnected) res.json(response);
    } catch (error) {
      // A claim or a store that failed before the model ran still closes the
      // ledger run; a no-op once the run was finished or failed above.
      run.fail(error, model);
      throw error;
    } finally {
      // Whatever failed around the model call, the stored question gets an
      // answer and the chat is released — never left `running`.
      await storeAnswer({
        status: 'error',
        content: '',
        finishReason: 'error',
        errorInfo: { code: 'INTERNAL_ERROR', message: 'The turn failed' }
      });
      if (claimed) await releaseClaim(conversation, runId);
      if (chat && activeRequests.get(chat.id) === upstream) activeRequests.delete(chat.id);
      if (durable) clearChatDurable(chat.id);
    }
  }
}
