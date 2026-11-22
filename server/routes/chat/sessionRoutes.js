// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

import configCache from '../../configCache.js';
import llmClient, {
  usageToOpenAI,
  isLLMError,
  LLM_ERROR_CODES
} from '../../services/loop/LLMClient.js';
import {
  clients,
  abortChatRequest,
  abortChatRequestOnDisconnect,
  closeChatClient,
  hasActiveChatRequest,
  hasChatClient,
  isChatDurable,
  openChatPostStream,
  postStreams,
  writeStreamStart
} from '../../sse.js';
import { resumeChatRun } from '../../services/chat/chatResume.js';
import { RunStreamEmitter, getStreamRun } from '../../services/loop/RunStream.js';
import runLog, { newRunId, isValidRunId } from '../../services/loop/RunLog.js';
import { resolveActorId } from '../../services/loop/runIdentity.js';
import { authorizeInteraction } from '../../services/loop/runAccess.js';
import interactionService from '../../services/loop/InteractionService.js';
import { SSE_V2_EVENTS, RUN_LOG_EVENTS } from '../../../shared/runEvents.js';
import { createSseChannel } from '../../utils/sseChannel.js';
import {
  authRequired,
  chatAuthRequired,
  modelAccessRequired
} from '../../middleware/authRequired.js';
import { aiAcknowledgementRequired } from '../../middleware/aiAcknowledgementRequired.js';

import ChatService from '../../services/chat/ChatService.js';
import {
  prepareTurn,
  principalRefOf,
  refusalError,
  runPreparedTurn
} from '../../services/chat/chatTurnStart.js';
import { authorizeChat } from '../../services/chat/chatAccess.js';
import { emitFailedRun } from '../../services/chat/failedRun.js';
import validate from '../../validators/validate.js';
import { chatTestSchema, chatPostSchema, chatConnectSchema } from '../../validators/index.js';
import { buildServerPath } from '../../utils/basePath.js';
import logger from '../../utils/logger.js';
import { describeCause, userAbortCause } from '../../services/chat/abortCause.js';
import { findByIdCaseInsensitive } from '../../utils/resourceLookup.js';
import { ServiceError } from '../../utils/ServiceError.js';
import { codeOfStatus } from '../../utils/errorResponse.js';
import { drainPendingFinish } from '../../services/workflow/chatBridge.js';
import { cancelChatWorkflow, replayChatWorkflowProgress } from '../../tools/workflowRunner.js';

/**
 * The error a refusal answers with: its own code, else the one of its status. A route throws it
 * (`throw refusal(404, 'Not here', { code: 'SOMETHING' })`) and the error middleware answers.
 *
 * @param {number} status - HTTP status
 * @param {string} message
 * @param {{ code?: string, details?: Object }} [options]
 * @returns {ServiceError}
 */
function refusal(status, message, { code, details } = {}) {
  return new ServiceError(code ?? codeOfStatus(status), message, { status, details });
}

/**
 * Whether a chat POST asks for its turn as a stream: `text/event-stream` named
 * in `Accept` and preferred over JSON (q-values respected). A wildcard alone
 * (any type, `text/*`) keeps the JSON answer.
 *
 * @param {import('express').Request} req
 * @returns {boolean}
 */
function wantsEventStream(req) {
  const accept = req.get?.('accept') || '';
  return (
    /\btext\/event-stream\b/i.test(accept) &&
    req.accepts(['application/json', 'text/event-stream']) === 'text/event-stream'
  );
}

/**
 * The chat POST as a turn request: everything the turn reads from the request,
 * as plain data (`TurnRequest` of `services/chat/chatTurnStart.js`). What the
 * body left out stays `undefined`: the chat's stored setup fills it in.
 *
 * The body is checked by `chatPostSchema`, so `messages` is a list. Its last
 * entry is the new message; how many came before it is `clientHistory`, which
 * the turn start refuses, after it checked who is asking.
 *
 * @param {import('express').Request} req
 * @returns {import('../../services/chat/chatTurnStart.js').TurnRequest}
 */
function turnRequestOf(req) {
  const { appId, chatId } = req.params;
  const { messages } = req.body;
  const message = messages.at(-1);
  let messageId = null;
  if (message && message.messageId) {
    messageId = message.messageId;
    logger.debug('Using client-provided messageId', { component: 'sessionRoutes', messageId });
  }
  return {
    chatId,
    appId,
    principalRef: principalRefOf(req.user),
    messageId,
    message,
    clientHistory: Math.max(messages.length - 1, 0),
    modelId: req.body.modelId,
    style: req.body.style,
    outputFormat: req.body.outputFormat,
    sendChatHistory: req.body.sendChatHistory,
    thinkingEnabled: req.body.thinkingEnabled,
    thinkingLevel: req.body.thinkingLevel,
    thinkingThoughts: req.body.thinkingThoughts,
    enabledTools: req.body.enabledTools,
    websearchEnabled: req.body.websearchEnabled,
    imageAspectRatio: req.body.imageAspectRatio,
    imageQuality: req.body.imageQuality,
    integrationScopes: req.body.integrationScopes,
    language: req.body.language || req.headers['accept-language']?.split(',')[0],
    // The chat POST carries no time zone.
    clientTimezone: null,
    toolApprovalCapable: req.body.toolApprovalCapable,
    // A message somebody sent: the only origin this route has.
    origin: 'person',
    bypassAppPrompts: req.body.bypassAppPrompts,
    requestedSkills: req.body.requestedSkills,
    documentIds: req.body.documentIds,
    replaceFromMessageId: req.body.replaceFromMessageId,
    ephemeral: req.body.ephemeral,
    mcpAppContext: req.body.mcpAppContext,
    voiceMode: req.body.voiceMode,
    projectId: req.body.projectId,
    projects: req.body.projects,
    testProjectId: req.body.testProjectId,
    client: {
      sessionId: req.headers['x-session-id'],
      userAgent: req.headers['user-agent'],
      ip: req.ip,
      url: req.originalUrl || req.baseUrl || req.url || ''
    }
  };
}

// These helpers of a turn live with the turn start; the names stay importable from here.
export {
  announcedSkills,
  historyForPrompt,
  messageAttachments
} from '../../services/chat/chatTurnStart.js';

/**
 * The JSON answer of a chat POST whose turn was told on the chat's GET stream.
 * A refused turn is not answered here: the handler throws it once the turn has
 * let go of the chat.
 *
 * @param {import('express').Response} res
 * @param {string} chatId
 * @param {import('../../services/chat/chatTurnStart.js').TurnOutcome} outcome
 */
function answerTurnAsJson(res, chatId, outcome) {
  if (outcome.status === 'failed') {
    res.json({ status: 'error', message: outcome.error.message, code: outcome.error.code });
  } else if (outcome.status === 'ran') {
    res.json({ status: 'streaming', chatId });
  }
}

/**
 * Settle the chat's pending clarifications for an incoming message: the
 * message that carries `clarificationResponse` answers its interaction
 * (channel `chat`); any other message cancels clarifications the user
 * skipped past. Never blocks the turn.
 *
 * Both are the owner's own: an answer continues the run with the owner's
 * rights, and a question the message skips past is superseded by its owner's
 * message. So both ask run access with the intent `answer`; an admin whose
 * message reaches somebody else's chat settles nothing.
 *
 * @param {Object} params
 * @param {string} params.chatId
 * @param {Object} params.user - req.user
 * @param {Object|null} params.lastMessage - the message of this POST
 * @returns {Promise<{runId: string, interactionId: string}|null>} the run this
 *   message answered a clarification of — the turn continues it — or null
 */
export async function settleChatClarifications({ chatId, user, lastMessage }) {
  let answered = null;
  const response = lastMessage?.clarificationResponse;
  const answeredId =
    response && typeof response === 'object'
      ? String(response.interactionId || response.questionId || '')
      : '';
  try {
    const pending = await interactionService.listPending({ chatId, kind: 'question' });
    for (const interaction of pending) {
      // `chatAuthRequired` authorizes the app, not the chat: only the
      // principal who owns the interaction's run may answer it (a chat id
      // alone must not let someone answer another user's question). A
      // question the message skips past is superseded by its owner's own
      // message, so it takes the same right: the `cancel` intent would let
      // an admin's message into somebody else's chat settle it unaudited.
      if (!(await authorizeInteraction(interaction, user, { intent: 'answer' }))) {
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
        answered = { runId: interaction.runId, interactionId: interaction.id };
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
  return answered;
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
   *             Exactly the new message. Every chat is stored server-side
   *             and the server owns its history; more than one message is
   *             refused with `CLIENT_HISTORY_NOT_ALLOWED`. A caller that
   *             wants to hold the history itself uses the stateless
   *             OpenAI-compatible chat completions endpoint.
   *           items:
   *             $ref: '#/components/schemas/ChatMessage'
   *         modelId:
   *           type: string
   *           description: ID of the model to use (overrides app default)
   *           example: "gpt-4o"
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
   *         integrationScopes:
   *           type: object
   *           additionalProperties:
   *             type: string
   *           description: |
   *             The scope picked per integration for this chat, e.g.
   *             `{ "ifinder": "contracts", "iassistant": "assistant:legal" }`
   *             (see `GET /api/integrations/scopes`). Checked against what the
   *             integration offers the user; it binds the integration's tools,
   *             whatever the model asks for. Left out, the chat's stored scopes
   *             apply.
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
   *             False prompts the model with just this
   *             message instead of the stored transcript — the viewer's
   *             "Include chat history in requests" setting. Advisory: it can
   *             only remove history, never add it.
   *         ephemeral:
   *           type: boolean
   *           description: |
   *             Start a temporary chat: stored like any other, but never listed
   *             in the history or shared, and deleted a day (by default) after
   *             its last activity. Only the turn that creates the chat decides;
   *             later turns' value is ignored. Advisory: it can only make a
   *             chat temporary, never kept.
   *         voiceMode:
   *           type: boolean
   *           description: |
   *             The message was spoken in voice mode and the answer is read
   *             aloud. The server adds a short voice style instruction after the
   *             app's system prompt, asks for a low thinking level when the
   *             request and the app set none, and marks the stored message as
   *             spoken. Ignored unless the `voiceMode` feature and
   *             `speech.voiceMode.enabled` are on.
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
          throw new ServiceError('INTERNAL_ERROR', 'Failed to load models configuration');
        }
        const model = findByIdCaseInsensitive(models, modelId);
        if (!model) {
          throw new ServiceError('NOT_FOUND', 'Model not found');
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
            throw refusal(
              504,
              `Request to ${model.provider} API timed out after ${DEFAULT_TIMEOUT / 1000} seconds`,
              { code: 'TIMEOUT' }
            );
          }
          // A failing model call is answered by the error middleware with its mapped status.
          throw llmError;
        }
      } catch (error) {
        if (error instanceof ServiceError || isLLMError(error)) throw error;
        logger.error('Error in test chat completion', { component: 'sessionRoutes', error });
        throw error;
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
   *       messages and status updates. The client connects here first, then POSTs a
   *       message to the same URL, and the turn's events stream back over this connection
   *       (or the POST streams them itself when sent with `Accept: text/event-stream`).
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
   *       - in: query
   *         name: resumeRun
   *         required: false
   *         schema:
   *           type: string
   *         description: >-
   *           Re-attach to this running turn. After `stream/connected` the stream
   *           first carries the turn's text and thinking so far (as `step/delta`
   *           frames) and its ledger events after `afterLedgerSeq`, then goes live.
   *       - in: query
   *         name: afterLedgerSeq
   *         required: false
   *         schema:
   *           type: integer
   *           minimum: 0
   *         description: >-
   *           The last ledger `seq` of `resumeRun` the client replayed
   *           (`GET /api/runs/{runId}/events?view=sse`).
   *     responses:
   *       200:
   *         description: SSE stream established successfully
   *         content:
   *           text/event-stream:
   *             schema:
   *               type: string
   *               description: |
   *                 SSE v2 (see docs/streaming-events.md). Every frame is `event: <type>` with a
   *                 JSON envelope `{ v: 2, seq, runId, ts, type, data }`. Each message turn is
   *                 one run: `run/started`, `step/delta`, `tool/started`, `tool/completed`,
   *                 `interaction/raised`, `run/paused`, `stream/error`, `run/ended`.
   *             example: |
   *               event: step/delta
   *               data: {"v":2,"seq":3,"runId":"chat-…","ts":"…","type":"step/delta","data":{"step":1,"kind":"text","content":"Hello"}}
   *
   *               event: run/ended
   *               data: {"v":2,"seq":9,"runId":"chat-…","ts":"…","type":"run/ended","data":{"status":"completed","finishReason":"stop"}}
   *       400:
   *         description: Invalid `resumeRun` or `afterLedgerSeq` (VALIDATION_FAILED, problem+json)
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
        // A project member reads the transcript, never the stream: one
        // registration per chat id, so a second subscriber would divert the
        // owner's output.
        if (!access.ok || access.viaProject)
          throw new ServiceError('NOT_FOUND', 'Chat session not found');

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
            logger.debug('Client disconnected', { component: 'sessionRoutes', chatId });
          }
        });
        // appId is carried on the entry for parity with the previous shape;
        // nothing currently reads it back off the map, but keep it available.
        channel.entry.appId = appId;
        // A client re-attaching to a running turn (`resumeRun`, after replaying
        // its ledger up to `afterLedgerSeq`) gets the turn's partial text and
        // thinking first; live frames wait until then (`writeStreamStart`).
        const { resumeRun, afterLedgerSeq } = req.query;
        let resume = null;
        if (resumeRun && isValidRunId(resumeRun)) {
          channel.entry.held = [];
          try {
            resume = await resumeChatRun({ chatId, runId: resumeRun, afterLedgerSeq });
          } catch (resumeError) {
            logger.warn('Chat stream resume failed', {
              component: 'sessionRoutes',
              chatId,
              runId: resumeRun,
              error: resumeError.message
            });
          }
        }
        writeStreamStart(chatId, channel.entry, resume ? { ...resume, runId: resumeRun } : {});

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
        // A refusal (an unknown chat, say) is the answer, not an SSE failure.
        if (error instanceof ServiceError && !res.headersSent) throw error;
        logger.error('Error establishing SSE connection', { component: 'sessionRoutes', error });
        if (!res.headersSent) {
          throw error;
        }
        emitFailedRun(chatId, { code: 'INTERNAL_ERROR', message: 'Internal server error' });
        res.end();
      }
    }
  );

  /**
   * @swagger
   * /apps/{appId}/chat/{chatId}:
   *   post:
   *     summary: Send a chat message
   *     description: |
   *       Sends a message to the AI chat. The answer streams over the chat's SSE
   *       connection (GET on the same URL), so open that first. This endpoint answers
   *       `{ status: "streaming" }` once the turn has ended. Without an SSE connection
   *       the turn still runs and a kept chat stores its answer, but nothing streams.
   *
   *       **Streaming on the POST.** Send `Accept: text/event-stream` and the turn's
   *       frames come back on this response instead, with no GET needed. Every refusal
   *       before the turn starts (authentication, validation, unknown chat, 409, 428,
   *       503, …) is still answered with its status and `application/problem+json`.
   *       Once the turn starts, the answer is `200 text/event-stream`: `stream/connected`
   *       first, then the same SSE v2 frames as the GET, ending after the turn's
   *       `run/ended` or `run/paused`. A refusal after that point is a `stream/error`
   *       frame with its `code`. Closing the response stops a temporary chat's turn; a
   *       kept chat's turn keeps running and can be followed again on the GET with
   *       `resumeRun`. An `@workflow` mention is still answered with JSON and streams
   *       on the GET.
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
   *       - in: header
   *         name: Accept
   *         required: false
   *         schema:
   *           type: string
   *           example: text/event-stream
   *         description: >-
   *           `text/event-stream` streams the turn on this response; anything else (or
   *           nothing) keeps the JSON answer.
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
   *         description: >-
   *           The turn ran. JSON: its answer was streamed over the chat's SSE connection.
   *           `text/event-stream` (when asked for): the turn's frames.
   *         content:
   *           text/event-stream:
   *             schema:
   *               type: string
   *               description: >-
   *                 SSE v2 frames (see docs/streaming-events.md), starting with `stream/connected`.
   *             example: |
   *               event: stream/connected
   *               data: {"v":2,"seq":1,"runId":"550e8400-…","ts":"…","type":"stream/connected","data":{"runId":"550e8400-…","lastSeq":0,"protocol":2}}
   *
   *               event: step/delta
   *               id: chat-…:3
   *               data: {"v":2,"seq":3,"runId":"chat-…","rseq":3,"ts":"…","type":"step/delta","data":{"step":0,"kind":"text","content":"Paris"}}
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
   *           `CLIENT_HISTORY_NOT_ALLOWED` when more than one message was
   *           posted — send only the new message.
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
   *       503:
   *         description: >-
   *           `CHAT_STORAGE_UNAVAILABLE` — the storage provider did not come up,
   *           so the chat cannot be stored and therefore not answered.
   */
  app.post(
    buildServerPath('/api/apps/:appId/chat/:chatId'),
    chatAuthRequired,
    aiAcknowledgementRequired,
    validate(chatPostSchema),
    async (req, res) => {
      const { chatId } = req.params;
      // A client that accepts `text/event-stream` gets the turn's frames on this
      // response instead of over its GET stream; without the header the answer
      // is the JSON it always was. The stream is opened at the commit point of
      // the turn: every refusal before it is problem+json either way, and one
      // after it is a `stream/error` frame.
      const sink = wantsEventStream(req)
        ? { open: turn => openChatPostStream({ req, res, ...turn }) }
        : { answer: outcome => answerTurnAsJson(res, chatId, outcome) };
      let prepared = null;
      try {
        prepared = await prepareTurn(turnRequestOf(req), {
          user: req.user,
          getLocalizedError,
          settleClarifications: settleChatClarifications
        });
        if (prepared.refusal) throw refusalError(prepared.refusal);
        // An `@workflow` mention: the workflow took the message and runs on the GET stream.
        if (prepared.answer) return res.json(prepared.answer);

        const outcome = await runPreparedTurn(prepared.turn, {
          sink,
          chatService,
          getLocalizedError,
          timeoutMs: DEFAULT_TIMEOUT
        });
        // Refused when it was about to run, with no stream to say so: answered
        // here, after the turn let go of the chat.
        if (outcome.status === 'refused' && !outcome.told) throw refusalError(outcome.refusal);
      } catch (error) {
        const expected = error instanceof ServiceError || isLLMError(error);
        // Only an unexpected failure is logged here.
        if (!expected) logger.error('Error in app chat', { component: 'sessionRoutes', error });
        // A refusal and a failing model call are answered as they are.
        throw error;
      } finally {
        // An audit entry the turn wrote stands for this request (`auditLogger`).
        if (prepared?.turn?.audited()) req._auditLogged = true;
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
      if (!access.ok) throw new ServiceError('NOT_FOUND', 'Chat session not found');

      // A live SSE client used to be the proof that there was something to
      // stop. It no longer is: a persisted turn keeps running after its client
      // is gone, and that is exactly the turn a user needs to be able to stop.
      // Anything in flight for this chat, anywhere in the cluster, qualifies.
      if (!hasChatClient(chatId) && !isChatDurable(chatId) && !hasActiveChatRequest(chatId)) {
        throw new ServiceError('NOT_FOUND', 'Chat session not found');
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
      // Who stopped it and from where, recorded wherever the turn ends up
      // written down. The surface is the client's own label for the control
      // that sent this; anything but a short slug is dropped.
      const requestedSource = typeof req.body?.source === 'string' ? req.body.source : '';
      const cause = await userAbortCause('user_stop', req.user, {
        mode:
          access.chat?.identityMode ||
          (boundRunId && runLog.getRunMeta(boundRunId)?.identityMode) ||
          runLog.identityMode(),
        ownerId: access.chat?.ownerId,
        via: 'POST /api/apps/:appId/chat/:chatId/stop',
        ...(/^[a-z][a-z0-9-]{0,31}$/.test(requestedSource) ? { source: requestedSource } : {}),
        related: boundRunId ? { runId: boundRunId } : undefined
      });
      logger.info('Chat stop requested', {
        component: 'sessionRoutes',
        chatId,
        ip: req.ip,
        userAgent: String(req.headers?.['user-agent'] || '').slice(0, 200),
        ...describeCause(cause)
      });
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
      const aborted = abortChatRequest(chatId, cause);

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
        throw new ServiceError('NOT_FOUND', 'Chat session not found');
      }
      logger.info('Chat stream stopped', { component: 'sessionRoutes', chatId });
      return res.status(204).end();
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
      // A project member reads the transcript, not the live session state.
      if (!access.ok || access.viaProject)
        throw new ServiceError('NOT_FOUND', 'Chat session not found');
      if (hasChatClient(chatId)) {
        // lastActivity lives with the response object, so it is only readable
        // on the worker holding the stream. Rather than a bus round trip for a
        // diagnostic field, report null when the stream is elsewhere —
        // `active` and `processing` are the parts callers branch on.
        return res.status(200).json({
          active: true,
          lastActivity:
            clients.get(chatId)?.lastActivity ?? postStreams.get(chatId)?.lastActivity ?? null,
          processing: hasActiveChatRequest(chatId)
        });
      }
      return res.status(200).json({ active: false });
    }
  );
}
