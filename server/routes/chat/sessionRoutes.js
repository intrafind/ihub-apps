import configCache from '../../configCache.js';
import { appendMcpAppContext } from '../../services/mcp/mcpAppContext.js';
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
import { authorizeChat } from '../../services/chat/chatAccess.js';
import { emitFailedRun } from '../../services/chat/failedRun.js';
import { tryHandleMentionWorkflow } from '../../services/workflow/mentionWorkflow.js';
import {
  getChatRepository,
  isPersistableChatId,
  normalizeChatSettings,
  normalizeChatVariables
} from '../../services/chat/ChatRepository.js';
import { isChatPersistenceActive } from '../../services/chat/chatPersistence.js';
import validate from '../../validators/validate.js';
import { chatTestSchema, chatPostSchema, chatConnectSchema } from '../../validators/index.js';
import { buildServerPath } from '../../utils/basePath.js';
import logger from '../../utils/logger.js';
import { findByIdCaseInsensitive } from '../../utils/resourceLookup.js';
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
 * Chat-shaped view of a persisted transcript: role and content only.
 *
 * Everything else on a stored message — ids, usage, the error of a failed turn,
 * attachment descriptors — is bookkeeping for the history UI and has no place
 * in a model prompt. Contentless turns are dropped with it: an aborted or
 * failed turn is stored with an empty answer, and several providers reject a
 * blank message outright.
 *
 * @param {Array<Object>} stored - Messages as `ChatRepository` returns them.
 * @returns {Array<{role: string, content: string, activeSkills?: Array<Object>}>} An answer
 *   keeps the skills it activated (`activity.activeSkills`), so they stay active.
 */
export function historyForPrompt(stored) {
  return stored
    .filter(entry => entry?.role && typeof entry.content === 'string' && entry.content.trim())
    .map(entry => {
      // The skills an answer activated stay active in the chat; the request
      // builder reads them from here and re-checks access every turn.
      const skills = entry.role === 'assistant' ? entry.activity?.activeSkills : null;
      return {
        role: entry.role,
        content: entry.content,
        ...(Array.isArray(skills) && skills.length > 0 ? { activeSkills: skills } : {})
      };
    });
}

/**
 * The skills a turn announces as activated on its run: the ones it activates
 * itself (named in the request or the message), not the ones still active
 * from earlier turns.
 *
 * @param {Array<{name: string, displayName: string, description?: string, origin: string}>} [skills]
 *   `activeSkills` of the prepared request
 * @returns {Array<{skillName: string, skillId: string, activatedBy: 'user', description: string}>}
 */
export function announcedSkills(skills) {
  return (Array.isArray(skills) ? skills : [])
    .filter(skill => skill.origin !== 'chat')
    .map(skill => ({
      skillName: skill.displayName,
      skillId: skill.name,
      activatedBy: 'user',
      description: skill.description || ''
    }));
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
   *         hostContext:
   *           type: object
   *           description: >-
   *             Optional item the host shows next to the chat — `currentEmail`,
   *             `currentPage`, `currentMeeting` and `addedEmails`, each field a
   *             display-ready string. The server renders it, together with
   *             `fileData`, as `<content>` blocks around `content` (see
   *             docs/apps.md, "What {{content}} contains"); `content` stays what the user
   *             typed.
   *
   *     ChatRequest:
   *       type: object
   *       description: Request body for sending a chat message
   *       required:
   *         - messages
   *       properties:
   *         messages:
   *           type: array
   *           description: >-
   *             The conversation to send. When the installation stores chats
   *             server-side (the `chatPersistence` feature, for an
   *             authenticated caller on a turn that is not `ephemeral`) the
   *             server owns the history and this must hold exactly the new
   *             message; more than one is refused with
   *             `CLIENT_HISTORY_NOT_ALLOWED`. Otherwise it is the whole
   *             conversation history, as before.
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
   *         thinkingLevel:
   *           type: string
   *           enum: [minimal, low, medium, high]
   *           description: Reasoning effort for extended thinking
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
   *         requestedSkills:
   *           type: array
   *           maxItems: 10
   *           items:
   *             type: string
   *           description: Skills to pre-activate for this turn, by global skill name or user skill id. Writing `/skill-name` in the message does the same. Only skills the app and the user may use are activated, up to the app's skillSettings.maxActiveSkills (default 3).
   *         documentIds:
   *           type: array
   *           items:
   *             type: string
   *           description: IDs of documents to include as context
   *         replaceFromMessageId:
   *           type: string
   *           description: |
   *             Persisted chats only. Message id to fork the history from
   *             (inclusive) before the new message is appended — an edit or a
   *             regenerate. Matches either the stored id or the client exchange
   *             id the message was stored under (clientMessageId). Unknown ids
   *             are rejected with 400 UNKNOWN_MESSAGE.
   *         sendChatHistory:
   *           type: boolean
   *           description: |
   *             Persisted chats only. False prompts the model with just this
   *             message instead of the stored transcript — the viewer's
   *             "Include chat history in requests" setting. Advisory: it can
   *             only remove history, never add it.
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
        const model = findByIdCaseInsensitive(models, modelId);
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
        const access = await authorizeChat(chatId, req.user, { intent: 'read' });
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
    activatedSkills = [],
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
      activatedSkills,
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
   *         description: >-
   *           Bad request (missing messages, invalid model, etc.). Also
   *           `CLIENT_HISTORY_NOT_ALLOWED` when the chat is stored
   *           server-side and more than one message was posted — send only the
   *           new message, or `ephemeral: true`.
   *         content:
   *           application/json:
   *             schema:
   *               type: object
   *               properties:
   *                 error:
   *                   type: string
   *       401:
   *         description: Authentication required
   *       403:
   *         description: >-
   *           The requested `modelId` exists but is outside the user's group-permitted
   *           models (`modelAccessDeniedForUser`)
   *         content:
   *           application/json:
   *             schema:
   *               type: object
   *               properties:
   *                 error:
   *                   type: string
   *                 code:
   *                   type: string
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
          thinkingLevel,
          thinkingThoughts,
          enabledTools,
          websearchEnabled,
          imageAspectRatio,
          imageQuality,
          requestedSkills,
          documentIds,
          replaceFromMessageId,
          ephemeral,
          sendChatHistory,
          mcpAppContext
        } = req.body;

        // `chatAuthRequired` authorizes the app, never the chat id. Once chats
        // are stored, anyone who guesses one could otherwise append a turn to
        // — and, through the stream, read back — another user's chat.
        const access = await authorizeChat(chatId, req.user, { intent: 'write' });
        if (!access.ok) return sendNotFound(res, 'Chat session');

        const defaultLang = configCache.getPlatform()?.defaultLanguage || 'en';
        const clientLanguage =
          language || req.headers['accept-language']?.split(',')[0] || defaultLang;
        let messageId = null;
        if (messages && Array.isArray(messages) && messages.length > 0) {
          const lastMessage = messages.at(-1);
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
          lastMessage: Array.isArray(messages) ? messages.at(-1) : null
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
          // The code alone tells an integrator nothing about what to do
          // instead, and this is the one refusal they can hit by doing exactly
          // what the documentation told them to do before the feature existed.
          return sendBadRequest(res, 'CLIENT_HISTORY_NOT_ALLOWED', {
            hint:
              'This chat is stored server-side: post only the new message as a single-element ' +
              'messages array, or send ephemeral: true to keep the turn out of the store and ' +
              'post the whole conversation yourself.'
          });
        }

        let conversation = messages;
        let persistence = null;
        const newMessage = messages[0];
        if (persistTurn && newMessage) {
          const stored = await repository.getMessages(chatId);
          let history = stored.messages;
          let forkStoredId = null;
          if (replaceFromMessageId) {
            // Either id the client can know this message by: the stored id it
            // was given on hydrate, or — for a turn made in the session that
            // is still open, which never learns the stored id — the exchange
            // id it sent and the store filed as `clientMessageId`. Without the
            // second, regenerating the answer you just got would carry no fork
            // id at all and the retry would be appended to the untouched
            // history, duplicating the exchange.
            const forkAt = history.findIndex(
              entry =>
                entry.id === replaceFromMessageId || entry.clientMessageId === replaceFromMessageId
            );
            // Appending onto the untouched history instead would silently
            // duplicate everything the edit meant to replace, so refuse.
            if (forkAt === -1) return sendBadRequest(res, 'UNKNOWN_MESSAGE');
            // Carry the *stored* id onward. The store matches on `id` alone,
            // so forwarding the client's value forked the prompt here and not
            // the transcript: a regenerate in a session that never hydrated
            // sends its exchange id, which this lookup resolves and the store
            // then rejects with UNKNOWN_MESSAGE. `materializeUserTurn` logs
            // and returns null, the chat document has already been updated,
            // and the answer lands at the end — so the stored history keeps
            // the exchange the user replaced and, for an edit, never records
            // the edited question at all. Permanent, and replayed to the model
            // every turn after.
            forkStoredId = history[forkAt].id;
            history = history.slice(0, forkAt);
          }
          // An app that opted out of chat history stays a one-shot prompt:
          // storing the transcript must not start feeding it back to the
          // model. The viewer's own "Include chat history in requests" toggle
          // says the same thing for one turn: with the client posting a single
          // message either way, this field is the only channel it has left.
          const chatApp = (configCache.getApps().data || []).find(a => a.id === appId);
          // The app variables are chat state: a turn that sets them (the
          // start form's, or any turn of an app that asks for them beside the
          // chat) stores them, and a turn that does not gets the stored ones —
          // for the system prompt, never as a re-rendered `prompt` template.
          const turnVariables = normalizeChatVariables(newMessage.variables);
          const chatVariables =
            turnVariables ||
            (chatApp?.variables?.length
              ? normalizeChatVariables((await repository.getChat(chatId))?.variables)
              : null);
          // The prompt reads the variables as they are stored, so this turn and
          // the ones after it render them alike (`false` is "false" in both).
          const promptMessage = chatVariables
            ? { ...newMessage, variables: chatVariables }
            : newMessage;
          conversation =
            chatApp?.sendChatHistory === false || sendChatHistory === false
              ? [promptMessage]
              : [...historyForPrompt(history), promptMessage];

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
            variables: turnVariables,
            replaceFromMessageId: forkStoredId,
            // How this turn is being answered, so reopening the chat comes
            // back with the same setup rather than the app's defaults. Only
            // the keys this request actually carried: the repository merges
            // them over what earlier turns recorded, and `undefined` here
            // means "this turn said nothing about it".
            settings: normalizeChatSettings({
              style,
              outputFormat,
              temperature,
              sendChatHistory,
              thinkingEnabled,
              thinkingLevel,
              thinkingThoughts,
              enabledTools,
              websearchEnabled,
              imageAspectRatio,
              imageQuality
            })
          };
        }

        trackSession(chatId, { appId, userSessionId, userAgent: req.headers['user-agent'] });

        const mention = await tryHandleMentionWorkflow({
          messages,
          conversation,
          chatId,
          appId,
          messageId,
          modelId,
          user: req.user,
          clientLanguage,
          persistence
        });
        if (mention.handled) {
          return mention.statusCode
            ? res.status(mention.statusCode).json(mention.response)
            : res.json(mention.response);
        }

        // Both branches below prepare the very same request; they differ in what
        // they do with the outcome. Built once so they cannot drift apart.
        const chatRequestOptions = {
          appId,
          modelId,
          messages: conversation,
          temperature,
          style,
          outputFormat,
          language: clientLanguage,
          bypassAppPrompts,
          thinkingEnabled,
          thinkingLevel,
          thinkingThoughts,
          enabledTools,
          websearchEnabled,
          imageAspectRatio,
          imageQuality,
          requestedSkills,
          documentIds,
          user: req.user,
          chatId
        };

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
          const prep = await chatService.prepareChatRequest(chatRequestOptions);
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
                  : prep.error.code === 'modelAccessDeniedForUser'
                    ? 403
                    : prep.error.code === 'noModelsAvailable' ||
                        prep.error.code === 'noCompatibleModels' ||
                        prep.error.code === 'noModelIdProvided' ||
                        prep.error.code === 'noModelsForUser'
                      ? 400
                      : 500
              )
              .json({ error: errMsg, code: prep.error.code });
          }
          appendMcpAppContext(prep.data.llmMessages, mcpAppContext);
          ({ model, llmMessages } = prep.data);

          // Awaited, not returned bare: `return promise` inside a try/finally
          // runs the finally before the turn settles, which would drop the
          // durable mark while the run is still going.
          return await processChatRequest({
            prep: prep.data,
            buildLogData,
            messageId,
            activatedSkills: announcedSkills(prep.data.activeSkills),
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
          const prep = await chatService.prepareChatRequest(chatRequestOptions);
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
          // What open MCP App views reported since the last turn; model-only.
          appendMcpAppContext(prep.data.llmMessages, mcpAppContext);
          llmMessages = prep.data.llmMessages;

          // Skills this turn activates (`/name` in the message, or
          // `requestedSkills`) are announced on the run: the usable subset the
          // request builder put in the system prompt, never a skill the app or
          // the user may not use. Skills still active from earlier turns were
          // announced when they were activated.
          const activatedSkills = announcedSkills(prep.data.activeSkills);

          await processChatRequest({
            prep: prep.data,
            buildLogData,
            messageId,
            activatedSkills,
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
      const access = await authorizeChat(chatId, req.user, { intent: 'write' });
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
  app.get(
    buildServerPath('/api/apps/:appId/chat/:chatId/status'),
    chatAuthRequired,
    async (req, res) => {
      const { chatId } = req.params;
      // `chatAuthRequired` authorizes the app, never the chat id — the same
      // reason SSE connect, the turn POST and stop all add this. Durable chats
      // put the id in the address bar, so ids reach history, referrers and
      // pasted links; without this, anyone reaching the same app who holds
      // another user's id can poll this route as an activity oracle.
      const access = await authorizeChat(chatId, req.user, { intent: 'read' });
      if (!access.ok) return sendNotFound(res, 'Chat session');
      if (hasChatClient(chatId)) {
        // lastActivity lives with the response object, so it is only readable
        // on the worker holding the stream. Rather than a bus round trip for a
        // diagnostic field, report null when the stream is elsewhere —
        // `active` and `processing` are the parts callers branch on.
        return res.status(200).json({
          active: true,
          lastActivity: clients.get(chatId)?.lastActivity ?? null,
          processing: hasActiveChatRequest(chatId)
        });
      }
      return res.status(200).json({ active: false });
    }
  );
}
