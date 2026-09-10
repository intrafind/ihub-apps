import configCache from '../../configCache.js';
import { sendLLMError } from '../../services/loop/llmHttpErrors.js';
import { logInteraction, trackSession } from '../../utils.js';
import llmClient, {
  usageToOpenAI,
  isLLMError,
  LLM_ERROR_CODES
} from '../../services/loop/LLMClient.js';
import {
  clients,
  abortChatRequest,
  abortChatRequestOnDisconnect,
  clearChatDurable,
  closeChatClient,
  hasActiveChatRequest,
  hasChatClient,
  isChatDurable,
  markChatDurable
} from '../../sse.js';
import { RunStreamEmitter, currentSeq, getStreamRun } from '../../services/loop/RunStream.js';
import runLog, { newRunId } from '../../services/loop/RunLog.js';
import { resolveActorId, resolvePrincipal } from '../../services/loop/runIdentity.js';
import { authorizeInteraction } from '../../services/loop/runAccess.js';
import interactionService from '../../services/loop/InteractionService.js';
import { SSE_V2_EVENTS, RUN_LOG_EVENTS } from '../../../shared/runEvents.js';
import { createSseChannel } from '../../utils/sseChannel.js';
import {
  authRequired,
  chatAuthRequired,
  modelAccessRequired
} from '../../middleware/authRequired.js';

import ChatService from '../../services/chat/ChatService.js';
import {
  materializeAssistantTurn,
  materializeUserTurn
} from '../../services/chat/chatMaterializer.js';
import { authorizeChat } from '../../services/chat/chatAccess.js';
import { getChatRepository, isPersistableChatId } from '../../services/chat/ChatRepository.js';
import { isChatPersistenceActive } from '../../services/chat/chatPersistence.js';
import validate from '../../validators/validate.js';
import { chatTestSchema, chatPostSchema, chatConnectSchema } from '../../validators/index.js';
import { buildServerPath } from '../../utils/basePath.js';
import logger from '../../utils/logger.js';
import {
  sendNotFound,
  sendFailedOperationError,
  sendInternalError,
  sendBadRequest,
  sendErrorResponse
} from '../../utils/responseHelpers.js';
import { drainPendingFinish } from '../../services/workflow/chatBridge.js';
import { cancelChatWorkflow, replayChatWorkflowProgress } from '../../tools/workflowRunner.js';

/**
 * Report a failure that happened before (or instead of) a model turn on the
 * chat stream: a short-lived run that starts, errors and ends, so the client
 * reducer can attach the message to the pending assistant bubble.
 */
function emitFailedRun(chatId, { kind = 'chat', messageId, code, message, refs = {} }) {
  const emitter = new RunStreamEmitter({ streamId: chatId, runId: newRunId(kind) });
  emitter.emit(SSE_V2_EVENTS.RUN_STARTED, {
    kind,
    refs: { chatId, ...(messageId ? { messageId } : {}), ...refs }
  });
  emitter.emit(SSE_V2_EVENTS.STREAM_ERROR, {
    code: String(code || 'ERROR'),
    message: String(message)
  });
  emitter.emit(SSE_V2_EVENTS.RUN_ENDED, {
    status: 'error',
    finishReason: 'error',
    error: { ...(code ? { code: String(code) } : {}), message: String(message) }
  });
}

/**
 * Chat-shaped view of a persisted transcript: role and content only.
 *
 * Everything else on a stored message — ids, usage, the error of a failed turn,
 * attachment descriptors — is bookkeeping for the history UI and has no place
 * in a model prompt. Contentless turns are dropped with it: an aborted or
 * failed turn is stored with an empty answer, and several providers reject a
 * blank message outright.
 *
 * @param {Array<Object>} stored - Messages as `ChatRepository` returns them.
 * @returns {Array<{role: string, content: string}>}
 */
function historyForPrompt(stored) {
  return stored
    .filter(entry => entry?.role && typeof entry.content === 'string' && entry.content.trim())
    .map(entry => ({ role: entry.role, content: entry.content }));
}

/**
 * Upload descriptors carried by a chat message, for the materializer to
 * normalize. The base64 payloads stay in the request: what a stored message
 * keeps is the fact that a file was attached, not the file.
 *
 * Each of the three fields is a single object for one upload and an array for
 * several — the shape the chat client has always sent and `RequestBuilder`
 * already handles — so they are flattened here. Without that an array is
 * `typeof 'object'` and survives as one opaque descriptor, turning three named
 * PDFs into a single nameless `{ type: 'file' }`.
 *
 * @param {Object} message - The new user message from the request.
 * @returns {Array<Object>}
 */
export function messageAttachments(message) {
  return [message?.fileData, message?.imageData, message?.audioData]
    .flatMap(value => (Array.isArray(value) ? value : value ? [value] : []))
    .filter(entry => entry && typeof entry === 'object');
}

/**
 * The outcome a workflow run resolved with, in the shape the materializer's
 * `summary` describes. A cancelled workflow is an abort, anything that is not
 * a completion is a failure, and the answer text is the one the run streamed.
 *
 * @param {Object} result - What `workflowRunner` resolved with.
 * @returns {Object}
 */
export function workflowSummary(result) {
  const content = typeof result?.outputText === 'string' ? result.outputText : '';
  if (result?.status === 'completed') return { status: 'success', content, finishReason: 'stop' };
  if (result?.status === 'cancelled') {
    return { status: 'aborted', content, finishReason: 'cancelled' };
  }
  return {
    status: 'error',
    content,
    finishReason: 'error',
    errorInfo: {
      code: 'WORKFLOW_FAILED',
      message: String(result?.error || 'Workflow execution failed')
    }
  };
}

/**
 * Write the human half of an @mention workflow turn, or nothing when the chat
 * is not persisted.
 *
 * @param {Object} params
 * @param {Object|null} params.persistence - Durable-chat context, or null.
 * @param {string} params.chatId - Chat id.
 * @param {string} params.appId - App the chat belongs to.
 * @param {string} [params.modelId] - Model the chat last used.
 * @param {string} params.runId - The workflow's run id.
 * @returns {Promise<void>}
 */
async function materializeWorkflowUserTurn({ persistence, chatId, appId, modelId, runId }) {
  if (!persistence) return;
  await materializeUserTurn({
    repository: persistence.repository,
    chatId,
    ownerId: persistence.ownerId,
    identityMode: persistence.identityMode,
    appId,
    modelId,
    runId,
    content: persistence.content,
    clientMessageId: persistence.clientMessageId,
    attachments: persistence.attachments,
    replaceFromMessageId: persistence.replaceFromMessageId
  });
}

/**
 * Write the assistant half of an @mention workflow turn and release the chat,
 * or nothing when the chat is not persisted.
 *
 * @param {Object} params
 * @param {Object|null} params.persistence - Durable-chat context, or null.
 * @param {string} params.chatId - Chat id.
 * @param {string} params.runId - The workflow's run id.
 * @param {Object} params.summary - Turn outcome; see {@link workflowSummary}.
 * @returns {Promise<void>}
 */
async function materializeWorkflowAssistantTurn({ persistence, chatId, runId, summary }) {
  if (!persistence) return;
  await materializeAssistantTurn({
    repository: persistence.repository,
    chatId,
    runId,
    summary,
    clientConnected: hasChatClient(chatId)
  });
}

export default function registerSessionRoutes(app, { getLocalizedError, DEFAULT_TIMEOUT }) {
  const chatService = new ChatService();

  /**
   * @swagger
   * components:
   *   schemas:
   *     ChatMessage:
   *       type: object
   *       description: A single chat message
   *       required:
   *         - role
   *         - content
   *       properties:
   *         role:
   *           type: string
   *           enum: [user, assistant, system]
   *           description: Role of the message sender
   *           example: user
   *         content:
   *           type: string
   *           description: Message text content
   *           example: "What is the capital of France?"
   *         messageId:
   *           type: string
   *           description: Optional client-provided unique message identifier
   *           example: "msg-abc123"
   *         fileData:
   *           type: object
   *           description: Optional attached file data
   *         imageData:
   *           type: object
   *           description: Optional attached image data
   *
   *     ChatRequest:
   *       type: object
   *       description: Request body for sending a chat message
   *       required:
   *         - messages
   *       properties:
   *         messages:
   *           type: array
   *           description: Array of chat messages forming the conversation history
   *           items:
   *             $ref: '#/components/schemas/ChatMessage'
   *         modelId:
   *           type: string
   *           description: ID of the model to use (overrides app default)
   *           example: "gpt-4o"
   *         temperature:
   *           type: number
   *           description: Sampling temperature (0–2)
   *           example: 0.7
   *         style:
   *           type: string
   *           description: Response style identifier
   *           example: "concise"
   *         outputFormat:
   *           type: string
   *           enum: [markdown, text, json, html]
   *           description: Desired output format
   *           example: "markdown"
   *         language:
   *           type: string
   *           description: BCP 47 language code for the response
   *           example: "en"
   *         bypassAppPrompts:
   *           type: boolean
   *           description: Skip the app system prompt (advanced usage)
   *         thinkingEnabled:
   *           type: boolean
   *           description: Enable extended thinking for supported models
   *         thinkingBudget:
   *           type: number
   *           description: Token budget for extended thinking
   *         thinkingThoughts:
   *           type: boolean
   *           description: Include thinking steps in the response
   *         enabledTools:
   *           type: array
   *           items:
   *             type: string
   *           description: List of tool IDs to enable for this request
   *         imageAspectRatio:
   *           type: string
   *           description: Aspect ratio for image generation (e.g. "16:9")
   *           example: "1:1"
   *         imageQuality:
   *           type: string
   *           description: Quality level for image generation
   *           example: "High"
   *         requestedSkill:
   *           type: string
   *           description: Slash-command skill to activate
   *         documentIds:
   *           type: array
   *           items:
   *             type: string
   *           description: IDs of documents to include as context
   *         replaceFromMessageId:
   *           type: string
   *           description: |
   *             Persisted chats only. Stored message id to fork the history from
   *             (inclusive) before the new message is appended — an edit or a
   *             regenerate. Unknown ids are rejected with 400 UNKNOWN_MESSAGE.
   *         ephemeral:
   *           type: boolean
   *           description: |
   *             Do not persist this turn. Advisory: it can only turn persistence
   *             off, never on.
   *
   *     ChatStreamingResponse:
   *       type: object
   *       description: Response when the chat is being streamed via SSE
   *       properties:
   *         status:
   *           type: string
   *           enum: [streaming]
   *           example: "streaming"
   *         chatId:
   *           type: string
   *           description: The chat session ID
   *           example: "550e8400-e29b-41d4-a716-446655440000"
   *
   *     ChatErrorResponse:
   *       type: object
   *       description: Response when an error occurs during chat
   *       properties:
   *         status:
   *           type: string
   *           enum: [error]
   *           example: "error"
   *         message:
   *           type: string
   *           description: Localized error message
   *         code:
   *           type: string
   *           description: Machine-readable error code
   *           example: "MODEL_NOT_FOUND"
   */

  /**
   * @swagger
   * /models/{modelId}/chat/test:
   *   get:
   *     summary: Test chat model
   *     description: Sends a test message to verify model connectivity and functionality
   *     tags:
   *       - Chat
   *     security:
   *       - bearerAuth: []
   *       - sessionAuth: []
   *     parameters:
   *       - in: path
   *         name: modelId
   *         required: true
   *         schema:
   *           type: string
   *         description: The model ID to test
   *     responses:
   *       200:
   *         description: Test successful
   *         content:
   *           application/json:
   *             schema:
   *               type: object
   *               properties:
   *                 success:
   *                   type: boolean
   *                 model:
   *                   type: string
   *                   description: iHub model id that answered
   *                 content:
   *                   type: string
   *                   description: Model's response to the test message
   *                 finishReason:
   *                   type: string
   *                   nullable: true
   *                 usage:
   *                   type: object
   *                   description: OpenAI-style token usage (prompt_tokens, completion_tokens, total_tokens)
   *       404:
   *         description: Model not found
   *       401:
   *         description: Authentication or authorization required, or the provider rejected the server's credentials
   *       429:
   *         description: Provider rate limit (Retry-After set when known)
   *       500:
   *         description: Internal server error or no API key configured for the model
   *       502:
   *         description: Upstream provider error
   *       504:
   *         description: Model request timed out
   */
  app.get(
    buildServerPath('/api/models/:modelId/chat/test'),
    authRequired,
    modelAccessRequired,
    validate(chatTestSchema),
    async (req, res) => {
      try {
        const { modelId } = req.params;
        const messages = [{ role: 'user', content: 'Say hello!' }];

        // Try to get models from cache first
        let { data: models = [] } = configCache.getModels();

        if (!models) {
          return sendFailedOperationError(
            res,
            'load models configuration',
            new Error('models is null')
          );
        }
        const model = models.find(m => m.id === modelId);
        if (!model) {
          return sendNotFound(res, 'Model');
        }
        const defaultLang = configCache.getPlatform()?.defaultLanguage || 'en';
        const language = req.headers['accept-language']?.split(',')[0] || defaultLang;
        try {
          // API key resolution, throttling and provider parsing live in LLMClient;
          // `retries: 0` keeps this interactive diagnostic from stalling on Retry-After.
          const result = await llmClient.complete({
            model,
            messages,
            stream: false,
            timeoutMs: DEFAULT_TIMEOUT,
            retries: 0,
            language,
            telemetry: { kind: 'diagnostic', purpose: 'model-chat-test', user: req.user }
          });
          return res.json({
            success: true,
            model: model.id,
            content: result.content,
            finishReason: result.finishReason,
            usage: usageToOpenAI(result.usage)
          });
        } catch (llmError) {
          if (!isLLMError(llmError)) {
            throw llmError;
          }
          if (llmError.code === LLM_ERROR_CODES.TIMEOUT) {
            return sendErrorResponse(
              res,
              504,
              `Request to ${model.provider} API timed out after ${DEFAULT_TIMEOUT / 1000} seconds`
            );
          }
          return sendLLMError(res, llmError, { context: 'test chat completion' });
        }
      } catch (error) {
        logger.error('Error in test chat completion', { component: 'sessionRoutes', error });
        sendInternalError(res, error, 'test chat completion');
      }
    }
  );

  /**
   * @swagger
   * /apps/{appId}/chat/{chatId}:
   *   get:
   *     summary: Connect to chat SSE stream
   *     description: |
   *       Establishes a Server-Sent Events (SSE) connection for receiving real-time chat
   *       messages and status updates. The client must connect here first, then POST a
   *       message to the same URL. Events are streamed back over this connection.
   *       The connection remains open until the client disconnects or the stream is stopped.
   *     tags:
   *       - Chat
   *     security:
   *       - bearerAuth: []
   *       - sessionAuth: []
   *     parameters:
   *       - in: path
   *         name: appId
   *         required: true
   *         schema:
   *           type: string
   *         description: The app ID
   *       - in: path
   *         name: chatId
   *         required: true
   *         schema:
   *           type: string
   *         description: Unique chat session ID (e.g. UUID) created by the client
   *     responses:
   *       200:
   *         description: SSE stream established successfully
   *         content:
   *           text/event-stream:
   *             schema:
   *               type: string
   *               description: |
   *                 SSE v2 (see docs/sse-v2.md). Every frame is `event: <type>` with a
   *                 JSON envelope `{ v: 2, seq, runId, ts, type, data }`. Each message turn is
   *                 one run: `run/started`, `step/delta`, `tool/started`, `tool/completed`,
   *                 `interaction/raised`, `run/paused`, `stream/error`, `run/ended`.
   *             example: |
   *               event: step/delta
   *               data: {"v":2,"seq":3,"runId":"chat-…","ts":"…","type":"step/delta","data":{"step":1,"kind":"text","content":"Hello"}}
   *
   *               event: run/ended
   *               data: {"v":2,"seq":9,"runId":"chat-…","ts":"…","type":"run/ended","data":{"status":"completed","finishReason":"stop"}}
   *       401:
   *         description: Authentication required
   *       500:
   *         description: Internal server error
   */
  app.get(
    buildServerPath('/api/apps/:appId/chat/:chatId'),
    chatAuthRequired,
    validate(chatConnectSchema),
    async (req, res) => {
      // Destructured outside the try so the catch below can still reference
      // chatId when channel setup throws.
      const { appId, chatId } = req.params;
      try {
        // `chatAuthRequired` authorizes the app, never the chat id. A persisted
        // chat is a durable, guessable resource, so subscribing to its stream
        // has to be an ownership decision as well as an app one.
        const access = await authorizeChat(chatId, req.user);
        if (!access.ok) return sendNotFound(res, 'Chat session');

        const channel = createSseChannel({
          req,
          res,
          id: chatId,
          map: clients,
          component: 'sessionRoutes',
          onClose: ({ isCurrent }) => {
            if (!isCurrent) return;
            // The LLM call feeding this stream may be running on another
            // worker, so abort through the cluster-aware helper — otherwise a
            // browser closing the tab would leave the generation running to
            // completion, billing tokens nobody will read. A persisted turn is
            // the exception: its answer is stored for the user to come back to,
            // so the helper leaves that one running.
            abortChatRequestOnDisconnect(chatId);
            logger.info('Client disconnected', { component: 'sessionRoutes', chatId });
          }
        });
        // appId is carried on the entry for parity with the previous shape;
        // nothing currently reads it back off the map, but keep it available.
        channel.entry.appId = appId;
        new RunStreamEmitter({ streamId: chatId }).emit(SSE_V2_EVENTS.STREAM_CONNECTED, {
          runId: chatId,
          lastSeq: currentSeq(chatId)
        });

        // --- Workflow disconnect resilience ---
        // 1. If a workflow finished while the chat was disconnected, deliver
        //    the result + final chunk + done now (final output backfill).
        // 2. If a workflow is still running for this chatId, replay step
        //    progress from persisted state so the chat catches up.
        try {
          const pending = drainPendingFinish(chatId);
          if (pending) {
            const backfill = new RunStreamEmitter({
              streamId: chatId,
              runId: pending.runId || newRunId('workflow')
            });
            backfill.emit(SSE_V2_EVENTS.RUN_STARTED, {
              kind: 'workflow',
              refs: { chatId, executionId: pending.executionId }
            });
            backfill.emit(SSE_V2_EVENTS.META, {
              executionId: pending.executionId,
              extra: {
                workflow: {
                  status: pending.status,
                  workflowName: pending.workflowName,
                  outputFormat: pending.outputFormat || 'markdown',
                  ...(pending.errorMsg ? { error: String(pending.errorMsg) } : {})
                }
              }
            });
            if (!pending.passthrough && pending.outputText) {
              backfill.emit(SSE_V2_EVENTS.STEP_DELTA, {
                step: 0,
                kind: 'text',
                content: pending.outputText
              });
            }
            const finishReason =
              pending.status === 'cancelled'
                ? 'cancelled'
                : pending.status === 'failed'
                  ? 'error'
                  : 'stop';
            backfill.emit(SSE_V2_EVENTS.RUN_ENDED, {
              status:
                pending.status === 'cancelled'
                  ? 'aborted'
                  : pending.status === 'failed'
                    ? 'error'
                    : 'completed',
              finishReason,
              ...(pending.errorMsg ? { error: { message: String(pending.errorMsg) } } : {})
            });
            logger.info('Delivered pending workflow finish on SSE reconnect', {
              component: 'sessionRoutes',
              chatId,
              executionId: pending.executionId,
              status: pending.status
            });
          } else {
            // Resolves the owning worker itself when the workflow is running
            // elsewhere in the cluster; the replayed steps come back over the
            // SSE relay.
            await replayChatWorkflowProgress(chatId);
          }
        } catch (replayError) {
          logger.warn('Workflow reconnect replay/backfill failed', {
            component: 'sessionRoutes',
            chatId,
            error: replayError.message
          });
        }
      } catch (error) {
        logger.error('Error establishing SSE connection', { component: 'sessionRoutes', error });
        if (!res.headersSent) {
          return sendInternalError(res, error, 'establish SSE connection');
        }
        emitFailedRun(chatId, { code: 'INTERNAL_ERROR', message: 'Internal server error' });
        res.end();
      }
    }
  );

  /**
   * Settle the chat's pending clarifications for an incoming message: the
   * message that carries `clarificationResponse` answers its interaction
   * (channel `chat`); any other message cancels clarifications the user
   * skipped past. Never blocks the turn.
   */
  async function settleChatClarifications({ chatId, user, lastMessage }) {
    const response = lastMessage?.clarificationResponse;
    const answeredId =
      response && typeof response === 'object'
        ? String(response.interactionId || response.questionId || '')
        : '';
    try {
      const pending = await interactionService.listPending({ chatId, kind: 'question' });
      for (const interaction of pending) {
        // `chatAuthRequired` authorizes the app, not the chat: only the
        // principal who owns the interaction's run may settle it (a chat id
        // alone must not let someone answer another user's question).
        if (!(await authorizeInteraction(interaction, user))) {
          logger.warn('Chat clarification belongs to another principal; not settled', {
            component: 'sessionRoutes',
            chatId,
            interactionId: interaction.id
          });
          continue;
        }
        if (interaction.id === answeredId) {
          await interactionService.answer(
            interaction.id,
            response.skipped ? { skipped: true } : { value: response.value },
            { user, channel: 'chat' }
          );
        } else {
          await interactionService.cancel(interaction.id, 'superseded');
        }
      }
    } catch (err) {
      logger.warn('Chat clarification not settled', {
        component: 'sessionRoutes',
        chatId,
        interactionId: answeredId || null,
        error: err.message
      });
    }
  }

  /**
   * Run one chat turn through the shared chat service. With an SSE client the
   * turn streams over the chat channel and this resolves once it ended; without
   * one the answer is written to the HTTP response.
   *
   * `persistence` is the durable-chat context the POST handler assembled, or
   * null when this turn is not stored — the service treats null as "behave
   * exactly as you did before chat persistence existed".
   */
  async function processChatRequest({
    prep,
    buildLogData,
    messageId,
    activatedSkill = null,
    streaming,
    res,
    chatId,
    DEFAULT_TIMEOUT,
    getLocalizedError,
    clientLanguage,
    user,
    persistence = null
  }) {
    await logInteraction('chat_request', buildLogData(streaming));

    const outcome = await chatService.runTurn({
      prep,
      chatId,
      messageId,
      activatedSkill,
      streaming,
      buildLogData,
      timeoutMs: DEFAULT_TIMEOUT,
      getLocalizedError,
      language: clientLanguage,
      user,
      persistence
    });
    if (streaming) return outcome;

    if (outcome.status === 'error') {
      if (outcome.error) return sendLLMError(res, outcome.error, { context: 'chat' });
      return res
        .status(502)
        .json({ error: outcome.errorInfo?.message, code: outcome.errorInfo?.code || 'ERROR' });
    }
    return res.json({
      messageId,
      model: prep.model?.id,
      content: outcome.content,
      finishReason: outcome.finishReason,
      usage: outcome.usage || null
    });
  }

  /**
   * @swagger
   * /apps/{appId}/chat/{chatId}:
   *   post:
   *     summary: Send a chat message
   *     description: |
   *       Sends a message to the AI chat. If an active SSE connection exists for the
   *       given `chatId` (established via GET on the same URL), the response streams
   *       back over that connection and this endpoint returns immediately with
   *       `{ status: "streaming" }`. Without an SSE connection the response is
   *       returned directly (non-streaming).
   *     tags:
   *       - Chat
   *     security:
   *       - bearerAuth: []
   *       - sessionAuth: []
   *     parameters:
   *       - in: path
   *         name: appId
   *         required: true
   *         schema:
   *           type: string
   *         description: The app ID
   *       - in: path
   *         name: chatId
   *         required: true
   *         schema:
   *           type: string
   *         description: Unique chat session ID matching the active SSE connection
   *     requestBody:
   *       required: true
   *       content:
   *         application/json:
   *           schema:
   *             $ref: '#/components/schemas/ChatRequest'
   *           example:
   *             messages:
   *               - role: user
   *                 content: "What is the capital of France?"
   *             modelId: "gpt-4o"
   *             outputFormat: "markdown"
   *     responses:
   *       200:
   *         description: Message accepted and streaming started (or direct response returned)
   *         content:
   *           application/json:
   *             schema:
   *               oneOf:
   *                 - $ref: '#/components/schemas/ChatStreamingResponse'
   *                 - $ref: '#/components/schemas/ChatErrorResponse'
   *             examples:
   *               streaming:
   *                 summary: Chat is streaming via SSE
   *                 value:
   *                   status: "streaming"
   *                   chatId: "550e8400-e29b-41d4-a716-446655440000"
   *               error:
   *                 summary: Error during processing
   *                 value:
   *                   status: "error"
   *                   message: "Model not found"
   *                   code: "MODEL_NOT_FOUND"
   *       400:
   *         description: Bad request (missing messages, invalid model, etc.)
   *         content:
   *           application/json:
   *             schema:
   *               type: object
   *               properties:
   *                 error:
   *                   type: string
   *       401:
   *         description: Authentication required
   *       404:
   *         description: App or model not found
   *         content:
   *           application/json:
   *             schema:
   *               type: object
   *               properties:
   *                 error:
   *                   type: string
   *                 code:
   *                   type: string
   *       500:
   *         description: Internal server error
   */
  app.post(
    buildServerPath('/api/apps/:appId/chat/:chatId'),
    chatAuthRequired,
    validate(chatPostSchema),
    async (req, res) => {
      // Destructured outside the try, and the durable mark tracked next to it,
      // so the finally below can release the chat even when the handler throws
      // before it ever reaches the turn.
      const { appId, chatId } = req.params;
      let durableTurn = false;
      try {
        const {
          messages,
          modelId,
          temperature,
          style,
          outputFormat,
          language,
          bypassAppPrompts,
          thinkingEnabled,
          thinkingBudget,
          thinkingThoughts,
          enabledTools,
          websearchEnabled,
          imageAspectRatio,
          imageQuality,
          requestedSkill,
          documentIds,
          replaceFromMessageId,
          ephemeral
        } = req.body;

        // `chatAuthRequired` authorizes the app, never the chat id. Once chats
        // are stored, anyone who guesses one could otherwise append a turn to
        // — and, through the stream, read back — another user's chat.
        const access = await authorizeChat(chatId, req.user);
        if (!access.ok) return sendNotFound(res, 'Chat session');

        const defaultLang = configCache.getPlatform()?.defaultLanguage || 'en';
        const clientLanguage =
          language || req.headers['accept-language']?.split(',')[0] || defaultLang;
        let messageId = null;
        if (messages && Array.isArray(messages) && messages.length > 0) {
          const lastMessage = messages[messages.length - 1];
          if (lastMessage && lastMessage.messageId) {
            messageId = lastMessage.messageId;
            logger.info('Using client-provided messageId', {
              component: 'sessionRoutes',
              messageId
            });
          }
        }
        const userSessionId = req.headers['x-session-id'];
        // A clarification (`ask_user`) is answered by the next message: settle the
        // pending interaction (channel `chat`) before the turn runs; any other
        // message supersedes clarifications the user chose not to answer.
        await settleChatClarifications({
          chatId,
          user: req.user,
          lastMessage: Array.isArray(messages) ? messages[messages.length - 1] : null
        });
        let model;
        let llmMessages;
        function buildLogData(streaming, extra = {}) {
          return {
            messageId,
            appId,
            modelId: model?.id,
            sessionId: chatId,
            userSessionId,
            user: req.user,
            messages: llmMessages,
            options: { temperature, style, outputFormat, language: clientLanguage, streaming },
            ...extra
          };
        }
        logger.info('Processing chat', { component: 'sessionRoutes', language: clientLanguage });
        if (!messages || !Array.isArray(messages)) {
          const errorMessage = await getLocalizedError('messagesRequired', {}, clientLanguage);
          return sendBadRequest(res, errorMessage);
        }

        // --- durable chats: the server owns the history ---
        // Persistence moves the conversation's source of truth. A persisted
        // chat posts exactly one message — the new one — and the server reads
        // the rest back out of the store, so a client can no longer rewrite
        // what it already said. Anonymous callers, ephemeral turns and
        // installations with persistence off keep posting their whole array and
        // take the same code path they always have; both modes are permanent.
        const repository = getChatRepository();
        const persistTurn =
          isPersistableChatId(chatId) &&
          isChatPersistenceActive({
            features: configCache.getFeatures(),
            platformConfig: configCache.getPlatform(),
            user: req.user,
            ephemeral
          });
        if (persistTurn && messages.length > 1) {
          return sendBadRequest(res, 'CLIENT_HISTORY_NOT_ALLOWED');
        }

        let conversation = messages;
        let persistence = null;
        const newMessage = messages[0];
        if (persistTurn && newMessage) {
          const stored = await repository.getMessages(chatId);
          let history = stored.messages;
          if (replaceFromMessageId) {
            const forkAt = history.findIndex(entry => entry.id === replaceFromMessageId);
            // Appending onto the untouched history instead would silently
            // duplicate everything the edit meant to replace, so refuse.
            if (forkAt === -1) return sendBadRequest(res, 'UNKNOWN_MESSAGE');
            history = history.slice(0, forkAt);
          }
          // An app that opted out of chat history stays a one-shot prompt:
          // storing the transcript must not start feeding it back to the model.
          const chatApp = (configCache.getApps().data || []).find(a => a.id === appId);
          conversation =
            chatApp?.sendChatHistory === false
              ? [newMessage]
              : [...historyForPrompt(history), newMessage];

          // Resolved once here and carried on the turn: `resolvePrincipal` is
          // async and hits the filesystem, and the run finishes with no request
          // in scope. The mode travels with the id so that an admin changing
          // `runLog.identityMode` later cannot orphan this chat.
          const identityMode = runLog.identityMode();
          const principal = await resolvePrincipal(req.user, { mode: identityMode });
          persistence = {
            repository,
            ownerId: principal.id,
            identityMode: principal.mode || identityMode,
            // The stored history is never client-asserted; the message being
            // sent necessarily is — it only exists in this request.
            content: typeof newMessage.content === 'string' ? newMessage.content : '',
            clientMessageId: messageId,
            attachments: messageAttachments(newMessage),
            replaceFromMessageId: replaceFromMessageId || null
          };
        }

        trackSession(chatId, { appId, userSessionId, userAgent: req.headers['user-agent'] });

        // --- @mention workflow detection ---
        // Check if the last user message contains an @workflow-name mention
        const lastUserMsg = messages[messages.length - 1];
        const lastUserContent = typeof lastUserMsg?.content === 'string' ? lastUserMsg.content : '';
        const mentionMatch = lastUserContent.match(/@([\w.-]+)/);

        if (mentionMatch) {
          const mentionedId = mentionMatch[1];
          const mentionedWorkflow = configCache.getWorkflowById(mentionedId);

          // If the user explicitly @-mentioned a workflow but it is not
          // chat-runnable, refuse the message instead of falling through to
          // the LLM (which would happily pick a *different* registered
          // workflow tool — the @human → @auto switch users have seen).
          if (mentionedWorkflow) {
            const isDisabled = mentionedWorkflow.enabled === false;
            const noChatIntegration = !mentionedWorkflow.chatIntegration?.enabled;

            if (isDisabled || noChatIntegration) {
              const wfName =
                (typeof mentionedWorkflow.name === 'object'
                  ? mentionedWorkflow.name[clientLanguage] || mentionedWorkflow.name.en
                  : mentionedWorkflow.name) || mentionedId;
              const reason = isDisabled
                ? `Workflow "${wfName}" is disabled.`
                : `Workflow "${wfName}" is not configured for chat (chatIntegration.enabled is false).`;
              if (!hasChatClient(chatId)) {
                return res.status(400).json({ status: 'error', message: reason });
              }
              emitFailedRun(chatId, {
                kind: 'workflow',
                messageId,
                code: 'WORKFLOW_UNAVAILABLE',
                message: reason,
                refs: { workflowId: mentionedId }
              });
              return res.json({ status: 'streaming', chatId });
            }
          }

          if (
            mentionedWorkflow &&
            mentionedWorkflow.enabled !== false &&
            mentionedWorkflow.chatIntegration?.enabled
          ) {
            logger.info('@mention workflow triggered', {
              component: 'sessionRoutes',
              workflowId: mentionedId,
              chatId
            });

            // Strip the @mention from the input
            const strippedInput = lastUserContent.replace(/@[\w.-]+/, '').trim();

            // Collect file data from the last message
            const fileData = lastUserMsg.fileData || null;
            const imageData = lastUserMsg.imageData || null;

            // Build chat history from all prior messages (excluding the last).
            // From `conversation`, not the request body: for a persisted chat
            // the prior turns came out of the store, not off the wire.
            const chatHistory = conversation.slice(0, -1).map(m => ({
              role: m.role,
              content: m.content
            }));

            // The @mention launch owns a run on the chat stream: the bridge in
            // workflowRunner streams progress and the answer under this runId.
            const workflowRunId = newRunId('workflow');
            const launch = new RunStreamEmitter({ streamId: chatId, runId: workflowRunId });
            launch.emit(SSE_V2_EVENTS.RUN_STARTED, {
              kind: 'workflow',
              refs: { chatId, appId, messageId, workflowId: mentionedId }
            });
            const failLaunch = message => {
              launch.emit(SSE_V2_EVENTS.STREAM_ERROR, { code: 'WORKFLOW_FAILED', message });
              launch.emit(SSE_V2_EVENTS.RUN_ENDED, {
                status: 'error',
                finishReason: 'error',
                error: { message }
              });
            };

            // A workflow turn is a turn: the user asked something in this chat
            // and read an answer in it. The launch never goes through
            // `ChatService`, which is what materializes an ordinary turn, so
            // both halves are written here or the exchange is missing from the
            // transcript — and from the history every later turn replays.
            await materializeWorkflowUserTurn({
              persistence,
              chatId,
              appId,
              modelId,
              runId: workflowRunId
            });

            try {
              const workflowRunnerMod = await import('../../tools/workflowRunner.js');

              // Fire-and-forget: start workflow but don't await completion.
              // The workflowRunner bridge streams step events and final output via SSE.
              workflowRunnerMod
                .default({
                  workflowId: mentionedId,
                  chatId,
                  runId: workflowRunId,
                  user: req.user,
                  input: strippedInput,
                  modelId,
                  _chatHistory: chatHistory.length > 0 ? chatHistory : undefined,
                  _fileData: fileData || imageData || undefined,
                  language: clientLanguage
                })
                .then(result =>
                  // The assistant half comes off the resolved run rather than
                  // the SSE frames: the client may be long gone by now, and
                  // the store is the thing that has to outlive it.
                  materializeWorkflowAssistantTurn({
                    persistence,
                    chatId,
                    runId: workflowRunId,
                    summary: workflowSummary(result)
                  })
                )
                .catch(error => {
                  logger.error('Error running @mention workflow', {
                    component: 'sessionRoutes',
                    error
                  });
                  failLaunch(`Workflow execution failed: ${error.message}`);
                  return materializeWorkflowAssistantTurn({
                    persistence,
                    chatId,
                    runId: workflowRunId,
                    summary: workflowSummary({ status: 'failed', error: error.message })
                  });
                });

              // Return immediately — the SSE channel delivers all progress + final output
              return res.json({ status: 'streaming', chatId });
            } catch (error) {
              logger.error('Error loading workflow runner', { component: 'sessionRoutes', error });
              failLaunch(`Workflow execution failed: ${error.message}`);
              // The user half is already stored and the chat is marked
              // `running` for a run that will never start; close it out.
              await materializeWorkflowAssistantTurn({
                persistence,
                chatId,
                runId: workflowRunId,
                summary: workflowSummary({ status: 'failed', error: error.message })
              });
              return res.json({ status: 'error', message: error.message });
            }
          }
        }
        // --- end @mention detection ---

        // Resolve the SSE sink once, up front. In cluster mode the stream for
        // this chat may be held by another worker, in which case this is a
        // relay shim rather than a local response; null means no stream exists
        // anywhere and the answer has to come back on this POST instead.
        // Deciding from the sink itself (rather than checking membership and
        // fetching separately) keeps the two in step.
        const streamOpen = hasChatClient(chatId);

        // From here the turn owns the chat. A persisted turn has to survive the
        // browser closing — its answer is written to the store either way — so
        // the three paths that abort a run on disconnect must leave it alone
        // until the finally below releases the mark.
        if (persistence) {
          markChatDurable(chatId);
          durableTurn = true;
        }

        if (!streamOpen) {
          logger.info('No active SSE connection, creating response without streaming', {
            component: 'sessionRoutes',
            chatId
          });
          const prep = await chatService.prepareChatRequest({
            appId,
            modelId,
            messages: conversation,
            temperature,
            style,
            outputFormat,
            language: clientLanguage,
            bypassAppPrompts,
            thinkingEnabled,
            thinkingBudget,
            thinkingThoughts,
            enabledTools,
            websearchEnabled,
            imageAspectRatio,
            imageQuality,
            requestedSkill,
            documentIds,
            user: req.user,
            chatId
          });
          if (!prep.success) {
            const errMsg = await getLocalizedError(
              prep.error.code || 'internalError',
              {},
              clientLanguage
            );
            return res
              .status(
                prep.error.code === 'APP_NOT_FOUND' || prep.error.code === 'MODEL_NOT_FOUND'
                  ? 404
                  : prep.error.code === 'noModelsAvailable' ||
                      prep.error.code === 'noCompatibleModels' ||
                      prep.error.code === 'noModelIdProvided' ||
                      prep.error.code === 'noModelsForUser'
                    ? 400
                    : 500
              )
              .json({ error: errMsg, code: prep.error.code });
          }
          ({ model, llmMessages } = prep.data);

          // Awaited, not returned bare: `return promise` inside a try/finally
          // runs the finally before the turn settles, which would drop the
          // durable mark while the run is still going.
          return await processChatRequest({
            prep: prep.data,
            buildLogData,
            messageId,
            streaming: false,
            res,
            chatId,
            DEFAULT_TIMEOUT,
            getLocalizedError,
            clientLanguage,
            user: req.user,
            persistence
          });
        } else {
          // Note that `hasChatClient` refreshed lastActivity on the
          // existing map entry in place rather than replacing it: the SSE GET
          // handler pins that object reference via `myEntry` to identify a stale
          // `req.on('close')` after a reconnect, and replacing the entry would
          // defeat that check, letting a dead socket's close handler bail out
          // and leak the Map entry + activeRequests controller for up to
          // 5 minutes until cleanupInactiveClients evicts it.
          const prep = await chatService.prepareChatRequest({
            appId,
            modelId,
            messages: conversation,
            temperature,
            style,
            outputFormat,
            language: clientLanguage,
            bypassAppPrompts,
            thinkingEnabled,
            thinkingBudget,
            thinkingThoughts,
            enabledTools,
            websearchEnabled,
            imageAspectRatio,
            imageQuality,
            requestedSkill,
            documentIds,
            user: req.user,
            chatId
          });
          if (!prep.success) {
            const errMsg = await getLocalizedError(
              prep.error.code || 'internalError',
              {},
              clientLanguage
            );
            emitFailedRun(chatId, { messageId, code: prep.error.code, message: errMsg });
            return res.json({ status: 'error', message: errMsg, code: prep.error.code });
          }
          model = prep.data.model;
          llmMessages = prep.data.llmMessages;

          // A skill pre-activated via slash command is announced on the turn's run.
          let activatedSkill = null;
          if (requestedSkill) {
            const { data: skills = [] } = configCache.getSkills();
            const skillMeta = skills.find(s => s.name === requestedSkill);
            activatedSkill = {
              skillName: requestedSkill,
              description: skillMeta?.description || ''
            };
          }

          await processChatRequest({
            prep: prep.data,
            buildLogData,
            messageId,
            activatedSkill,
            streaming: true,
            res: null,
            chatId,
            DEFAULT_TIMEOUT,
            getLocalizedError,
            clientLanguage,
            user: req.user,
            persistence
          });

          return res.json({ status: 'streaming', chatId });
        }
      } catch (error) {
        logger.error('Error in app chat', { component: 'sessionRoutes', error });
        return sendInternalError(res, error, 'app chat');
      } finally {
        // The turn is over however it ended, so a disconnect from here on has
        // nothing to protect and should abort again.
        if (durableTurn) clearChatDurable(chatId);
      }
    }
  );

  /**
   * @swagger
   * /apps/{appId}/chat/{chatId}/stop:
   *   post:
   *     summary: Stop a chat stream
   *     description: |
   *       Aborts the active LLM request and closes the SSE stream for the given chat
   *       session. Any in-progress workflow execution triggered by the chat is also
   *       cancelled.
   *     tags:
   *       - Chat
   *     security:
   *       - bearerAuth: []
   *       - sessionAuth: []
   *     parameters:
   *       - in: path
   *         name: appId
   *         required: true
   *         schema:
   *           type: string
   *         description: The app ID
   *       - in: path
   *         name: chatId
   *         required: true
   *         schema:
   *           type: string
   *         description: The chat session ID to stop
   *     responses:
   *       200:
   *         description: Chat stream stopped (or session not found)
   *         content:
   *           application/json:
   *             schema:
   *               type: object
   *               properties:
   *                 success:
   *                   type: boolean
   *                 message:
   *                   type: string
   *             examples:
   *               stopped:
   *                 summary: Stream stopped successfully
   *                 value:
   *                   success: true
   *                   message: "Chat stream stopped"
   *               notFound:
   *                 summary: Session not found
   *                 value:
   *                   success: false
   *                   message: "Chat session not found"
   *       401:
   *         description: Authentication required
   *       404:
   *         description: Chat session not found
   */
  app.post(
    buildServerPath('/api/apps/:appId/chat/:chatId/stop'),
    chatAuthRequired,
    async (req, res) => {
      const { chatId } = req.params;
      // `chatAuthRequired` authorizes the app, never the chat id: stopping
      // someone else's turn must not be one guessed id away.
      const access = await authorizeChat(chatId, req.user);
      if (!access.ok) return sendNotFound(res, 'Chat session');

      // A live SSE client used to be the proof that there was something to
      // stop. It no longer is: a persisted turn keeps running after its client
      // is gone, and that is exactly the turn a user needs to be able to stop.
      // Anything in flight for this chat, anywhere in the cluster, qualifies.
      if (!hasChatClient(chatId) && !isChatDurable(chatId) && !hasActiveChatRequest(chatId)) {
        return sendNotFound(res, 'Chat session');
      }

      // The stop is a human event on the run bound to this chat stream. That
      // binding is process-local, so for a turn running on another worker —
      // the normal case once the client is gone — fall back to the run the
      // chat document recorded when the turn started.
      const bound = getStreamRun(chatId);
      const boundRunId =
        (bound && typeof bound === 'object' ? bound.runId : bound) ||
        access.chat?.activeRunId ||
        null;
      if (boundRunId) {
        try {
          // The turn may run on another worker: continue its persisted sequence.
          await runLog.appendRecovered(boundRunId, RUN_LOG_EVENTS.HUMAN_EVENT, {
            kind: 'stop',
            by: await resolveActorId(req.user, {
              mode: runLog.getRunMeta(boundRunId)?.identityMode || runLog.identityMode()
            }),
            at: new Date().toISOString()
          });
        } catch (ledgerErr) {
          logger.debug('Stop human/event not recorded', {
            component: 'sessionRoutes',
            chatId,
            error: ledgerErr.message
          });
        }
      }
      // Each of the three teardown steps targets state that may live on a
      // different worker than this POST landed on: the LLM call, the workflow
      // execution and the SSE stream are registered independently, so each
      // helper resolves its own owner and relays if it is not this process.
      // The abort is deliberately the unconditional one — Stop overrides
      // durability, which only ever protects a run from a *disconnect*.
      const aborted = abortChatRequest(chatId);

      // Also cancel any running workflow execution for this chatId
      const workflowCancelled = await cancelChatWorkflow(chatId);

      // Note the awaits above: cancelling the workflow yields the event loop,
      // and the SSE connection can close in that gap (its req.on('close')
      // handler deletes the entry from `clients`). The check at the top of the
      // handler is therefore stale here, which is why the close goes through
      // `closeChatClient` — it re-reads the entry and no-ops when it is gone,
      // instead of dereferencing undefined. An unguarded
      // `client.response.end()` throws a TypeError that crashes the whole
      // process as an unhandled rejection on Node >= 15.
      const closed = closeChatClient(chatId);

      // Report what actually happened. The guard above passes on the durable
      // mark alone, and a mark can outlive the thing it marks by the width of
      // this handler — answering `success: true` there would tell the user a
      // turn was stopped when nothing was found to stop.
      if (!aborted && !workflowCancelled && !closed) {
        logger.info('Chat stop found nothing in flight', { component: 'sessionRoutes', chatId });
        return sendNotFound(res, 'Chat session');
      }
      logger.info('Chat stream stopped', { component: 'sessionRoutes', chatId });
      return res.status(200).json({ success: true, message: 'Chat stream stopped' });
    }
  );

  /**
   * @swagger
   * /apps/{appId}/chat/{chatId}/status:
   *   get:
   *     summary: Get chat session status
   *     description: |
   *       Returns the current status of a chat session, including whether the SSE
   *       connection is active, the timestamp of the last activity, and whether an
   *       LLM request is currently being processed.
   *     tags:
   *       - Chat
   *     security:
   *       - bearerAuth: []
   *       - sessionAuth: []
   *     parameters:
   *       - in: path
   *         name: appId
   *         required: true
   *         schema:
   *           type: string
   *         description: The app ID
   *       - in: path
   *         name: chatId
   *         required: true
   *         schema:
   *           type: string
   *         description: The chat session ID
   *     responses:
   *       200:
   *         description: Chat session status
   *         content:
   *           application/json:
   *             schema:
   *               type: object
   *               properties:
   *                 active:
   *                   type: boolean
   *                   description: Whether the SSE connection is currently open
   *                 lastActivity:
   *                   type: string
   *                   format: date-time
   *                   description: Timestamp of the last activity on this session
   *                 processing:
   *                   type: boolean
   *                   description: Whether an LLM request is currently in progress
   *             examples:
   *               active:
   *                 summary: Active session with ongoing request
   *                 value:
   *                   active: true
   *                   lastActivity: "2026-01-15T10:30:00.000Z"
   *                   processing: true
   *               inactive:
   *                 summary: No active session
   *                 value:
   *                   active: false
   *       401:
   *         description: Authentication required
   */
  app.get(buildServerPath('/api/apps/:appId/chat/:chatId/status'), chatAuthRequired, (req, res) => {
    const { chatId } = req.params;
    if (hasChatClient(chatId)) {
      // lastActivity lives with the response object, so it is only readable on
      // the worker holding the stream. Rather than a bus round trip for a
      // diagnostic field, report null when the stream is elsewhere — `active`
      // and `processing` are the parts callers branch on.
      return res.status(200).json({
        active: true,
        lastActivity: clients.get(chatId)?.lastActivity ?? null,
        processing: hasActiveChatRequest(chatId)
      });
    }
    return res.status(200).json({ active: false });
  });
}
