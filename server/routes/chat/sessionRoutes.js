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
  closeChatClient,
  hasActiveChatRequest,
  hasChatClient
} from '../../sse.js';
import { RunStreamEmitter, currentSeq } from '../../services/loop/RunStream.js';
import { newRunId } from '../../services/loop/RunLog.js';
import { SSE_V2_EVENTS } from '../../../shared/runEvents.js';
import { createSseChannel } from '../../utils/sseChannel.js';
import {
  authRequired,
  chatAuthRequired,
  modelAccessRequired
} from '../../middleware/authRequired.js';

import ChatService from '../../services/chat/ChatService.js';
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
            // completion, billing tokens nobody will read.
            abortChatRequest(chatId);
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
   * Run one chat turn through the shared chat service. With an SSE client the
   * turn streams over the chat channel and this resolves once it ended; without
   * one the answer is written to the HTTP response.
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
    user
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
      user
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
      try {
        const { appId, chatId } = req.params;
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
          documentIds
        } = req.body;
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

            // Build chat history from all prior messages (excluding the last)
            const chatHistory = messages.slice(0, -1).map(m => ({
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
                .catch(error => {
                  logger.error('Error running @mention workflow', {
                    component: 'sessionRoutes',
                    error
                  });
                  failLaunch(`Workflow execution failed: ${error.message}`);
                });

              // Return immediately — the SSE channel delivers all progress + final output
              return res.json({ status: 'streaming', chatId });
            } catch (error) {
              logger.error('Error loading workflow runner', { component: 'sessionRoutes', error });
              failLaunch(`Workflow execution failed: ${error.message}`);
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

        if (!streamOpen) {
          logger.info('No active SSE connection, creating response without streaming', {
            component: 'sessionRoutes',
            chatId
          });
          const prep = await chatService.prepareChatRequest({
            appId,
            modelId,
            messages,
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

          return processChatRequest({
            prep: prep.data,
            buildLogData,
            messageId,
            streaming: false,
            res,
            chatId,
            DEFAULT_TIMEOUT,
            getLocalizedError,
            clientLanguage,
            user: req.user
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
            messages,
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
            user: req.user
          });

          return res.json({ status: 'streaming', chatId });
        }
      } catch (error) {
        logger.error('Error in app chat', { component: 'sessionRoutes', error });
        return sendInternalError(res, error, 'app chat');
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
      if (hasChatClient(chatId)) {
        // Each of the three teardown steps targets state that may live on a
        // different worker than this POST landed on: the LLM call, the workflow
        // execution and the SSE stream are registered independently, so each
        // helper resolves its own owner and relays if it is not this process.
        abortChatRequest(chatId);

        // Also cancel any running workflow execution for this chatId
        await cancelChatWorkflow(chatId);

        // Note the awaits above: cancelling the workflow yields the event loop,
        // and the SSE connection can close in that gap (its req.on('close')
        // handler deletes the entry from `clients`). The top-of-handler check is
        // therefore stale here, which is why the close goes through
        // `closeChatClient` — it re-reads the entry and no-ops when it is gone,
        // instead of dereferencing undefined. An unguarded
        // `client.response.end()` throws a TypeError that crashes the whole
        // process as an unhandled rejection on Node >= 15.
        closeChatClient(chatId);
        logger.info('Chat stream stopped', { component: 'sessionRoutes', chatId });
        return res.status(200).json({ success: true, message: 'Chat stream stopped' });
      }
      return sendNotFound(res, 'Chat session');
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
