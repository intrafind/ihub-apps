// Chat service helper functions
import configCache from '../configCache.js';
import { createCompletionRequest, processResponseBuffer } from '../adapters/index.js';
import { getErrorDetails, logInteraction } from '../utils.js';
import { recordChatRequest, recordChatResponse, estimateTokens } from '../usageTracker.js';
import { getToolsForApp, runTool } from '../toolLoader.js';
import { normalizeName } from '../adapters/toolFormatter.js';
import { activeRequests } from '../sse.js';
import { actionTracker } from '../actionTracker.js';
import { createParser } from 'eventsource-parser';
import { throttledFetch } from '../requestThrottler.js';

// Prepend file data to message content when present
export function preprocessMessagesWithFileData(messages) {
  return messages.map(msg => {
    if (msg.fileData && msg.fileData.content) {
      const fileInfo = `[File: ${msg.fileData.name} (${msg.fileData.type})]\n\n${msg.fileData.content}\n\n`;
      return { ...msg, content: fileInfo + (msg.content || '') };
    }
    return msg;
  });
}

// Prepare the LLM request (load app and model, process messages, verify API key)
export async function prepareChatRequest({
  appId,
  modelId,
  messages,
  temperature,
  style,
  outputFormat,
  language,
  useMaxTokens = false,
  bypassAppPrompts = false,
  verifyApiKey,
  processMessageTemplates,
  res,
  clientRes
}) {
  // Try to get apps from cache first
  let apps = configCache.getApps();
  if (!apps) {
    return { error: 'Failed to load apps configuration' };
  }
  const app = apps.find(a => a.id === appId);
  if (!app) {
    return { error: 'appNotFound' };
  }

  // Try to get models from cache first
  let models = configCache.getModels(); 
  if (!models) {
    return { error: 'Failed to load models configuration' };
  }
  const defaultModel = models.find(m => m.default)?.id;
  const model = models.find(
    m => m.id === (modelId || app.preferredModel || defaultModel)
  );
  if (!model) {
    return { error: 'modelNotFound' };
  }

  // Prepare messages for the model
  let llmMessages = await processMessageTemplates(messages, bypassAppPrompts ? null : app, style, outputFormat, language, app.outputSchema);
  llmMessages = preprocessMessagesWithFileData(llmMessages);

  // Determine token limit based on app configuration and retry flag
  const appTokenLimit = app.tokenLimit || 1024;
  const modelTokenLimit = model.tokenLimit || appTokenLimit;
  const finalTokens = useMaxTokens
    ? modelTokenLimit
    : Math.min(appTokenLimit, modelTokenLimit);

  // Verify API key
  const apiKey = await verifyApiKey(model, res, clientRes, language);
  if (!apiKey) {
    return { error: 'apiKey' };
  }

  const tools = await getToolsForApp(app);
  const request = createCompletionRequest(model, llmMessages, apiKey, {
    temperature: parseFloat(temperature) || app.preferredTemperature || 0.7,
    maxTokens: finalTokens,
    stream: !!clientRes,
    tools,
    responseFormat: outputFormat,
    responseSchema: app.outputSchema
  });

  return { app, model, llmMessages, request, tools, apiKey, temperature: parseFloat(temperature) || app.preferredTemperature || 0.7, maxTokens: finalTokens };
}

// Execute a non-streaming request and send JSON response
export async function executeNonStreamingResponse({
  request,
  res,
  buildLogData,
  messageId,
  model,
  llmMessages,
  DEFAULT_TIMEOUT
}) {
  let timeoutId;
  const timeoutPromise = new Promise((_, reject) => {
    timeoutId = setTimeout(() => {
      reject(new Error(`Request timed out after ${DEFAULT_TIMEOUT/1000} seconds`));
    }, DEFAULT_TIMEOUT);
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
      const errorLog = buildLogData(false, {
        responseType: 'error',
        error: {
          message: `LLM API request failed with status ${llmResponse.status}`,
          code: llmResponse.status.toString()
        }
      });
      await logInteraction('chat_error', errorLog);
      return res.status(llmResponse.status).json({
        error: `LLM API request failed with status ${llmResponse.status}`,
        details: errorBody
      });
    }

    const responseData = await llmResponse.json();
    responseData.messageId = messageId;

    const promptTokens = responseData.usage?.prompt_tokens || 0;
    const completionTokens = responseData.usage?.completion_tokens || 0;
    const baseLog = buildLogData(false);
    await recordChatRequest({ userId: baseLog.userSessionId, appId: baseLog.appId, modelId: model.id, tokens: promptTokens });

    let aiResponse = '';
    if (responseData.choices && responseData.choices.length > 0) {
      aiResponse = responseData.choices[0].message?.content || '';
    }
    const responseLog = buildLogData(false, {
      responseType: 'success',
      response: aiResponse.substring(0, 1000)
    });
    await logInteraction('chat_response', responseLog);
    await recordChatResponse({ userId: baseLog.userSessionId, appId: baseLog.appId, modelId: model.id, tokens: completionTokens });

    return res.json(responseData);
  } catch (fetchError) {
    clearTimeout(timeoutId);
    const errorDetails = getErrorDetails(fetchError, model);
    await logInteraction('chat_error', buildLogData(false, {
      responseType: 'error',
      error: { message: errorDetails.message, code: errorDetails.code }
    }));
    return res.status(500).json({
      error: errorDetails.message,
      code: errorDetails.code,
      modelId: model.id,
      provider: model.provider,
      recommendation: errorDetails.recommendation,
      details: fetchError.message
    });
  }
}

// Execute a streaming request and send SSE events
export async function executeStreamingResponse({
  request,
  chatId,
  clientRes,
  buildLogData,
  model,
  llmMessages,
  DEFAULT_TIMEOUT,
  getLocalizedError,
  clientLanguage
}) {
  // TODO localize
  actionTracker.trackAction(chatId, { event: 'processing', message: 'Processing your request...' });
  const controller = new AbortController();
  activeRequests.set(chatId, controller);
  const baseLog = buildLogData(true);
  const promptTokens = llmMessages.map(m => estimateTokens(m.content || '')).reduce((a,b) => a+b, 0);
  await recordChatRequest({ userId: baseLog.userSessionId, appId: baseLog.appId, modelId: model.id, tokens: promptTokens });
  const timeoutId = setTimeout(async () => {
    controller.abort();
    const errorMessage = await getLocalizedError('requestTimeout', { timeout: DEFAULT_TIMEOUT/1000 }, clientLanguage);
    actionTracker.trackError(chatId, { message: errorMessage });
    activeRequests.delete(chatId);
  }, DEFAULT_TIMEOUT);

  console.log(`Sending request for chat ID ${chatId} ${model.id}:`, request.body);

  throttledFetch(model.id, request.url, {
    method: 'POST',
    headers: request.headers,
    body: JSON.stringify(request.body),
    signal: controller.signal
  }).then(async (llmResponse) => {
    clearTimeout(timeoutId);
    if (!llmResponse.ok) {
      const errorBody = await llmResponse.text();
      let errorMessage = await getLocalizedError('llmApiError', { status: llmResponse.status }, clientLanguage);
      if (llmResponse.status === 401) {
        errorMessage = await getLocalizedError('authenticationFailed', { provider: model.provider }, clientLanguage);
      } else if (llmResponse.status === 429) {
        errorMessage = await getLocalizedError('rateLimitExceeded', { provider: model.provider }, clientLanguage);
      } else if (llmResponse.status >= 500) {
        errorMessage = await getLocalizedError('serviceError', { provider: model.provider }, clientLanguage);
      }
      await logInteraction('chat_error', buildLogData(true, {
        responseType: 'error',
        error: { message: errorMessage, code: llmResponse.status.toString(), details: errorBody }
      }));
      actionTracker.trackError(chatId, { message: errorMessage, details: errorBody });
      activeRequests.delete(chatId);
      return;
    }

    const reader = llmResponse.body.getReader();
    const decoder = new TextDecoder();
    const events = [];
    const parser = createParser({
      onEvent: (event) => {
        // Handle events without explicit type (Google sends data events without event type)
        if (event.type === 'event' || !event.type) {
          events.push(event);
        }
      }
    });
    let fullResponse = '';
    let finishReason = null;
    let doneEmitted = false;

    try {
      while (true) {
        const { done, value } = await reader.read();
        if (!activeRequests.has(chatId)) {
          reader.cancel();
          break;
        }
        if (done) break;
        const chunk = decoder.decode(value, { stream: true });
        parser.feed(chunk);
        while (events.length > 0) {
          const evt = events.shift();
          const result = processResponseBuffer(model.provider, evt.data);
          if (result && result.content && result.content.length > 0) {
            for (const textContent of result.content) {
              actionTracker.trackChunk(chatId, { content: textContent });
              fullResponse += textContent;
            }
          }
          if (result && result.error) {
            await logInteraction('chat_error', buildLogData(true, {
              responseType: 'error',
              error: { message: result.errorMessage || 'Error processing response', code: 'PROCESSING_ERROR' },
              response: fullResponse
            }));
            actionTracker.trackError(chatId, { message: result.errorMessage || 'Error processing response' });
            finishReason = 'error';
            break;
          }
          if (result && result.finishReason) {
            finishReason = result.finishReason;
          }
          if (result && result.complete) {
            actionTracker.trackDone(chatId, { finishReason });
            doneEmitted = true;
            await logInteraction('chat_response', buildLogData(true, { responseType: 'success', response: fullResponse }));
            const completionTokens = estimateTokens(fullResponse);
            await recordChatResponse({ userId: baseLog.userSessionId, appId: baseLog.appId, modelId: model.id, tokens: completionTokens });
            break;
          }
        }
        if (finishReason === 'error' || doneEmitted) {
          break;
        }
      }
    } catch (error) {
      if (error.name !== 'AbortError') {
        const errorMessage = await getLocalizedError('responseStreamError', { error: error.message }, clientLanguage);
        actionTracker.trackError(chatId, { message: errorMessage });
        finishReason = 'error';
      }
    } finally {
      if (!doneEmitted) {
        actionTracker.trackDone(chatId, { finishReason: finishReason || 'connection_closed' });
      }
      activeRequests.delete(chatId);
    }
  }).catch(async (error) => {
    console.error('Error occurred while processing chat:', error);
    clearTimeout(timeoutId);
    if (error.name !== 'AbortError') {
      const errorDetails = getErrorDetails(error, model);
      await logInteraction('chat_error', buildLogData(true, {
        responseType: 'error',
        error: { message: errorDetails.message, code: errorDetails.code }
      }));
      const errorMessage = {
        message: errorDetails.message,
        modelId: model.id,
        provider: model.provider,
        recommendation: errorDetails.recommendation,
        details: error.message
      };
      actionTracker.trackError(chatId, errorMessage);
    }
    activeRequests.delete(chatId);
  });
}

// Execute a request with potential tool calls - non-blocking implementation
export function processChatWithTools({
  prep,
  clientRes,
  chatId,
  buildLogData,
  DEFAULT_TIMEOUT,
  getLocalizedError,
  clientLanguage
}) {
  const { request, model, llmMessages, tools, apiKey, temperature, maxTokens, responseFormat, responseSchema } = prep;
  const controller = new AbortController();
  activeRequests.set(chatId, controller);


  const timeoutId = setTimeout(async () => {
    controller.abort();
    const errorMessage = await getLocalizedError('requestTimeout', { timeout: DEFAULT_TIMEOUT / 1000 }, clientLanguage);
    actionTracker.trackError(chatId, { message: errorMessage });
    activeRequests.delete(chatId);
  }, DEFAULT_TIMEOUT);

  throttledFetch(model.id, request.url, {
    method: 'POST',
    headers: request.headers,
    body: JSON.stringify(request.body),
    signal: controller.signal
  })
  .then(async (llmResponse) => {
    clearTimeout(timeoutId);

    if (!llmResponse.ok) {
      const errorBody = await llmResponse.text();
      throw Object.assign(new Error(`LLM API request failed with status ${llmResponse.status}`), { code: llmResponse.status.toString(), details: errorBody });
    }

    const reader = llmResponse.body.getReader();
    const decoder = new TextDecoder();
    const events = [];
    const parser = createParser({ onEvent: (e) => events.push(e) });

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
          throw Object.assign(new Error(result.errorMessage || 'Error processing response'), { code: 'PROCESSING_ERROR' });
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
            const existingCall = collectedToolCalls.find(c => (call.id && c.id === call.id) || (!call.id && c.index === call.index));
            if (existingCall) {
              if (call.function?.arguments) {
                existingCall.function.arguments += call.function.arguments;
              }
            } else if ((call.id || call.index !== undefined) && call.function?.name) {
              collectedToolCalls.push({
                index: call.index,
                id: call.id,
                type: call.type || 'function',
                function: {
                  name: call.function.name,
                  arguments: call.function.arguments || ''
                }
              });
            }
          });
        }

        console.log(`Finish Reason for chat ID ${chatId}:`, finishReason);
        if (result.finishReason) {
          finishReason = result.finishReason;
        }

        console.log(`Completed processing for chat ID ${chatId} - done? ${done}:`, JSON.stringify({ finishReason, collectedToolCalls }, null, 2));
        if (result.complete) {
          done = true;
          break;
        }
      }
    }

    if (finishReason !== 'tool_calls' || collectedToolCalls.length === 0) {
      console.log(`No tool calls to process for chat ID ${chatId}:`, JSON.stringify({ finishReason, collectedToolCalls }, null, 2));
      actionTracker.trackDone(chatId, { finishReason: finishReason || 'stop' });
      await logInteraction('chat_response', buildLogData(true, { responseType: 'success', response: assistantContent.substring(0, 1000) }));
      activeRequests.delete(chatId);
      return;
    }
    
    const toolNames = collectedToolCalls.map(c => c.function.name).join(', ');
    actionTracker.trackAction(chatId, { action: 'processing', message: `Using tool(s): ${toolNames}...` });

    const assistantMessage = { role: 'assistant', tool_calls: collectedToolCalls };
    assistantMessage.content = assistantContent || null;
    llmMessages.push(assistantMessage);

    for (const call of collectedToolCalls) {
      const toolId = tools.find(t => normalizeName(t.id) === call.function.name)?.id || call.function.name;
      let args = {};
      try {
        let finalArgs = call.function.arguments.replace(/}{/g, ',');
        try {
          args = JSON.parse(finalArgs);
        } catch(e) {
          if (!finalArgs.startsWith('{')) finalArgs = '{' + finalArgs;
          if (!finalArgs.endsWith('}')) finalArgs = finalArgs + '}';
          try {
             args = JSON.parse(finalArgs);
          } catch (e2) {
             console.error("Failed to parse tool arguments even after correction:", call.function.arguments, e2);
             args = {};
          }
        }
      } catch (e) {
        console.error("Failed to parse tool arguments:", call.function.arguments, e);
      }
      
      actionTracker.trackToolCallStart(chatId, { toolName: toolId, toolInput: args });
      const result = await runTool(toolId, { ...args, chatId });
      actionTracker.trackToolCallEnd(chatId, { toolName: toolId, toolOutput: result });

      await logInteraction('tool_usage', buildLogData(true, {
        toolId,
        toolInput: args,
        toolOutput: result
      }));

      llmMessages.push({ role: 'tool', tool_call_id: call.id, name: call.function.name, content: JSON.stringify(result) });
    }

    const followRequest = createCompletionRequest(model, llmMessages, apiKey, {
      temperature,
      maxTokens,
      stream: true,
      tools,
      responseFormat: responseFormat,
      responseSchema: responseSchema
    });

    // Clear the timeout since we're transitioning to executeStreamingResponse
    clearTimeout(timeoutId);

    executeStreamingResponse({
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

  })
  .catch(async (error) => {
    clearTimeout(timeoutId);
    if (error.name !== 'AbortError') {
      const errorDetails = getErrorDetails(error, model);
      let localizedMessage = errorDetails.message;
      if (error.code) {
        const translated = await getLocalizedError(error.code, {}, clientLanguage);
        if (translated && !translated.startsWith('Error:')) localizedMessage = translated;
      }
      
      const errMsg = {
        message: localizedMessage,
        code: error.code || errorDetails.code,
        details: error.details || error.message
      };

      actionTracker.trackError(chatId, { ...errMsg });
    }
    activeRequests.delete(chatId);
  });
}
