import { createCompletionRequest } from '../../adapters/index.js';
import { logInteraction, getErrorDetails } from '../../utils.js';
import { runTool } from '../../toolLoader.js';
import { normalizeToolName } from '../../adapters/toolCalling/index.js';
import { activeRequests } from '../../sse.js';
import { actionTracker } from '../../actionTracker.js';
import ErrorHandler from '../../utils/ErrorHandler.js';
import StreamResponseCollector from './utils/StreamResponseCollector.js';
import { logLLMRequest, executeLLMRequest } from './utils/llmRequestExecutor.js';
import RequestLifecycle from './utils/requestLifecycle.js';
import { emitImages, emitThinking, emitGroundingMetadata } from './utils/resultEmitters.js';
import logger from '../../utils/logger.js';
import { MAX_CLARIFICATIONS_PER_CONVERSATION, validateAskUserParams } from '../../tools/askUser.js';

/**
 * Maximum number of clarification requests allowed per conversation
 * @constant {number}
 */
const MAX_CLARIFICATIONS = MAX_CLARIFICATIONS_PER_CONVERSATION;

class ToolExecutor {
  constructor() {
    this.errorHandler = new ErrorHandler();
    /**
     * Map to track clarification counts per conversation
     * @type {Map<string, number>}
     */
    this.clarificationCounts = new Map();
  }

  /**
   * Get the current clarification count for a conversation
   * @param {string} chatId - The conversation/chat ID
   * @returns {number} Current count of clarifications
   */
  getClarificationCount(chatId) {
    return this.clarificationCounts.get(chatId) || 0;
  }

  /**
   * Increment the clarification count for a conversation
   * @param {string} chatId - The conversation/chat ID
   * @returns {number} New count after increment
   */
  incrementClarificationCount(chatId) {
    const current = this.getClarificationCount(chatId);
    const newCount = current + 1;
    this.clarificationCounts.set(chatId, newCount);
    return newCount;
  }

  /**
   * Reset the clarification count for a conversation
   * Called when a conversation ends or is explicitly reset
   * @param {string} chatId - The conversation/chat ID
   */
  resetClarificationCount(chatId) {
    this.clarificationCounts.delete(chatId);
  }

  /**
   * Check if a tool is the ask_user clarification tool
   * @param {string} toolId - Tool identifier
   * @param {Array} _tools - Available tools array (unused, for interface consistency)
   * @returns {boolean} True if this is the ask_user tool
   */
  isAskUserTool(toolId, _tools) {
    // Normalize and check the tool ID
    const normalizedToolId = normalizeToolName(toolId);
    return normalizedToolId === 'ask_user' || toolId === 'ask_user';
  }

  /**
   * Check if a tool requires user input (like ask_user)
   * @param {string} toolId - Tool identifier
   * @param {Array} tools - Available tools array
   * @returns {boolean} True if tool requires user input
   */
  isUserInputTool(toolId, tools) {
    const tool = tools?.find(t => t.id === toolId || normalizeToolName(t.id) === toolId);
    return tool?.requiresUserInput === true || this.isAskUserTool(toolId, tools);
  }

  /**
   * Execute the ask_user clarification tool
   * Instead of executing normally, this emits a clarification event to the client
   * and signals that the conversation should pause for user input
   *
   * @param {Object} toolCall - The tool call object from the LLM
   * @param {string} toolId - Tool identifier
   * @param {Object} args - Tool arguments (question, input_type, options, etc.)
   * @param {string} chatId - The conversation/chat ID
   * @param {Function} buildLogData - Function to build log data
   * @param {Object} user - Current user object
   * @param {Object} _app - App configuration (unused, for interface consistency)
   * @returns {Promise<Object>} Tool result with clarification flag
   */
  async executeClarificationTool(toolCall, toolId, args, chatId, buildLogData, _user, _app) {
    logger.info({
      component: 'ToolExecutor',
      message: 'Executing ask_user clarification tool',
      chatId,
      args: { question: args.question?.substring(0, 100), input_type: args.input_type }
    });

    // Check rate limiting - max clarifications per conversation
    const currentCount = this.getClarificationCount(chatId);
    if (currentCount >= MAX_CLARIFICATIONS) {
      logger.warn({
        component: 'ToolExecutor',
        message: 'Clarification limit reached',
        chatId,
        currentCount,
        maxAllowed: MAX_CLARIFICATIONS
      });

      // Return an error to the LLM indicating limit reached
      const errorResult = {
        error: true,
        message: `Maximum clarification limit (${MAX_CLARIFICATIONS}) reached for this conversation. Please proceed with the available information or make reasonable assumptions.`,
        code: 'CLARIFICATION_LIMIT_REACHED'
      };

      actionTracker.trackToolCallEnd(chatId, {
        toolName: toolId,
        toolOutput: errorResult,
        error: true
      });

      await logInteraction(
        'tool_usage',
        buildLogData(true, {
          toolId,
          toolInput: args,
          toolOutput: errorResult,
          rateLimited: true
        })
      );

      return {
        success: false,
        message: {
          role: 'tool',
          tool_call_id: toolCall.id,
          name: toolCall.function.name,
          content: JSON.stringify(errorResult)
        }
      };
    }

    // Validate the clarification parameters
    const validation = validateAskUserParams(args);
    if (!validation.valid) {
      logger.error({
        component: 'ToolExecutor',
        message: 'Invalid ask_user parameters',
        chatId,
        error: validation.error
      });

      const errorResult = {
        error: true,
        message: `Invalid clarification request: ${validation.error}`,
        code: 'INVALID_CLARIFICATION_PARAMS'
      };

      actionTracker.trackToolCallEnd(chatId, {
        toolName: toolId,
        toolOutput: errorResult,
        error: true
      });

      return {
        success: false,
        message: {
          role: 'tool',
          tool_call_id: toolCall.id,
          name: toolCall.function.name,
          content: JSON.stringify(errorResult)
        }
      };
    }

    // Increment the clarification count
    const newCount = this.incrementClarificationCount(chatId);

    // Generate a unique question ID for tracking
    const questionId = `clarify-${chatId}-${newCount}-${Date.now()}`;

    // Map server input_type values to client inputType values
    // Server/LLM uses: text, select, multiselect, confirm, number, date
    // Client expects: single_select, multi_select, text, number, date, date_range, file
    const inputTypeMapping = {
      select: 'single_select',
      multiselect: 'multi_select',
      confirm: 'single_select', // confirm maps to single_select with Yes/No options
      text: 'text',
      number: 'number',
      date: 'date'
    };

    const rawInputType = args.input_type || 'text';
    const mappedInputType = inputTypeMapping[rawInputType] || rawInputType;

    logger.info({
      component: 'ToolExecutor',
      message: 'Processing ask_user tool call arguments',
      chatId,
      rawInputType,
      mappedInputType,
      hasOptions: Boolean(args.options?.length),
      optionCount: args.options?.length || 0,
      question: args.question?.substring(0, 100)
    });

    // Build the clarification event data (use camelCase for client compatibility)
    const clarificationData = {
      questionId,
      toolCallId: toolCall.id,
      question: args.question,
      inputType: mappedInputType,
      allowSkip: Boolean(args.allow_skip),
      allowOther: Boolean(args.allow_other),
      clarificationNumber: newCount,
      maxClarifications: MAX_CLARIFICATIONS,
      timestamp: new Date().toISOString()
    };

    // Add optional fields if provided
    if (args.options && Array.isArray(args.options) && args.options.length > 0) {
      clarificationData.options = args.options.map(opt => ({
        label: opt.label,
        value: opt.value !== undefined ? opt.value : opt.label
      }));
    }

    // allowOther is already set above from args.allow_other

    if (args.placeholder) {
      clarificationData.placeholder = String(args.placeholder).substring(0, 200);
    }

    if (args.validation) {
      clarificationData.validation = {};
      if (args.validation.pattern) {
        clarificationData.validation.pattern = args.validation.pattern;
      }
      if (args.validation.min !== undefined) {
        clarificationData.validation.min = Number(args.validation.min);
      }
      if (args.validation.max !== undefined) {
        clarificationData.validation.max = Number(args.validation.max);
      }
      if (args.validation.message) {
        clarificationData.validation.message = String(args.validation.message).substring(0, 200);
      }
    }

    if (args.context) {
      clarificationData.context = String(args.context).substring(0, 500);
    }

    // Emit the clarification event to the client
    actionTracker.trackClarification(chatId, clarificationData);

    // Log the clarification request
    await logInteraction(
      'clarification_request',
      buildLogData(true, {
        toolId,
        toolInput: args,
        clarificationNumber: newCount,
        maxClarifications: MAX_CLARIFICATIONS
      })
    );

    // Track tool call end
    actionTracker.trackToolCallEnd(chatId, {
      toolName: toolId,
      toolOutput: { clarificationRequested: true, clarificationNumber: newCount }
    });

    logger.info({
      component: 'ToolExecutor',
      message: 'Clarification event emitted',
      chatId,
      clarificationNumber: newCount,
      question: args.question?.substring(0, 50)
    });

    // Return a special result indicating clarification is needed
    // The caller will check for this and stop processing
    return {
      success: true,
      clarification: true,
      clarificationData,
      message: {
        role: 'tool',
        tool_call_id: toolCall.id,
        name: toolCall.function.name,
        content: JSON.stringify({
          status: 'awaiting_user_response',
          message: 'Clarification request sent to user. Waiting for response.',
          clarificationNumber: newCount
        })
      }
    };
  }

  async executeToolCall(toolCall, tools, chatId, buildLogData, user, app, userFileData = null) {
    const toolId =
      tools.find(t => normalizeToolName(t.id) === toolCall.function.name)?.id ||
      toolCall.function.name;
    let args = {};

    try {
      let finalArgs = toolCall.function.arguments.replace(/}{/g, ',');
      try {
        args = JSON.parse(finalArgs);
      } catch {
        if (!finalArgs.startsWith('{')) finalArgs = '{' + finalArgs;
        if (!finalArgs.endsWith('}')) finalArgs = finalArgs + '}';
        try {
          args = JSON.parse(finalArgs);
        } catch (e2) {
          logger.error({
            component: 'ToolExecutor',
            message: 'Failed to parse tool arguments even after correction',
            toolId,
            arguments: toolCall.function.arguments,
            error: e2.message
          });
          args = {};
        }
      }
    } catch (e) {
      logger.error({
        component: 'ToolExecutor',
        message: 'Failed to parse tool arguments',
        toolId,
        arguments: toolCall.function.arguments,
        error: e.message
      });
    }

    logger.info({
      component: 'ToolExecutor',
      message: 'executeToolCall invoked',
      chatId,
      toolId,
      isWorkflow: toolId.startsWith('workflow_'),
      hasUserFileData: !!userFileData,
      argKeys: Object.keys(args).join(', ')
    });

    actionTracker.trackToolCallStart(chatId, { toolName: toolId, toolInput: args });

    try {
      // Check if this is the ask_user clarification tool
      if (this.isAskUserTool(toolId, tools)) {
        return await this.executeClarificationTool(
          toolCall,
          toolId,
          args,
          chatId,
          buildLogData,
          user,
          app
        );
      }

      // Check if this is a passthrough tool (streams directly to client)
      if (this.isPassthroughTool(toolId, tools)) {
        return await this.executePassthroughTool(
          toolCall,
          toolId,
          args,
          chatId,
          buildLogData,
          user,
          app,
          userFileData
        );
      }

      // Regular tool execution
      const result = await runTool(toolId, { ...args, chatId, user, appConfig: app });
      actionTracker.trackToolCallEnd(chatId, { toolName: toolId, toolOutput: result });

      await logInteraction(
        'tool_usage',
        buildLogData(true, {
          toolId,
          toolInput: args,
          toolOutput: result
        })
      );

      // Extract imageData if present in tool result for LLM vision processing
      const message = {
        role: 'tool',
        tool_call_id: toolCall.id,
        name: toolCall.function.name,
        content: JSON.stringify(result)
      };

      // Check for imageData in the result and extract it to message level
      if (this.extractImageDataFromResult(result, message)) {
        logger.info(`🖼️ Tool ${toolId} returned image data for vision analysis`);
        // For image analysis, replace verbose tool result with simple message
        message.content = `Retrieved image: ${message.imageData?.filename || 'attachment'}`;
      }

      return {
        success: true,
        message
      };
    } catch (toolError) {
      logger.error(`Tool execution failed for ${toolId}:`, toolError);

      const errorResult = {
        error: true,
        message: `Tool execution failed: ${toolError.message || 'Unknown error'}`,
        toolId,
        details: toolError.stack || toolError.toString()
      };

      actionTracker.trackToolCallEnd(chatId, {
        toolName: toolId,
        toolOutput: errorResult,
        error: true
      });

      await logInteraction(
        'tool_error',
        buildLogData(true, {
          toolId,
          toolInput: args,
          error: errorResult
        })
      );

      return {
        success: false,
        message: {
          role: 'tool',
          tool_call_id: toolCall.id,
          name: toolCall.function.name,
          content: JSON.stringify(errorResult)
        }
      };
    }
  }

  /**
   * Check if a tool supports passthrough/streaming responses
   */
  isPassthroughTool(toolId, tools) {
    // Find the tool by ID (tools are already expanded from functions)
    const tool = tools?.find(t => t.id === toolId);
    if (!tool) return false;

    // Check if the tool has passthrough flag (inherited from function definition)
    return tool.passthrough === true;
  }

  /**
   * Extract imageData from tool results and attach to message for vision processing
   * @param {Object} result - Tool result object
   * @param {Object} message - Tool message object to modify
   * @returns {boolean} - True if imageData was found and extracted
   */
  extractImageDataFromResult(result, message) {
    let imageDataFound = false;

    // Recursively search for imageData in the result object
    const searchForImageData = (obj, path = '') => {
      if (!obj || typeof obj !== 'object') return;

      // Check if this object has imageData structure
      if (obj.imageData && obj.imageData.type === 'image' && obj.imageData.base64) {
        logger.info(`🔍 Found imageData at path: ${path}`);

        // Move imageData to message level for adapter processing
        message.imageData = {
          type: 'image',
          format: obj.imageData.format || 'image/jpeg',
          base64: obj.imageData.base64,
          filename: obj.imageData.filename || 'attachment'
        };

        imageDataFound = true;
        return;
      }

      // Recursively search nested objects
      for (const [key, value] of Object.entries(obj)) {
        if (typeof value === 'object' && value !== null) {
          searchForImageData(value, path ? `${path}.${key}` : key);
        }
      }
    };

    searchForImageData(result);
    return imageDataFound;
  }

  /**
   * Execute a passthrough tool and return result as assistant message
   * Passthrough tools stream their responses directly to the client
   */
  async executePassthroughTool(
    toolCall,
    toolId,
    args,
    chatId,
    buildLogData,
    user,
    app,
    userFileData = null
  ) {
    try {
      // Call the tool with streaming/passthrough enabled
      // The tool should return a streaming response object when passthrough is true
      const toolParams = {
        ...args,
        chatId,
        user,
        passthrough: true, // Signal to the tool to return streaming response
        appConfig: app
      };

      // For workflow tools, pass file/image data so the workflow's inputFiles
      // mechanism can inject file content into agent node messages
      if (toolId.startsWith('workflow_') && userFileData) {
        toolParams._fileData = userFileData;
      }

      const streamingResponse = await runTool(toolId, toolParams);

      let fullContent = '';

      // Check if the response is an async iterator (for streaming)
      if (streamingResponse && typeof streamingResponse[Symbol.asyncIterator] === 'function') {
        // Handle async iterator response
        for await (const chunk of streamingResponse) {
          if (chunk) {
            actionTracker.trackChunk(chatId, { content: chunk, source: 'tool', toolName: toolId });
            fullContent += chunk;
          }
        }
      } else if (
        streamingResponse &&
        streamingResponse.body &&
        typeof streamingResponse.body.getReader === 'function'
      ) {
        // Handle raw streaming response (Response object)
        const reader = streamingResponse.body.getReader();
        const decoder = new TextDecoder();

        try {
          while (true) {
            const { done, value } = await reader.read();
            if (done) break;

            const chunk = decoder.decode(value, { stream: true });

            // For raw streams, just pass through the content
            if (chunk) {
              actionTracker.trackChunk(chatId, {
                content: chunk,
                source: 'tool',
                toolName: toolId
              });
              fullContent += chunk;
            }
          }
        } finally {
          reader.releaseLock();
        }
      } else if (typeof streamingResponse === 'string') {
        // Non-streaming response - just use the string directly
        fullContent = streamingResponse;
        actionTracker.trackChunk(chatId, {
          content: fullContent,
          source: 'tool',
          toolName: toolId
        });
      } else if (streamingResponse && typeof streamingResponse === 'object') {
        // Handle object responses (convert to string)
        fullContent =
          typeof streamingResponse.answer === 'string'
            ? streamingResponse.answer
            : JSON.stringify(streamingResponse, null, 2);
        actionTracker.trackChunk(chatId, {
          content: fullContent,
          source: 'tool',
          toolName: toolId
        });
      } else {
        // Fallback for unexpected response types
        fullContent = String(streamingResponse);
        actionTracker.trackChunk(chatId, {
          content: fullContent,
          source: 'tool',
          toolName: toolId
        });
      }

      // Signal completion of tool streaming
      actionTracker.trackToolStreamComplete(chatId, { toolName: toolId, content: fullContent });

      actionTracker.trackToolCallEnd(chatId, {
        toolName: toolId,
        toolOutput: { answer: fullContent }
      });

      await logInteraction(
        'tool_usage',
        buildLogData(true, {
          toolId,
          toolInput: args,
          toolOutput: { answer: fullContent, streaming: true }
        })
      );

      // Return the result as an assistant message instead of a tool message
      return {
        success: true,
        passthrough: true,
        message: {
          role: 'assistant',
          content: fullContent,
          tool_source: toolId, // Metadata to indicate this came from a tool
          tool_call_id: toolCall.id
        }
      };
    } catch (toolError) {
      logger.error(`Passthrough tool execution failed for ${toolId}:`, toolError);

      const errorResult = {
        error: true,
        message: `Passthrough tool execution failed: ${toolError.message || 'Unknown error'}`,
        toolId,
        details: toolError.stack || toolError.toString()
      };

      actionTracker.trackToolCallEnd(chatId, {
        toolName: toolId,
        toolOutput: errorResult,
        error: true
      });

      await logInteraction(
        'tool_error',
        buildLogData(true, {
          toolId,
          toolInput: args,
          error: errorResult
        })
      );

      // For passthrough tool errors, also return as assistant message
      return {
        success: false,
        passthrough: true,
        message: {
          role: 'assistant',
          content: `I encountered an error while processing your request: ${errorResult.message}`,
          tool_source: toolId,
          tool_call_id: toolCall.id,
          error: true
        }
      };
    }
  }

  async processChatWithTools({
    prep,
    chatId,
    buildLogData,
    DEFAULT_TIMEOUT,
    getLocalizedError,
    clientLanguage,
    user
  }) {
    const {
      request,
      model,
      llmMessages,
      tools,
      apiKey,
      temperature,
      maxTokens,
      responseFormat,
      responseSchema,
      app,
      userFileData
    } = prep;

    // Debug: Log available tools and file data for workflow debugging
    logger.info({
      component: 'ToolExecutor',
      message: 'processChatWithTools called',
      chatId,
      toolCount: tools?.length,
      toolNames: tools?.map(t => t.id).join(', '),
      hasUserFileData: !!userFileData,
      userFileDataType: userFileData ? typeof userFileData : 'none',
      userFileDataFileName: userFileData?.fileName || 'none'
    });

    const lifecycle = new RequestLifecycle(chatId, {
      timeout: DEFAULT_TIMEOUT,
      onTimeout: async () => {
        const errorMessage = await getLocalizedError(
          'requestTimeout',
          { timeout: DEFAULT_TIMEOUT / 1000 },
          clientLanguage
        );
        actionTracker.trackError(chatId, { message: errorMessage });
      }
    });

    try {
      logLLMRequest(request, { label: 'with tools', chatId, modelId: model.id });

      const llmResponse = await executeLLMRequest({
        request,
        model,
        signal: lifecycle.signal,
        language: clientLanguage
      });

      lifecycle.clearTimeout();

      // Process streaming response using shared collector
      const collector = new StreamResponseCollector(model.provider);
      const {
        content: assistantContent,
        toolCalls: collectedToolCalls,
        finishReason
      } = await collector.collect(llmResponse, {
        isAborted: () => !activeRequests.has(chatId),
        onContent: text => actionTracker.trackChunk(chatId, { content: text }),
        onImages: result => emitImages(result, chatId),
        onThinking: result => emitThinking(result, chatId),
        onGrounding: result => emitGroundingMetadata(result, chatId)
      });

      if (finishReason !== 'tool_calls' && collectedToolCalls.length === 0) {
        logger.info(
          `No tool calls to process for chat ID ${chatId}:`,
          JSON.stringify({ finishReason, collectedToolCalls }, null, 2)
        );
        actionTracker.trackDone(chatId, { finishReason: finishReason || 'stop' });
        await logInteraction(
          'chat_response',
          buildLogData(true, {
            responseType: 'success',
            response: assistantContent.substring(0, 1000)
          })
        );
        lifecycle.cleanup();
        return;
      }

      // Filter out tool calls with empty names (streaming artifacts)
      const validToolCalls = collectedToolCalls.filter(call => {
        return call.function?.name && call.function.name.trim().length > 0;
      });

      if (validToolCalls.length === 0) {
        logger.info(`No valid tool calls to process for chat ID ${chatId} after filtering`);
        lifecycle.cleanup();
        actionTracker.trackDone(chatId, { finishReason: finishReason || 'stop' });
        await logInteraction(
          'chat_response',
          buildLogData(true, {
            responseType: 'success',
            response: assistantContent.substring(0, 1000)
          })
        );
        return;
      }

      const toolNames = validToolCalls.map(c => c.function.name).join(', ');
      actionTracker.trackAction(chatId, {
        action: 'processing',
        message: `Using tool(s): ${toolNames}...`
      });

      // Debug: Log collected tool calls to verify metadata preservation
      console.log(
        `[ToolExecutor] Collected ${validToolCalls.length} tool call(s):`,
        JSON.stringify(
          validToolCalls.map(c => ({
            name: c.function?.name,
            hasMetadata: !!c.metadata,
            hasThoughtSignature: !!c.metadata?.thoughtSignature,
            thoughtSignaturePreview: c.metadata?.thoughtSignature
              ? `${c.metadata.thoughtSignature.substring(0, 20)}...`
              : undefined
          })),
          null,
          2
        )
      );

      const assistantMessage = { role: 'assistant', tool_calls: validToolCalls };
      assistantMessage.content = assistantContent || null;
      llmMessages.push(assistantMessage);

      let hasStreamingTools = false;
      let hasClarificationRequest = false;
      for (const call of validToolCalls) {
        const toolResult = await this.executeToolCall(
          call,
          tools,
          chatId,
          buildLogData,
          user,
          app,
          userFileData
        );

        if (toolResult.clarification) {
          // For clarification tools, stop processing and wait for user response
          hasClarificationRequest = true;
          llmMessages.push(toolResult.message);

          // Signal that we're waiting for clarification
          actionTracker.trackDone(chatId, {
            finishReason: 'clarification',
            clarificationData: toolResult.clarificationData
          });

          // Stop processing more tools - we need user input first
          break;
        } else if (toolResult.passthrough) {
          // For passthrough tools, add the result as assistant message and stop processing
          hasStreamingTools = true;
          llmMessages.push(toolResult.message);

          // Log the streaming tool completion
          await logInteraction(
            'chat_response',
            buildLogData(true, {
              responseType: 'success',
              response: toolResult.message.content.substring(0, 1000),
              source: 'passthrough_tool',
              toolName: toolResult.message.tool_source
            })
          );

          // Signal that we're done - user needs to send next message for LLM to continue
          actionTracker.trackDone(chatId, {
            finishReason: 'tool_passthrough_complete',
            toolName: toolResult.message.tool_source
          });
        } else {
          // Regular tool result
          llmMessages.push(toolResult.message);
        }
      }

      // If we had a clarification request, stop here and wait for user input
      if (hasClarificationRequest) {
        lifecycle.cleanup();
        return;
      }

      // If we had streaming tools, don't continue with LLM - wait for next user input
      if (hasStreamingTools) {
        lifecycle.cleanup();
        return;
      }

      // Recursively continue with tool execution until we get a final response
      await this.continueWithToolExecution({
        model,
        llmMessages,
        apiKey,
        temperature,
        maxTokens,
        tools,
        responseFormat,
        responseSchema,
        chatId,
        buildLogData,
        DEFAULT_TIMEOUT,
        getLocalizedError,
        clientLanguage,
        user,
        app,
        userFileData
      });
    } catch (error) {
      lifecycle.cleanup();

      if (error.name !== 'AbortError') {
        const errorDetails = getErrorDetails(error, model);
        let localizedMessage = errorDetails.message;

        if (error.code) {
          const translated = await getLocalizedError(error.code, {}, clientLanguage);
          if (translated && !translated.startsWith('Error:')) {
            localizedMessage = translated;
          }
        }

        const errMsg = {
          message: localizedMessage,
          code: error.code || errorDetails.code,
          details: error.details || error.message
        };

        actionTracker.trackError(chatId, { ...errMsg });
      }
    }
  }

  async continueWithToolExecution({
    model,
    llmMessages,
    apiKey,
    temperature,
    maxTokens,
    tools,
    responseFormat,
    responseSchema,
    chatId,
    buildLogData,
    DEFAULT_TIMEOUT,
    getLocalizedError,
    clientLanguage,
    user,
    app,
    userFileData = null
  }) {
    const maxIterations = 10; // Prevent infinite loops
    let iteration = 0;

    while (iteration < maxIterations) {
      iteration++;

      const followRequest = createCompletionRequest(model, llmMessages, apiKey, {
        temperature,
        maxTokens,
        stream: true,
        tools,
        responseFormat: responseFormat,
        responseSchema: responseSchema,
        user,
        chatId
      });

      const iterLifecycle = new RequestLifecycle(chatId, {
        timeout: DEFAULT_TIMEOUT,
        onTimeout: async () => {
          const errorMessage = await getLocalizedError(
            'requestTimeout',
            { timeout: DEFAULT_TIMEOUT / 1000 },
            clientLanguage
          );
          actionTracker.trackError(chatId, { message: errorMessage });
        }
      });

      try {
        logLLMRequest(followRequest, {
          label: `tool continuation, iteration ${iteration}`,
          chatId,
          modelId: model.id
        });

        const llmResponse = await executeLLMRequest({
          request: followRequest,
          model,
          signal: iterLifecycle.signal,
          language: clientLanguage
        });

        iterLifecycle.clearTimeout();

        // Process streaming response using shared collector
        const collector = new StreamResponseCollector(model.provider);
        const collectedThoughtSignatures = [];
        const {
          content: assistantContent,
          toolCalls: collectedToolCalls,
          thoughtSignatures,
          finishReason
        } = await collector.collect(llmResponse, {
          isAborted: () => !activeRequests.has(chatId),
          onContent: text => actionTracker.trackChunk(chatId, { content: text })
        });

        if (thoughtSignatures.length > 0) {
          collectedThoughtSignatures.push(...thoughtSignatures);
        }

        // If no tool calls, this is the final response - stream it back to client
        if (finishReason !== 'tool_calls' && collectedToolCalls.length === 0) {
          iterLifecycle.cleanup();
          actionTracker.trackDone(chatId, { finishReason: finishReason || 'stop' });
          await logInteraction(
            'chat_response',
            buildLogData(true, {
              responseType: 'success',
              response: assistantContent.substring(0, 1000)
            })
          );
          return; // Exit the loop, we have the final response
        }

        // Process tool calls and continue the loop
        const toolNames = collectedToolCalls.map(c => c.function.name).join(', ');
        actionTracker.trackAction(chatId, {
          action: 'processing',
          message: `Using tool(s): ${toolNames}...`
        });

        const assistantMessage = { role: 'assistant', tool_calls: collectedToolCalls };
        assistantMessage.content = assistantContent || null;

        // Preserve thoughtSignatures for Gemini 3 models (required for multi-turn function calling)
        if (collectedThoughtSignatures.length > 0) {
          assistantMessage.thoughtSignatures = collectedThoughtSignatures;
        }

        llmMessages.push(assistantMessage);

        for (const call of collectedToolCalls) {
          const toolResult = await this.executeToolCall(
            call,
            tools,
            chatId,
            buildLogData,
            user,
            app,
            userFileData
          );

          if (toolResult.clarification) {
            // For clarification tools, stop processing and wait for user response
            llmMessages.push(toolResult.message);

            // Signal that we're waiting for clarification
            actionTracker.trackDone(chatId, {
              finishReason: 'clarification',
              clarificationData: toolResult.clarificationData
            });

            // Exit the iteration and function - we need user input
            iterLifecycle.cleanup();
            return;
          } else if (toolResult.passthrough) {
            // For streaming tools, add the result as assistant message and stop processing
            llmMessages.push(toolResult.message);

            // Log the streaming tool completion
            await logInteraction(
              'chat_response',
              buildLogData(true, {
                responseType: 'success',
                response: toolResult.message.content.substring(0, 1000),
                source: 'passthrough_tool',
                toolName: toolResult.message.tool_source
              })
            );

            // Signal that we're done - user needs to send next message for LLM to continue
            actionTracker.trackDone(chatId, {
              finishReason: 'tool_passthrough_complete',
              toolName: toolResult.message.tool_source
            });

            // Exit the iteration and function - we don't continue with more tools or LLM
            iterLifecycle.cleanup();
            return;
          } else {
            // Regular tool result
            llmMessages.push(toolResult.message);
          }
        }

        // Continue to next iteration for non-streaming tools

        logger.info(`--- Tool execution iteration ${iteration} complete ---`);
        // Continue the loop for the next iteration
      } catch (error) {
        iterLifecycle.cleanup();

        if (error.name !== 'AbortError') {
          const errorDetails = getErrorDetails(error, model);
          let localizedMessage = errorDetails.message;

          if (error.code) {
            const translated = await getLocalizedError(error.code, {}, clientLanguage);
            if (translated && !translated.startsWith('Error:')) {
              localizedMessage = translated;
            }
          }

          const errMsg = {
            message: localizedMessage,
            code: error.code || errorDetails.code,
            details: error.details || error.message
          };

          actionTracker.trackError(chatId, { ...errMsg });
        }

        throw error; // Re-throw to let the calling method handle it
      }
    }

    // If we hit the max iterations, log a warning but don't error
    logger.warn(`Max tool execution iterations (${maxIterations}) reached for chat ${chatId}`);
    actionTracker.trackDone(chatId, { finishReason: 'max_iterations' });
  }
}

export default ToolExecutor;
