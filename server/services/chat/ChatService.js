import RequestBuilder from './RequestBuilder.js';
import NonStreamingHandler from './NonStreamingHandler.js';
import StreamingHandler from './StreamingHandler.js';
import ToolExecutor from './ToolExecutor.js';
import ErrorHandler from '../../utils/ErrorHandler.js';
import { processMessageTemplates } from '../../serverHelpers.js';
import logger from '../../utils/logger.js';
import { v4 as uuidv4 } from 'uuid';
import { InMemorySink } from './streamSink/InMemorySink.js';

class ChatService {
  constructor(options = {}) {
    this.requestBuilder = options.requestBuilder || new RequestBuilder();
    this.nonStreamingHandler = options.nonStreamingHandler || new NonStreamingHandler();
    this.streamingHandler = options.streamingHandler || new StreamingHandler();
    this.toolExecutor = options.toolExecutor || new ToolExecutor();
    this.errorHandler = options.errorHandler || new ErrorHandler();
  }

  async prepareChatRequest(params) {
    const {
      appId,
      modelId,
      messages,
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
      websearchEnabled,
      imageAspectRatio,
      imageQuality,
      requestedSkill,
      documentIds,
      res,
      clientRes,
      user,
      chatId
    } = params;

    return await this.requestBuilder.prepareChatRequest({
      appId,
      modelId,
      messages,
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
      websearchEnabled,
      imageAspectRatio,
      imageQuality,
      requestedSkill,
      documentIds,
      processMessageTemplates,
      res,
      clientRes,
      user,
      chatId
    });
  }

  async processNonStreamingChat(params) {
    const {
      request,
      res,
      buildLogData,
      messageId,
      model,
      llmMessages,
      DEFAULT_TIMEOUT,
      getLocalizedError,
      clientLanguage
    } = params;

    return await this.nonStreamingHandler.executeNonStreamingResponse({
      request,
      res,
      buildLogData,
      messageId,
      model,
      llmMessages,
      DEFAULT_TIMEOUT,
      getLocalizedError,
      clientLanguage
    });
  }

  async processStreamingChat(params) {
    const {
      request,
      chatId,
      clientRes,
      buildLogData,
      model,
      llmMessages,
      DEFAULT_TIMEOUT,
      getLocalizedError,
      clientLanguage
    } = params;

    return await this.streamingHandler.executeStreamingResponse({
      request,
      chatId,
      clientRes,
      buildLogData,
      model,
      llmMessages,
      DEFAULT_TIMEOUT,
      getLocalizedError,
      clientLanguage
    });
  }

  async processChatWithTools(params) {
    const { prep, chatId, buildLogData, DEFAULT_TIMEOUT, getLocalizedError, clientLanguage, user } =
      params;

    return await this.toolExecutor.processChatWithTools({
      prep,
      chatId,
      buildLogData,
      DEFAULT_TIMEOUT,
      getLocalizedError,
      clientLanguage,
      user
    });
  }

  async processChat(params) {
    const {
      appId,
      modelId,
      messages,
      temperature,
      style,
      outputFormat,
      language,
      useMaxTokens,
      bypassAppPrompts,
      res,
      clientRes,
      chatId,
      buildLogData,
      messageId,
      DEFAULT_TIMEOUT,
      getLocalizedError,
      clientLanguage,
      hasTools = false,
      user
    } = params;

    try {
      const prepResult = await this.prepareChatRequest({
        appId,
        modelId,
        messages,
        temperature,
        style,
        outputFormat,
        language,
        useMaxTokens,
        bypassAppPrompts,
        res,
        clientRes,
        user,
        chatId
      });

      if (!prepResult.success) {
        if (res && !clientRes) {
          return res.status(400).json(this.errorHandler.formatErrorResponse(prepResult.error));
        }
        return { success: false, error: prepResult.error };
      }

      const { model, llmMessages, request, tools } = prepResult.data;

      if (!clientRes) {
        return await this.processNonStreamingChat({
          request,
          res,
          buildLogData,
          messageId,
          model,
          llmMessages,
          DEFAULT_TIMEOUT
        });
      }

      if (hasTools && tools && tools.length > 0) {
        return await this.processChatWithTools({
          prep: prepResult.data,
          chatId,
          buildLogData,
          DEFAULT_TIMEOUT,
          getLocalizedError,
          clientLanguage,
          user
        });
      }

      return await this.processStreamingChat({
        request,
        chatId,
        clientRes,
        buildLogData,
        model,
        llmMessages,
        DEFAULT_TIMEOUT,
        getLocalizedError,
        clientLanguage
      });
    } catch (error) {
      logger.error('Error in processChat', { component: 'ChatService', error });

      const errorResponse = this.errorHandler.formatErrorResponse(error);
      if (res && !clientRes) {
        return res.status(500).json(errorResponse);
      }

      return { success: false, error: errorResponse };
    }
  }

  /**
   * Invoke an iHub App synchronously from a non-HTTP context (used by the
   * App-as-tool gateway for agent runs). The full chat pipeline runs against
   * an in-memory sink that captures the final assistant message, tool calls,
   * citations, and usage.
   *
   * @param {Object} opts
   * @param {string} opts.appId
   * @param {Object} opts.user           agent principal (must include groups)
   * @param {Array<Object>} opts.messages chat messages [{role, content}, ...]
   * @param {Object} [opts.variables]    user-input variables for the app
   * @param {string} [opts.modelOverride]
   * @param {AbortSignal} [opts.abortSignal]
   * @param {string} [opts.runId]        used to namespace the synthetic chatId
   * @returns {Promise<Object>} `{ status, finalMessage, toolCalls, citations, usage, ... }`
   */
  async invokeAppInternal({
    appId,
    user,
    messages = [],
    variables = {},
    modelOverride,
    abortSignal: _abortSignal,
    runId,
    language = 'en'
  }) {
    if (!appId) throw new Error('appId is required');
    const chatId = `agent:${runId || 'no-run'}:${uuidv4().slice(0, 8)}`;
    const sink = new InMemorySink({ chatId });
    sink.startListening();

    const buildLogData = () => ({
      appId,
      user: user || null,
      userSessionId: chatId,
      sessionId: chatId
    });

    try {
      const prepResult = await this.prepareChatRequest({
        appId,
        modelId: modelOverride,
        messages,
        language,
        // No streaming: pass `res` (the sink) and no `clientRes`.
        res: sink,
        clientRes: null,
        user,
        chatId,
        variables
      });
      if (!prepResult.success) {
        sink.stopListening();
        return {
          status: 'error',
          error: prepResult.error,
          finalMessage: null,
          toolCalls: []
        };
      }
      const { model, llmMessages, request, tools } = prepResult.data;

      const hasTools = Array.isArray(tools) && tools.length > 0;
      if (hasTools) {
        // Run the tool-aware pipeline. Output flows through actionTracker; the
        // sink subscription assembles the final message.
        await this.processChatWithTools({
          prep: prepResult.data,
          chatId,
          buildLogData,
          DEFAULT_TIMEOUT: 120_000,
          getLocalizedError: async (key, _vars, _lang) => key,
          clientLanguage: language,
          user
        });
      } else {
        await this.processNonStreamingChat({
          request,
          res: sink,
          buildLogData,
          messageId: chatId,
          model,
          llmMessages,
          DEFAULT_TIMEOUT: 120_000,
          getLocalizedError: async (key, _vars, _lang) => key,
          clientLanguage: language
        });
      }

      const result = await sink.getResult({
        timeoutMs: 180_000
      });
      return result;
    } catch (error) {
      sink.stopListening();
      logger.error('invokeAppInternal failed', {
        component: 'ChatService',
        appId,
        runId,
        error: error.message
      });
      return {
        status: 'error',
        error: { message: error.message },
        finalMessage: null,
        toolCalls: []
      };
    }
  }
}

export default ChatService;
