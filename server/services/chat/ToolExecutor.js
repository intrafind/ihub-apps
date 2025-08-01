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

class ToolExecutor {
  constructor() {
    this.errorHandler = new ErrorHandler();
    this.streamingHandler = new StreamingHandler();
  }

  async executeToolCall(toolCall, tools, chatId, buildLogData, user) {
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
      const result = await runTool(toolId, { ...args, chatId, user });
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
          const result = convertResponseToGeneric(evt.data, model.provider);

          if (result.error) {
            throw Object.assign(new Error(result.errorMessage || 'Error processing response'), {
              code: 'PROCESSING_ERROR'
            });
          }

          // console.log(`Result for chat ID ${chatId}:`, result);
          if (result.content?.length > 0) {
            for (const text of result.content) {
              assistantContent += text;
              actionTracker.trackChunk(chatId, { content: text });
            }
          }

          // console.log(`Tool calls for chat ID ${chatId}:`, result.tool_calls);
          if (result.tool_calls?.length > 0) {
            result.tool_calls.forEach(call => {
              let existingCall = collectedToolCalls.find(c => c.index === call.index);

              if (existingCall) {
                // Merge properties into the existing tool call
                if (call.id) existingCall.id = call.id;
                if (call.type) existingCall.type = call.type;
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
                  function: {
                    name: call.function?.name || '',
                    arguments: initialArgs
                  }
                });
              }
            });
          }

          // console.log(`Finish Reason for chat ID ${chatId}:`, finishReason);
          if (result.finishReason) {
            finishReason = result.finishReason;
          }

          // console.log(
          //   `Completed processing for chat ID ${chatId} - done? ${done}:`,
          //   JSON.stringify({ finishReason, collectedToolCalls }, null, 2)
          // );
          if (result.complete) {
            done = true;
            break;
          }
        }
      }

      // --- DEBUG LOGGING START ---
      // console.log('--- Collected Tool Calls from Stream ---');
      // console.log(JSON.stringify(collectedToolCalls, null, 2));
      // console.log('------------------------------------');
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

      // Filter out tool calls with empty names (streaming artifacts)
      const validToolCalls = collectedToolCalls.filter(call => {
        return call.function?.name && call.function.name.trim().length > 0;
      });

      if (validToolCalls.length === 0) {
        console.log(`No valid tool calls to process for chat ID ${chatId} after filtering`);
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

      const assistantMessage = { role: 'assistant', tool_calls: validToolCalls };
      assistantMessage.content = assistantContent || null;
      llmMessages.push(assistantMessage);

      for (const call of validToolCalls) {
        const toolResult = await this.executeToolCall(call, tools, chatId, buildLogData, user);
        llmMessages.push(toolResult.message);
      }

      // --- DEBUG LOGGING START ---
      // console.log('--- Messages for Follow-up LLM Call ---');
      // console.log(JSON.stringify(llmMessages, null, 2));
      // console.log('---------------------------------------');
      // --- DEBUG LOGGING END ---

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
        user
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
    user
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
            const result = convertResponseToGeneric(evt.data, model.provider);

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
                } else if (call.index !== undefined) {
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
        if (finishReason !== 'tool_calls' || collectedToolCalls.length === 0) {
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
        llmMessages.push(assistantMessage);

        for (const call of collectedToolCalls) {
          const toolResult = await this.executeToolCall(call, tools, chatId, buildLogData, user);
          llmMessages.push(toolResult.message);
        }

        console.log(`--- Tool execution iteration ${iteration} complete ---`);
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
    console.warn(`Max tool execution iterations (${maxIterations}) reached for chat ${chatId}`);
    actionTracker.trackDone(chatId, { finishReason: 'max_iterations' });
  }
}

export default ToolExecutor;
