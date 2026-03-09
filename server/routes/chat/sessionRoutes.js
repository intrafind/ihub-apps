import configCache from '../../configCache.js';
import { createCompletionRequest } from '../../adapters/index.js';
import { getErrorDetails, logInteraction, trackSession } from '../../utils.js';
import { clients, activeRequests } from '../../sse.js';
import { actionTracker } from '../../actionTracker.js';
import { throttledFetch } from '../../requestThrottler.js';
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

export default function registerSessionRoutes(
  app,
  { verifyApiKey, getLocalizedError, DEFAULT_TIMEOUT }
) {
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
   *         useMaxTokens:
   *           type: boolean
   *           description: Whether to use the model's maximum token limit
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
   *                 response:
   *                   type: string
   *                   description: Model's response to the test message
   *       404:
   *         description: Model not found
   *       401:
   *         description: Authentication or authorization required
   *       500:
   *         description: Internal server error
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
          return res.status(500).json({ error: 'Failed to load models configuration' });
        }
        const model = models.find(m => m.id === modelId);
        if (!model) {
          return res.status(404).json({ error: 'Model not found' });
        }
        const defaultLang = configCache.getPlatform()?.defaultLanguage || 'en';
        const apiKey = await verifyApiKey(
          model,
          res,
          null,
          req.headers['accept-language']?.split(',')[0] || defaultLang
        );
        if (!apiKey) {
          return res.status(500).json({
            error: `API key not found for model: ${model.id} (${model.provider})`,
            provider: model.provider
          });
        }
        const request = createCompletionRequest(model, messages, apiKey, {
          stream: false,
          tools: []
        });
        let timeoutId;
        const timeoutPromise = new Promise((_, reject) => {
          timeoutId = setTimeout(
            () => reject(new Error(`Request timed out after ${DEFAULT_TIMEOUT / 1000} seconds`)),
            DEFAULT_TIMEOUT
          );
        });
        try {
          const responsePromise = throttledFetch(model.id, request.url, {
            method: 'POST',
            headers: request.headers,
            body: JSON.stringify(request.body)
          });
          const llmResponse = await Promise.race([responsePromise, timeoutPromise]);
          clearTimeout(timeoutId);
          if (!llmResponse.ok) {
            const errorBody = await llmResponse.text();
            logger.error(`LLM API Error (${llmResponse.status}): ${errorBody}`);
            return res.status(llmResponse.status).json({
              error: `LLM API request failed with status ${llmResponse.status}`,
              details: errorBody
            });
          }
          const responseData = await llmResponse.json();
          return res.json(responseData);
        } catch (fetchError) {
          clearTimeout(timeoutId);
          if (fetchError.message.includes('timed out')) {
            return res.status(504).json({
              error: 'Request timed out',
              message: `Request to ${model.provider} API timed out after ${DEFAULT_TIMEOUT / 1000} seconds`
            });
          }
          const errorDetails = getErrorDetails(fetchError, model);
          return res.status(500).json({
            error: errorDetails.message,
            code: errorDetails.code,
            modelId: model.id,
            provider: model.provider,
            recommendation: errorDetails.recommendation,
            details: fetchError.message
          });
        }
      } catch (error) {
        logger.error('Error in test chat completion:', error);
        res.status(500).json({ error: 'Internal server error', message: error.message });
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
   *                 Newline-delimited Server-Sent Events. Each event is a JSON object.
   *                 Common event types include `token`, `done`, `error`, and `action`.
   *             example: |
   *               data: {"type":"token","content":"Hello"}
   *
   *               data: {"type":"done"}
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
      try {
        const { appId, chatId } = req.params;
        res.setHeader('Content-Type', 'text/event-stream');
        res.setHeader('Cache-Control', 'no-cache');
        res.setHeader('Connection', 'keep-alive');
        clients.set(chatId, { response: res, lastActivity: new Date(), appId });
        actionTracker.trackConnected(chatId);

        req.on('close', () => {
          if (clients.has(chatId)) {
            if (activeRequests.has(chatId)) {
              try {
                const controller = activeRequests.get(chatId);
                controller.abort();
                activeRequests.delete(chatId);
                logger.info(`Aborted request for chat ID: ${chatId}`);
              } catch (e) {
                logger.error(`Error aborting request for chat ID: ${chatId}`, e);
              }
            }
            clients.delete(chatId);
            logger.info(`Client disconnected: ${chatId}`);
          }
        });
      } catch (error) {
        logger.error('Error establishing SSE connection:', error);
        if (!res.headersSent) {
          return res.status(500).json({ error: 'Internal server error' });
        }
        actionTracker.trackError(chatId, { message: 'Internal server error' });
        res.end();
      }
    }
  );

  // Extract common chat processing logic to reduce duplication
  async function processChatRequest({
    prep,
    buildLogData,
    messageId,
    streaming,
    res,
    clientRes,
    chatId,
    DEFAULT_TIMEOUT,
    getLocalizedError,
    clientLanguage,
    user
  }) {
    const {} = prep;

    // Log the request
    const requestLog = buildLogData(streaming);
    if (!streaming) {
      requestLog.options.useMaxTokens = requestLog.options.useMaxTokens || false;
    }
    await logInteraction('chat_request', requestLog);

    // Handle requests with tools
    if (prep.tools && prep.tools.length > 0) {
      if (streaming) {
        logger.info(`Processing chat with tools for chat ID: ${chatId}`);
        return await chatService.processChatWithTools({
          prep,
          clientRes,
          chatId,
          buildLogData,
          DEFAULT_TIMEOUT,
          getLocalizedError,
          clientLanguage,
          user
        });
      } else {
        return await chatService.processChatWithTools({
          prep,
          res,
          buildLogData,
          DEFAULT_TIMEOUT,
          getLocalizedError,
          clientLanguage,
          user
        });
      }
    }

    // Handle standard requests without tools
    if (streaming) {
      return await chatService.processStreamingChat({
        request: prep.request,
        chatId,
        clientRes,
        buildLogData,
        model: prep.model,
        llmMessages: prep.llmMessages,
        DEFAULT_TIMEOUT,
        getLocalizedError,
        clientLanguage
      });
    } else {
      return await chatService.processNonStreamingChat({
        request: prep.request,
        res,
        buildLogData,
        messageId,
        model: prep.model,
        llmMessages: prep.llmMessages,
        DEFAULT_TIMEOUT,
        getLocalizedError,
        clientLanguage
      });
    }
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
          useMaxTokens,
          bypassAppPrompts,
          thinkingEnabled,
          thinkingBudget,
          thinkingThoughts,
          enabledTools,
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
            logger.info(`Using client-provided messageId: ${messageId}`);
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
        logger.info(`Processing chat with language: ${clientLanguage}`);
        if (!messages || !Array.isArray(messages)) {
          const errorMessage = await getLocalizedError('messagesRequired', {}, clientLanguage);
          return res.status(400).json({ error: errorMessage });
        }
        trackSession(chatId, { appId, userSessionId, userAgent: req.headers['user-agent'] });
        actionTracker.trackSessionStart(chatId, {
          sessionId: chatId,
          timestamp: new Date().toISOString()
        });

        // --- @mention workflow detection ---
        // Check if the last user message contains an @workflow-name mention
        const lastUserMsg = messages[messages.length - 1];
        const lastUserContent = typeof lastUserMsg?.content === 'string' ? lastUserMsg.content : '';
        const mentionMatch = lastUserContent.match(/@([\w.-]+)/);

        if (mentionMatch) {
          const mentionedId = mentionMatch[1];
          const mentionedWorkflow = configCache.getWorkflowById(mentionedId);

          if (
            mentionedWorkflow &&
            mentionedWorkflow.enabled !== false &&
            mentionedWorkflow.chatIntegration?.enabled
          ) {
            logger.info({
              component: 'sessionRoutes',
              message: '@mention workflow triggered',
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

            try {
              const workflowRunnerMod = await import('../../tools/workflowRunner.js');

              // Fire-and-forget: start workflow but don't await completion.
              // The workflowRunner bridge streams step events and final output via SSE.
              workflowRunnerMod
                .default({
                  workflowId: mentionedId,
                  chatId,
                  user: req.user,
                  input: strippedInput,
                  modelId,
                  _chatHistory: chatHistory.length > 0 ? chatHistory : undefined,
                  _fileData: fileData || imageData || undefined,
                  language: clientLanguage
                })
                .catch(error => {
                  logger.error('Error running @mention workflow:', error);
                  actionTracker.trackError(chatId, {
                    message: `Workflow execution failed: ${error.message}`
                  });
                });

              // Return immediately — the SSE channel delivers all progress + final output
              return res.json({ status: 'streaming', chatId });
            } catch (error) {
              logger.error('Error loading workflow runner:', error);
              actionTracker.trackError(chatId, {
                message: `Workflow execution failed: ${error.message}`
              });
              return res.json({ status: 'error', message: error.message });
            }
          }
        }
        // --- end @mention detection ---

        if (!clients.has(chatId)) {
          logger.info(
            `No active SSE connection for chat ID: ${chatId}. Creating response without streaming.`
          );
          const prep = await chatService.prepareChatRequest({
            appId,
            modelId,
            messages,
            temperature,
            style,
            outputFormat,
            language: clientLanguage,
            useMaxTokens,
            bypassAppPrompts,
            thinkingEnabled,
            thinkingBudget,
            thinkingThoughts,
            enabledTools,
            imageAspectRatio,
            imageQuality,
            requestedSkill,
            documentIds,
            res,
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
            clientRes: null,
            chatId: null,
            DEFAULT_TIMEOUT,
            getLocalizedError,
            clientLanguage,
            user: req.user
          });
        } else {
          const clientRes = clients.get(chatId).response;
          clients.set(chatId, { ...clients.get(chatId), lastActivity: new Date() });
          const prep = await chatService.prepareChatRequest({
            appId,
            modelId,
            messages,
            temperature,
            style,
            outputFormat,
            language: clientLanguage,
            useMaxTokens,
            bypassAppPrompts,
            thinkingEnabled,
            thinkingBudget,
            thinkingThoughts,
            enabledTools,
            imageAspectRatio,
            imageQuality,
            requestedSkill,
            documentIds,
            clientRes,
            user: req.user,
            chatId
          });
          if (!prep.success) {
            const errMsg = await getLocalizedError(
              prep.error.code || 'internalError',
              {},
              clientLanguage
            );
            actionTracker.trackError(chatId, { message: errMsg, code: prep.error.code });
            return res.json({ status: 'error', message: errMsg, code: prep.error.code });
          }
          model = prep.data.model;
          llmMessages = prep.data.llmMessages;

          // Emit skill.activation SSE event when a skill was pre-activated via slash command
          if (requestedSkill) {
            const { data: skills = [] } = configCache.getSkills();
            const skillMeta = skills.find(s => s.name === requestedSkill);
            actionTracker.trackSkillActivation(chatId, {
              skillName: requestedSkill,
              description: skillMeta?.description || ''
            });
          }

          await processChatRequest({
            prep: prep.data,
            buildLogData,
            messageId,
            streaming: true,
            res: null,
            clientRes,
            chatId,
            DEFAULT_TIMEOUT,
            getLocalizedError,
            clientLanguage,
            user: req.user
          });

          return res.json({ status: 'streaming', chatId });
        }
      } catch (error) {
        logger.error('Error in app chat:', error);
        return res.status(500).json({ error: 'Internal server error', message: error.message });
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
      if (clients.has(chatId)) {
        if (activeRequests.has(chatId)) {
          try {
            const controller = activeRequests.get(chatId);
            controller.abort();
            activeRequests.delete(chatId);
            logger.info(`Aborted request for chat ID: ${chatId}`);
          } catch (e) {
            logger.error(`Error aborting request for chat ID: ${chatId}`, e);
          }
        }

        // Also cancel any running workflow execution for this chatId
        const { activeWorkflowExecutions } = await import('../../tools/workflowRunner.js');
        const workflowExec = activeWorkflowExecutions.get(chatId);
        if (workflowExec) {
          try {
            await workflowExec.engine.cancel(workflowExec.executionId, 'user_cancelled');
            activeWorkflowExecutions.delete(chatId);
            logger.info(`Cancelled workflow ${workflowExec.executionId} for chat ID: ${chatId}`);
          } catch (e) {
            logger.error(`Error cancelling workflow for chat ID: ${chatId}`, e);
          }
        }

        const client = clients.get(chatId);
        actionTracker.trackDisconnected(chatId, { message: 'Chat stream stopped by client' });
        client.response.end();
        clients.delete(chatId);
        logger.info(`Chat stream stopped for chat ID: ${chatId}`);
        return res.status(200).json({ success: true, message: 'Chat stream stopped' });
      }
      return res.status(404).json({ success: false, message: 'Chat session not found' });
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
    if (clients.has(chatId)) {
      return res.status(200).json({
        active: true,
        lastActivity: clients.get(chatId).lastActivity,
        processing: activeRequests.has(chatId)
      });
    }
    return res.status(200).json({ active: false });
  });
}
