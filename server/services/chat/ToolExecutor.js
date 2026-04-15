import { createCompletionRequest } from '../../adapters/index.js';
import { convertResponseToGeneric } from '../../adapters/toolCalling/index.js';
import { logInteraction, getErrorDetails } from '../../utils.js';
import { runTool } from '../../toolLoader.js';
import { normalizeToolName } from '../../adapters/toolCalling/index.js';
import { activeRequests } from '../../sse.js';
import { actionTracker } from '../../actionTracker.js';
import { createParser } from 'eventsource-parser';
import { throttledFetch } from '../../requestThrottler.js';
import ErrorHandler from '../../utils/ErrorHandler.js';
import StreamingHandler from './StreamingHandler.js';
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
    this.streamingHandler = new StreamingHandler();
    /**
     * Map to track clarification counts per conversation
     * @type {Map<string, number>}
     */
    this.clarificationCounts = new Map();
    /**
     * Map to track knowledge sources used per conversation
     * @type {Map<string, Set<string>>}
     */
    this.knowledgeSources = new Map();
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
   * Add a knowledge source for tracking
   * @param {string} chatId - The conversation/chat ID
   * @param {string} source - Source type ('websearch', 'source', 'iassistant', 'grounding')
   */
  addKnowledgeSource(chatId, source) {
    if (!this.knowledgeSources.has(chatId)) {
      this.knowledgeSources.set(chatId, new Set());
    }
    this.knowledgeSources.get(chatId).add(source);
  }

  /**
   * Get knowledge sources for a conversation
   * @param {string} chatId - The conversation/chat ID
   * @returns {Array<string>} Array of source types
   */
  getKnowledgeSources(chatId) {
    const sources = this.knowledgeSources.get(chatId);
    return sources ? Array.from(sources) : [];
  }

  /**
   * Reset knowledge sources for a conversation
   * @param {string} chatId - The conversation/chat ID
   */
  resetKnowledgeSources(chatId) {
    this.knowledgeSources.delete(chatId);
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
    logger.info('Executing ask_user clarification tool', {
      component: 'ToolExecutor',
      chatId,
      args: { question: args.question?.substring(0, 100), input_type: args.input_type }
    });

    // Check rate limiting - max clarifications per conversation
    const currentCount = this.getClarificationCount(chatId);
    if (currentCount >= MAX_CLARIFICATIONS) {
      logger.warn('Clarification limit reached', {
        component: 'ToolExecutor',
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
      logger.error('Invalid ask_user parameters', {
        component: 'ToolExecutor',
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

    logger.info('Processing ask_user tool call arguments', {
      component: 'ToolExecutor',
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

    logger.info('Clarification event emitted', {
      component: 'ToolExecutor',
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
        } catch (error2) {
          logger.error('Failed to parse tool arguments even after correction', {
            component: 'ToolExecutor',
            toolId,
            arguments: toolCall.function.arguments,
            error: error2
          });
          args = {};
        }
      }
    } catch (error) {
      logger.error('Failed to parse tool arguments', {
        component: 'ToolExecutor',
        toolId,
        arguments: toolCall.function.arguments,
        error: error
      });
    }

    logger.info('executeToolCall invoked', {
      component: 'ToolExecutor',
      chatId,
      toolId,
      isWorkflow: toolId.startsWith('workflow_'),
      hasUserFileData: !!userFileData,
      argKeys: Object.keys(args).join(', ')
    });

    actionTracker.trackToolCallStart(chatId, { toolName: toolId, toolInput: args });

    // Track knowledge sources based on tool type
    // Use case-insensitive matching for search tools (braveSearch, tavilySearch, googleSearch, webSearch, etc.)
    const lowerToolId = toolId.toLowerCase();
    if (
      lowerToolId === 'web-search' ||
      lowerToolId === 'websearch' ||
      lowerToolId.includes('search')
    ) {
      // Exclude internal/non-web search tools like entraPeopleSearch, researchPlanner, deepResearch
      const isInternalSearch =
        lowerToolId.includes('people') ||
        lowerToolId.includes('planner') ||
        lowerToolId === 'deepresearch' ||
        lowerToolId === 'researchplanner';
      if (!isInternalSearch) {
        this.addKnowledgeSource(chatId, 'websearch');
      }
    } else if (toolId.startsWith('source_') || toolId.includes('retrieval')) {
      this.addKnowledgeSource(chatId, 'sources');
    }

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

      // Apply per-request tool parameter defaults (may differ from global schema defaults,
      // e.g. when resolveWebsearchTool overrides maxResults/extractContent from app.websearch).
      // This ensures admin-configured values are enforced even when the LLM omits optional params.
      const requestToolDef = tools.find(
        t => normalizeToolName(t.id) === toolCall.function.name || t.id === toolId
      );
      if (requestToolDef?.parameters?.properties) {
        for (const [key, prop] of Object.entries(requestToolDef.parameters.properties)) {
          if (args[key] === undefined && prop.default !== undefined) {
            args[key] = prop.default;
          }
        }
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
        logger.info('Tool returned image data for vision analysis', {
          component: 'ToolExecutor',
          toolId
        });
        // For image analysis, replace verbose tool result with simple message
        message.content = `Retrieved image: ${message.imageData?.filename || 'attachment'}`;
      }

      return {
        success: true,
        message
      };
    } catch (toolError) {
      logger.error('Tool execution failed', {
        component: 'ToolExecutor',
        toolId,
        error: toolError
      });

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
        logger.info('Found imageData in tool result', { component: 'ToolExecutor', path });

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
      logger.error('Passthrough tool execution failed', {
        component: 'ToolExecutor',
        toolId,
        error: toolError
      });

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
    logger.info('processChatWithTools called', {
      component: 'ToolExecutor',
      chatId,
      toolCount: tools?.length,
      toolNames: tools?.map(t => t.id).join(', '),
      hasUserFileData: !!userFileData,
      userFileDataType: userFileData ? typeof userFileData : 'none',
      userFileDataFileName: userFileData?.fileName || 'none'
    });

    const controller = new AbortController();

    if (activeRequests.has(chatId)) {
      const existingController = activeRequests.get(chatId);
      existingController.abort();
    }
    activeRequests.set(chatId, controller);

    let timeoutId;
    const setupTimeout = () => {
      timeoutId = setTimeout(async () => {
        if (activeRequests.has(chatId)) {
          controller.abort();
          const errorMessage = await getLocalizedError(
            'requestTimeout',
            { timeout: DEFAULT_TIMEOUT / 1000 },
            clientLanguage
          );
          actionTracker.trackError(chatId, { message: errorMessage });
          if (activeRequests.get(chatId) === controller) {
            activeRequests.delete(chatId);
          }
        }
      }, DEFAULT_TIMEOUT);
    };
    setupTimeout();

    try {
      const llmResponse = await throttledFetch(model.id, request.url, {
        method: 'POST',
        headers: request.headers,
        body: JSON.stringify(request.body),
        signal: controller.signal
      });

      clearTimeout(timeoutId);

      if (!llmResponse.ok) {
        const errorInfo = await this.errorHandler.createEnhancedLLMApiError(
          llmResponse,
          model,
          clientLanguage
        );

        throw Object.assign(new Error(errorInfo.message), {
          code: errorInfo.code,
          details: errorInfo.details
        });
      }

      // Use getReadableStream to handle both native fetch (Web Streams) and node-fetch (Node.js streams)
      const readableStream = this.streamingHandler.getReadableStream(llmResponse);
      const reader = readableStream.getReader();
      const decoder = new TextDecoder();
      const events = [];
      const parser = createParser({ onEvent: e => events.push(e) });

      let assistantContent = '';
      const collectedToolCalls = [];
      let finishReason = null;
      let done = false;

      while (!done) {
        const { value, done: readerDone } = await reader.read();
        if (readerDone || !activeRequests.has(chatId)) {
          if (!activeRequests.has(chatId)) reader.cancel();
          break;
        }

        const chunk = decoder.decode(value, { stream: true });
        parser.feed(chunk);

        while (events.length > 0) {
          const evt = events.shift();
          const result = await convertResponseToGeneric(evt.data, model.provider);

          if (result.error) {
            throw Object.assign(new Error(result.errorMessage || 'Error processing response'), {
              code: 'PROCESSING_ERROR'
            });
          }

          // logger.info(`Result for chat ID ${chatId}:`, result);
          if (result.content?.length > 0) {
            for (const text of result.content) {
              assistantContent += text;
              actionTracker.trackChunk(chatId, { content: text });
            }
          }

          // Process images (important for image generation with tools like google_search)
          this.streamingHandler.processImages(result, chatId);

          // Process thinking content
          this.streamingHandler.processThinking(result, chatId);

          // Process grounding metadata (for Google Search grounding)
          this.streamingHandler.processGroundingMetadata(result, chatId);

          // logger.info(`Tool calls for chat ID ${chatId}:`, result.tool_calls);
          if (result.tool_calls?.length > 0) {
            result.tool_calls.forEach(call => {
              let existingCall = collectedToolCalls.find(c => c.index === call.index);

              if (existingCall) {
                // Merge properties into the existing tool call
                if (call.id) existingCall.id = call.id;
                if (call.type) existingCall.type = call.type;
                // Preserve metadata (critical for thoughtSignature in Gemini 3)
                if (call.metadata) existingCall.metadata = call.metadata;
                if (call.function) {
                  if (call.function.name) existingCall.function.name = call.function.name;

                  // Handle arguments accumulation for streaming
                  let callArgs = call.function.arguments;
                  if (call.arguments && call.arguments.__raw_arguments) {
                    callArgs = call.arguments.__raw_arguments;
                  }
                  if (callArgs) {
                    // Smart concatenation: avoid empty {} + real args pattern
                    const existing = existingCall.function.arguments;
                    if (!existing || existing === '{}' || existing.trim() === '') {
                      // If existing is empty or just {}, replace it entirely
                      existingCall.function.arguments = callArgs;
                    } else if (callArgs !== '{}' && callArgs.trim() !== '') {
                      // Only concatenate if new args aren't empty
                      existingCall.function.arguments += callArgs;
                    }
                  }
                }
              } else if (call.index !== undefined) {
                // Create a new tool call if it doesn't exist
                let initialArgs = call.function?.arguments || '';
                if (call.arguments && call.arguments.__raw_arguments) {
                  initialArgs = call.arguments.__raw_arguments;
                }

                // Clean up initial args - avoid starting with empty {}
                if (initialArgs === '{}' || initialArgs.trim() === '') {
                  initialArgs = '';
                }

                collectedToolCalls.push({
                  index: call.index,
                  id: call.id || null,
                  type: call.type || 'function',
                  metadata: call.metadata || {}, // Preserve metadata (critical for thoughtSignature)
                  function: {
                    name: call.function?.name || '',
                    arguments: initialArgs
                  }
                });
              }
            });
          }

          // logger.info(`Finish Reason for chat ID ${chatId}:`, finishReason);
          if (result.finishReason) {
            finishReason = result.finishReason;
          }

          // logger.info(
          //   `Completed processing for chat ID ${chatId} - done? ${done}:`,
          //   JSON.stringify({ finishReason, collectedToolCalls }, null, 2)
          // );
          if (result.complete) {
            done = true;
            break;
          }
        }
      }

      if (finishReason !== 'tool_calls' && collectedToolCalls.length === 0) {
        logger.info('No tool calls to process', {
          component: 'ToolExecutor',
          chatId,
          finishReason,
          collectedToolCalls
        });
        clearTimeout(timeoutId);
        actionTracker.trackDone(chatId, { finishReason: finishReason || 'stop' });
        await logInteraction(
          'chat_response',
          buildLogData(true, {
            responseType: 'success',
            response: assistantContent.substring(0, 1000)
          })
        );
        if (activeRequests.get(chatId) === controller) {
          activeRequests.delete(chatId);
        }
        return;
      }

      // Filter out tool calls with empty names (streaming artifacts)
      const validToolCalls = collectedToolCalls.filter(call => {
        return call.function?.name && call.function.name.trim().length > 0;
      });

      if (validToolCalls.length === 0) {
        logger.info('No valid tool calls to process after filtering', {
          component: 'ToolExecutor',
          chatId
        });
        clearTimeout(timeoutId);
        actionTracker.trackDone(chatId, { finishReason: finishReason || 'stop' });
        await logInteraction(
          'chat_response',
          buildLogData(true, {
            responseType: 'success',
            response: assistantContent.substring(0, 1000)
          })
        );
        if (activeRequests.get(chatId) === controller) {
          activeRequests.delete(chatId);
        }
        return;
      }

      const toolNames = validToolCalls.map(c => c.function.name).join(', ');
      actionTracker.trackAction(chatId, {
        action: 'processing',
        message: `Using tool(s): ${toolNames}...`
      });

      // Debug: Log collected tool calls to verify metadata preservation
      logger.info('Collected tool calls', {
        component: 'ToolExecutor',
        toolCallCount: validToolCalls.length,
        toolCalls: validToolCalls.map(c => ({
          name: c.function?.name,
          hasMetadata: !!c.metadata,
          hasThoughtSignature: !!c.metadata?.thoughtSignature,
          thoughtSignaturePreview: c.metadata?.thoughtSignature
            ? `${c.metadata.thoughtSignature.substring(0, 20)}...`
            : undefined
        }))
      });

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
        clearTimeout(timeoutId);
        if (activeRequests.get(chatId) === controller) {
          activeRequests.delete(chatId);
        }
        return;
      }

      // If we had streaming tools, don't continue with LLM - wait for next user input
      if (hasStreamingTools) {
        clearTimeout(timeoutId);
        if (activeRequests.get(chatId) === controller) {
          activeRequests.delete(chatId);
        }
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
      clearTimeout(timeoutId);

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

      if (activeRequests.get(chatId) === controller) {
        activeRequests.delete(chatId);
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

      const controller = new AbortController();

      if (activeRequests.has(chatId)) {
        const existingController = activeRequests.get(chatId);
        existingController.abort();
      }
      activeRequests.set(chatId, controller);

      let timeoutId = setTimeout(async () => {
        if (activeRequests.has(chatId)) {
          controller.abort();
          const errorMessage = await getLocalizedError(
            'requestTimeout',
            { timeout: DEFAULT_TIMEOUT / 1000 },
            clientLanguage
          );
          actionTracker.trackError(chatId, { message: errorMessage });
          if (activeRequests.get(chatId) === controller) {
            activeRequests.delete(chatId);
          }
        }
      }, DEFAULT_TIMEOUT);

      try {
        // Determine HTTP method and body based on adapter requirements
        const fetchOptions = {
          method: followRequest.method || 'POST',
          headers: followRequest.headers,
          signal: controller.signal
        };

        // Only add body for POST requests
        if (fetchOptions.method === 'POST' && followRequest.body) {
          fetchOptions.body = JSON.stringify(followRequest.body);
        }

        const llmResponse = await throttledFetch(model.id, followRequest.url, fetchOptions);

        clearTimeout(timeoutId);

        if (!llmResponse.ok) {
          const errorInfo = await this.errorHandler.createEnhancedLLMApiError(
            llmResponse,
            model,
            clientLanguage
          );

          throw Object.assign(new Error(errorInfo.message), {
            code: errorInfo.code,
            details: errorInfo.details
          });
        }

        // Use getReadableStream to handle both native fetch (Web Streams) and node-fetch (Node.js streams)
        const readableStream = this.streamingHandler.getReadableStream(llmResponse);
        const reader = readableStream.getReader();
        const decoder = new TextDecoder();
        const events = [];
        const parser = createParser({ onEvent: e => events.push(e) });

        let assistantContent = '';
        const collectedToolCalls = [];
        const collectedThoughtSignatures = []; // Collect all thoughtSignatures from response
        let finishReason = null;
        let done = false;

        while (!done) {
          const { value, done: readerDone } = await reader.read();
          if (readerDone || !activeRequests.has(chatId)) {
            if (!activeRequests.has(chatId)) reader.cancel();
            break;
          }

          const chunk = decoder.decode(value, { stream: true });
          parser.feed(chunk);

          while (events.length > 0) {
            const evt = events.shift();
            const result = await convertResponseToGeneric(evt.data, model.provider);

            if (result.error) {
              throw Object.assign(new Error(result.errorMessage || 'Error processing response'), {
                code: 'PROCESSING_ERROR'
              });
            }

            if (result.content?.length > 0) {
              for (const text of result.content) {
                assistantContent += text;
                actionTracker.trackChunk(chatId, { content: text });
              }
            }

            if (result.tool_calls?.length > 0) {
              result.tool_calls.forEach(call => {
                let existingCall = collectedToolCalls.find(c => c.index === call.index);

                if (existingCall) {
                  if (call.id) existingCall.id = call.id;
                  if (call.type) existingCall.type = call.type;
                  if (call.function) {
                    if (call.function.name) existingCall.function.name = call.function.name;
                    if (call.function.arguments)
                      existingCall.function.arguments += call.function.arguments;
                  }
                  // Merge metadata (important for Gemini thoughtSignatures)
                  if (call.metadata) {
                    existingCall.metadata = { ...existingCall.metadata, ...call.metadata };
                  }
                } else if (call.index !== undefined) {
                  const toolCall = {
                    index: call.index,
                    id: call.id || null,
                    type: call.type || 'function',
                    function: {
                      name: call.function?.name || '',
                      arguments: call.function?.arguments || ''
                    },
                    // Preserve metadata for provider-specific requirements (e.g., Gemini thoughtSignatures)
                    metadata: call.metadata || {}
                  };
                  collectedToolCalls.push(toolCall);
                }
              });
            }

            // Collect thoughtSignatures for Google Gemini thinking models
            if (result.thoughtSignatures && result.thoughtSignatures.length > 0) {
              collectedThoughtSignatures.push(...result.thoughtSignatures);
              logger.info('Collected thoughtSignatures from response', {
                component: 'ToolExecutor',
                count: result.thoughtSignatures.length
              });
            }

            if (result.finishReason) {
              finishReason = result.finishReason;
            }

            if (result.complete) {
              done = true;
              break;
            }
          }
        }

        // If no tool calls, this is the final response - stream it back to client
        if (finishReason !== 'tool_calls' && collectedToolCalls.length === 0) {
          clearTimeout(timeoutId);

          // Emit answer source information before done event
          const sources = this.getKnowledgeSources(chatId);
          if (sources.length > 0) {
            actionTracker.trackAnswerSource(chatId, { sources, type: 'mixed' });
          }

          actionTracker.trackDone(chatId, { finishReason: finishReason || 'stop' });
          await logInteraction(
            'chat_response',
            buildLogData(true, {
              responseType: 'success',
              response: assistantContent.substring(0, 1000)
            })
          );
          if (activeRequests.get(chatId) === controller) {
            activeRequests.delete(chatId);
          }

          // Reset knowledge sources after emitting
          this.resetKnowledgeSources(chatId);

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
            clearTimeout(timeoutId);
            if (activeRequests.get(chatId) === controller) {
              activeRequests.delete(chatId);
            }
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
            clearTimeout(timeoutId);
            if (activeRequests.get(chatId) === controller) {
              activeRequests.delete(chatId);
            }
            return;
          } else {
            // Regular tool result
            llmMessages.push(toolResult.message);
          }
        }

        // Continue to next iteration for non-streaming tools

        logger.info('Tool execution iteration complete', { component: 'ToolExecutor', iteration });
        // Continue the loop for the next iteration
      } catch (error) {
        clearTimeout(timeoutId);

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

        if (activeRequests.get(chatId) === controller) {
          activeRequests.delete(chatId);
        }
        throw error; // Re-throw to let the calling method handle it
      }
    }

    // If we hit the max iterations, log a warning but don't error
    logger.warn('Max tool execution iterations reached', {
      component: 'ToolExecutor',
      maxIterations,
      chatId
    });
    actionTracker.trackDone(chatId, { finishReason: 'max_iterations' });
  }
}

export default ToolExecutor;
