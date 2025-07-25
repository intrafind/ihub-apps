import RequestBuilder from './RequestBuilder.js';
import NonStreamingHandler from './NonStreamingHandler.js';
import StreamingHandler from './StreamingHandler.js';
import ToolExecutor from './ToolExecutor.js';
import ErrorHandler from '../../utils/ErrorHandler.js';
import { processMessageTemplates } from '../../serverHelpers.js';
import { ContextManager } from '../ContextManager.js';
import { TokenCounter } from '../../utils/TokenCounter.js';
import { recordContextUsage } from '../../usageTracker.js';

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
      clientRes
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
      clientRes
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

      // Context window validation and optimization
      try {
        const contextValidation = await this.validateAndOptimizeContext({
          messages: llmMessages,
          model,
          appId,
          systemPrompt: request.system || '',
          userId: buildLogData?.userId || 'unknown'
        });

        if (!contextValidation.success) {
          console.warn(`[CONTEXT] Validation failed for ${appId}:`, contextValidation.error);

          if (res && !clientRes) {
            return res.status(400).json(
              this.errorHandler.formatErrorResponse({
                message: contextValidation.error,
                code: 'CONTEXT_VALIDATION_FAILED',
                details: contextValidation.details
              })
            );
          }
          return {
            success: false,
            error: {
              message: contextValidation.error,
              code: 'CONTEXT_VALIDATION_FAILED',
              details: contextValidation.details
            }
          };
        }

        // Update messages if optimization was applied
        if (contextValidation.optimizedMessages) {
          prepResult.data.llmMessages = contextValidation.optimizedMessages;
          console.log(
            `[CONTEXT] Applied optimization for ${appId}: ${contextValidation.optimization?.strategies?.join(', ') || 'unknown'}`
          );
        }

        // Record context usage for monitoring
        await recordContextUsage({
          userId: buildLogData?.userId || 'unknown',
          appId,
          modelId,
          totalTokens: contextValidation.validation.totalTokens,
          contextLimit: contextValidation.validation.contextLimit,
          usagePercentage: contextValidation.validation.usagePercentage,
          breakdown: contextValidation.validation.breakdown,
          optimization: contextValidation.optimization,
          exceedsLimit: contextValidation.validation.exceedsLimit
        });

        // Add context information to response if available
        if (clientRes && contextValidation.contextInfo) {
          clientRes.write(
            `data: ${JSON.stringify({
              type: 'contextInfo',
              data: contextValidation.contextInfo
            })}\n\n`
          );
        }
      } catch (contextError) {
        console.error('[CONTEXT] Context validation error:', contextError);
        // Continue with request but log the error
      }

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

  /**
   * Validate context window and apply optimization if needed
   * @param {Object} params - Context validation parameters
   * @returns {Object} Validation and optimization result
   */
  async validateAndOptimizeContext({ messages, model, appId, systemPrompt, userId }) {
    try {
      // Create model config for context validation
      const modelConfig = {
        contextLimit: model.tokenLimit || 4096,
        maxOutputTokens: model.maxOutputTokens || 4096,
        tokenFamily: this.getModelTokenFamily(model),
        safetyMargin: 0.9,
        id: model.id
      };

      // Validate context window
      const validation = await ContextManager.validateContextWindow(
        messages,
        systemPrompt,
        modelConfig
      );

      // If context exceeds limit, return error
      if (validation.exceedsLimit) {
        return {
          success: false,
          error: `Context window limit exceeded: ${validation.totalTokens} tokens exceed limit of ${validation.effectiveLimit}`,
          details: {
            totalTokens: validation.totalTokens,
            contextLimit: validation.contextLimit,
            usagePercentage: validation.usagePercentage,
            breakdown: validation.breakdown,
            recommendations: validation.recommendations
          },
          validation
        };
      }

      let optimization = null;
      let optimizedMessages = null;

      // Apply optimization if usage is high (>80%) or recommended
      if (validation.needsOptimization || validation.canOptimize?.worthwhile) {
        console.log(
          `[CONTEXT] Applying context optimization for ${appId} - ${validation.usagePercentage}% usage`
        );

        optimization = await ContextManager.optimizeContext(messages, modelConfig, systemPrompt);

        if (optimization.applied) {
          optimizedMessages = optimization.messages;
          console.log(
            `[CONTEXT] Optimization successful: ${optimization.tokensSaved} tokens saved (${Math.round((1 - optimization.compressionRatio) * 100)}% reduction)`
          );
        }
      }

      // Create context info for user notification
      const contextInfo = ContextManager.createUserNotification(validation, optimization);

      return {
        success: true,
        validation,
        optimization,
        optimizedMessages,
        contextInfo
      };
    } catch (error) {
      console.error('[CONTEXT] Context validation/optimization error:', error);
      return {
        success: false,
        error: `Context validation failed: ${error.message}`,
        details: { originalError: error.message }
      };
    }
  }

  /**
   * Determine token family based on model information
   * @param {Object} model - Model configuration
   * @returns {string} Token family identifier
   */
  getModelTokenFamily(model) {
    const modelId = model.modelId || model.id || '';
    const provider = model.provider || '';

    // Determine token family based on model ID and provider
    if (provider === 'openai' || modelId.includes('gpt')) {
      if (modelId.includes('gpt-4')) return 'gpt-4';
      if (modelId.includes('gpt-3.5')) return 'gpt-3.5';
      return 'gpt-4'; // Default for OpenAI
    }

    if (provider === 'anthropic' || modelId.includes('claude')) {
      return 'claude';
    }

    if (provider === 'google' || modelId.includes('gemini')) {
      return 'gemini';
    }

    if (provider === 'mistral' || modelId.includes('mistral') || modelId.includes('mixtral')) {
      return 'mistral';
    }

    // Default fallback
    return 'gpt-4';
  }
}

export default ChatService;
