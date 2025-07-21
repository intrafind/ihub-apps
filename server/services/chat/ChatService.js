import RequestBuilder from './RequestBuilder.js';
import NonStreamingHandler from './NonStreamingHandler.js';
import StreamingHandler from './StreamingHandler.js';
import ToolExecutor from './ToolExecutor.js';
import ErrorHandler from '../../utils/ErrorHandler.js';
import { processMessageTemplates } from '../../serverHelpers.js';

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
      hasTools = false
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
        clientRes
      });

      if (!prepResult.success) {
        if (res && !clientRes) {
          return res.status(400).json(this.errorHandler.formatErrorResponse(prepResult.error));
        }
        return { success: false, error: prepResult.error };
      }

      const {
        app,
        model,
        llmMessages,
        request,
        tools,
        apiKey,
        temperature: finalTemp,
        maxTokens
      } = prepResult.data;

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
          clientLanguage
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
      console.error('Error in ChatService.processChat:', error);

      const errorResponse = this.errorHandler.formatErrorResponse(error);
      if (res && !clientRes) {
        return res.status(500).json(errorResponse);
      }

      return { success: false, error: errorResponse };
    }
  }
}

export default ChatService;
