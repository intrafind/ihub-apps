import { createCompletionRequest, processResponseBuffer } from '../../adapters/index.js';
import { logInteraction, getErrorDetails } from '../../utils.js';
import { runTool } from '../../toolLoader.js';
import { normalizeName } from '../../adapters/toolFormatter.js';
import { activeRequests } from '../../sse.js';
import { actionTracker } from '../../actionTracker.js';
import { createParser } from 'eventsource-parser';
import { throttledFetch } from '../../requestThrottler.js';
import ErrorHandler from '../../utils/ErrorHandler.js';
import StreamingHandler from './StreamingHandler.js';

class ToolExecutor {
  constructor() {
    this.errorHandler = new ErrorHandler();
    this.streamingHandler = new StreamingHandler();
  }

  async executeToolCall(toolCall, tools, chatId, buildLogData) {
    const toolId =
      tools.find(t => normalizeName(t.id) === toolCall.function.name)?.id || toolCall.function.name;
    let args = {};

    try {
      let finalArgs = toolCall.function.arguments.replace(/}{/g, ',');
      try {
        args = JSON.parse(finalArgs);
      } catch (e) {
        if (!finalArgs.startsWith('{')) finalArgs = '{' + finalArgs;
        if (!finalArgs.endsWith('}')) finalArgs = finalArgs + '}';
        try {
          args = JSON.parse(finalArgs);
        } catch (e2) {
          console.error(
            'Failed to parse tool arguments even after correction:',
            toolCall.function.arguments,
            e2
          );
          args = {};
        }
      }
    } catch (e) {
      console.error('Failed to parse tool arguments:', toolCall.function.arguments, e);
    }

    actionTracker.trackToolCallStart(chatId, { toolName: toolId, toolInput: args });

    // --- DEBUG LOGGING START ---
    console.log(`--- Executing Tool: ${toolId} ---`);
    console.log('Arguments:', JSON.stringify(args, null, 2));
    console.log('---------------------------------');
    // --- DEBUG LOGGING END ---

    try {
      const result = await runTool(toolId, { ...args, chatId });
      // --- DEBUG LOGGING START ---
      console.log(`--- Tool Result: ${toolId} ---`);
      console.log(JSON.stringify(result, null, 2));
      console.log('-----------------------------');
      // --- DEBUG LOGGING END ---
      actionTracker.trackToolCallEnd(chatId, { toolName: toolId, toolOutput: result });

      await logInteraction(
        'tool_usage',
        buildLogData(true, {
          toolId,
          toolInput: args,
          toolOutput: result
        })
      );

      return {
        success: true,
        message: {
          role: 'tool',
          tool_call_id: toolCall.id,
          name: toolCall.function.name,
          content: JSON.stringify(result)
        }
      };
    } catch (toolError) {
      console.error(`Tool execution failed for ${toolId}:`, toolError);

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

  async processChatWithTools({
    prep,
    clientRes,
    chatId,
    buildLogData,
    DEFAULT_TIMEOUT,
    getLocalizedError,
    clientLanguage
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
      responseSchema
    } = prep;
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
        const errorBody = await llmResponse.text();
        throw Object.assign(new Error(`LLM API request failed with status ${llmResponse.status}`), {
          code: llmResponse.status.toString(),
          details: errorBody
        });
      }

      const reader = llmResponse.body.getReader();
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
          const result = processResponseBuffer(model.provider, evt.data);

          if (result.error) {
            throw Object.assign(new Error(result.errorMessage || 'Error processing response'), {
              code: 'PROCESSING_ERROR'
            });
          }

          console.log(`Result for chat ID ${chatId}:`, result);
          if (result.content?.length > 0) {
            for (const text of result.content) {
              assistantContent += text;
              actionTracker.trackChunk(chatId, { content: text });
            }
          }

          console.log(`Tool calls for chat ID ${chatId}:`, result.tool_calls);
          if (result.tool_calls?.length > 0) {
            result.tool_calls.forEach(call => {
              let existingCall = collectedToolCalls.find(c => c.index === call.index);

              if (existingCall) {
                // Merge properties into the existing tool call
                if (call.id) existingCall.id = call.id;
                if (call.type) existingCall.type = call.type;
                if (call.function) {
                  if (call.function.name) existingCall.function.name = call.function.name;
                  if (call.function.arguments)
                    existingCall.function.arguments += call.function.arguments;
                }
              } else if (call.index !== undefined) {
                // Create a new tool call if it doesn't exist
                collectedToolCalls.push({
                  index: call.index,
                  id: call.id || null,
                  type: call.type || 'function',
                  function: {
                    name: call.function?.name || '',
                    arguments: call.function?.arguments || ''
                  }
                });
              }
            });
          }

          console.log(`Finish Reason for chat ID ${chatId}:`, finishReason);
          if (result.finishReason) {
            finishReason = result.finishReason;
          }

          console.log(
            `Completed processing for chat ID ${chatId} - done? ${done}:`,
            JSON.stringify({ finishReason, collectedToolCalls }, null, 2)
          );
          if (result.complete) {
            done = true;
            break;
          }
        }
      }

      // --- DEBUG LOGGING START ---
      console.log('--- Collected Tool Calls from Stream ---');
      console.log(JSON.stringify(collectedToolCalls, null, 2));
      console.log('------------------------------------');
      // --- DEBUG LOGGING END ---

      if (finishReason !== 'tool_calls' || collectedToolCalls.length === 0) {
        console.log(
          `No tool calls to process for chat ID ${chatId}:`,
          JSON.stringify({ finishReason, collectedToolCalls }, null, 2)
        );
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

      const toolNames = collectedToolCalls.map(c => c.function.name).join(', ');
      actionTracker.trackAction(chatId, {
        action: 'processing',
        message: `Using tool(s): ${toolNames}...`
      });

      const assistantMessage = { role: 'assistant', tool_calls: collectedToolCalls };
      assistantMessage.content = assistantContent || null;
      llmMessages.push(assistantMessage);

      for (const call of collectedToolCalls) {
        const toolResult = await this.executeToolCall(call, tools, chatId, buildLogData);
        llmMessages.push(toolResult.message);
      }

      // --- DEBUG LOGGING START ---
      console.log('--- Messages for Follow-up LLM Call ---');
      console.log(JSON.stringify(llmMessages, null, 2));
      console.log('---------------------------------------');
      // --- DEBUG LOGGING END ---

      const followRequest = createCompletionRequest(model, llmMessages, apiKey, {
        temperature,
        maxTokens,
        stream: true,
        tools,
        responseFormat: responseFormat,
        responseSchema: responseSchema
      });

      clearTimeout(timeoutId);

      this.streamingHandler.executeStreamingResponse({
        request: followRequest,
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
}

export default ToolExecutor;
