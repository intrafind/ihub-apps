// Chat service helper functions
import { loadJson } from '../configLoader.js';
import { createCompletionRequest, processResponseBuffer } from '../adapters/index.js';
import { getErrorDetails, logInteraction } from '../utils.js';
import { recordChatRequest, recordChatResponse, estimateTokens } from '../usageTracker.js';
import { getToolsForApp, runTool } from '../toolLoader.js';
import { normalizeName } from '../adapters/toolFormatter.js';
import { sendSSE, activeRequests } from '../sse.js';

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
  // Load app configuration
  const apps = await loadJson('config/apps.json');
  if (!apps) {
    return { error: 'Failed to load apps configuration' };
  }
  const app = apps.find(a => a.id === appId);
  if (!app) {
    return { error: 'appNotFound' };
  }

  // Load models
  const models = await loadJson('config/models.json');
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
  const llmMessages = await processMessageTemplates(messages, bypassAppPrompts ? null : app, style, outputFormat, language);

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
    stream: tools.length === 0 && !!clientRes,
    tools
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
    const responsePromise = fetch(request.url, {
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
  sendSSE(clientRes, 'processing', { message: 'Processing your request...' });
  const controller = new AbortController();
  activeRequests.set(chatId, controller);
  const baseLog = buildLogData(true);
  const promptTokens = llmMessages.map(m => estimateTokens(m.content || '')).reduce((a,b) => a+b, 0);
  await recordChatRequest({ userId: baseLog.userSessionId, appId: baseLog.appId, modelId: model.id, tokens: promptTokens });
  const timeoutId = setTimeout(async () => {
    controller.abort();
    const errorMessage = await getLocalizedError('requestTimeout', { timeout: DEFAULT_TIMEOUT/1000 }, clientLanguage);
    sendSSE(clientRes, 'error', { message: errorMessage });
    activeRequests.delete(chatId);
  }, DEFAULT_TIMEOUT);

  fetch(request.url, {
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
      sendSSE(clientRes, 'error', { message: errorMessage, details: errorBody });
      activeRequests.delete(chatId);
      return;
    }

    const reader = llmResponse.body.getReader();
    const decoder = new TextDecoder();
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
        const result = processResponseBuffer(model.provider, chunk);
        if (result && result.content && result.content.length > 0) {
          for (const textContent of result.content) {
            sendSSE(clientRes, 'chunk', { content: textContent });
            fullResponse += textContent;
          }
        }
        if (result && result.thinking && result.thinking.length > 0) {
          for (const thought of result.thinking) {
            sendSSE(clientRes, 'thinking', { thought });
          }
        }
        if (result && result.error) {
          await logInteraction('chat_error', buildLogData(true, {
            responseType: 'error',
            error: { message: result.errorMessage || 'Error processing response', code: 'PROCESSING_ERROR' },
            response: fullResponse
          }));
          sendSSE(clientRes, 'error', { message: result.errorMessage || 'Error processing response' });
          finishReason = 'error';
          break;
        }
        if (result && result.finishReason) {
          finishReason = result.finishReason;
        }
        if (result && result.complete) {
          sendSSE(clientRes, 'done', { finishReason });
          doneEmitted = true;
          await logInteraction('chat_response', buildLogData(true, { responseType: 'success', response: fullResponse }));
          const completionTokens = estimateTokens(fullResponse);
          await recordChatResponse({ userId: baseLog.userSessionId, appId: baseLog.appId, modelId: model.id, tokens: completionTokens });
          break;
        }
      }
    } catch (error) {
      if (error.name !== 'AbortError') {
        const errorMessage = await getLocalizedError('responseStreamError', { error: error.message }, clientLanguage);
        sendSSE(clientRes, 'error', { message: errorMessage });
        finishReason = 'error';
      }
    } finally {
      if (!doneEmitted) {
        sendSSE(clientRes, 'done', { finishReason: finishReason || 'connection_closed' });
      }
      activeRequests.delete(chatId);
    }
  }).catch(async (error) => {
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
      sendSSE(clientRes, 'error', errorMessage);
    }
    activeRequests.delete(chatId);
  });
}

// Internal helper to perform a single non-streaming request and return JSON
async function fetchJsonWithTimeout(request, DEFAULT_TIMEOUT) {
  let timeoutId;
  const timeoutPromise = new Promise((_, reject) => {
    timeoutId = setTimeout(() => {
      reject(new Error(`Request timed out after ${DEFAULT_TIMEOUT/1000} seconds`));
    }, DEFAULT_TIMEOUT);
  });

  const responsePromise = fetch(request.url, {
    method: 'POST',
    headers: request.headers,
    body: JSON.stringify(request.body)
  });

  const llmResponse = await Promise.race([responsePromise, timeoutPromise]);
  clearTimeout(timeoutId);

  if (!llmResponse.ok) {
    const errorBody = await llmResponse.text();
    const err = new Error(`LLM API request failed with status ${llmResponse.status}`);
    err.code = llmResponse.status.toString();
    err.details = errorBody;
    throw err;
  }

  return llmResponse.json();
}

// Execute a request with potential tool calls
export async function processChatWithTools({
  prep,
  res,
  clientRes = null,
  chatId = null,
  buildLogData,
  messageId,
  DEFAULT_TIMEOUT,
  getLocalizedError,
  clientLanguage
}) {
  console.log('Preparing to process chat with tools:', prep);
  const { request, model, llmMessages, tools, apiKey, temperature, maxTokens } = prep;

  try {
    console.log('Processing chat with tools:', {
      modelId: model.id,
      provider: model.provider,
      messages: llmMessages,
      tools: tools.map(t => t.id),
      temperature,
      maxTokens
    });
    const firstResponse = await fetchJsonWithTimeout(request, DEFAULT_TIMEOUT);
    console.log('Received first response:', {
      modelId: model.id,
      provider: model.provider,
      response: firstResponse
    });
    // Normalize the response structure across providers
    let choice;
    if (model.provider === 'google' && firstResponse.candidates) {
      const candidate = firstResponse.candidates[0];
      choice = {
        message: {
          content: candidate.content?.parts
            ?.map(p => p.text || '')
            .join('') || ''
        },
        finish_reason: candidate.finishReason
      };
      // Map Gemini functionCall to OpenAI-style tool_calls array
      const fnCall = candidate.content?.parts?.find(p => p.functionCall);
      if (fnCall) {
        choice.message.tool_calls = [
          {
            id: 'tool_call_1',
            function: {
              name: fnCall.functionCall.name,
              arguments: JSON.stringify(fnCall.functionCall.args || {})
            }
          }
        ];
        choice.finish_reason = 'tool_calls';
      }
    } else if (firstResponse.choices) {
      choice = firstResponse.choices[0];
    }
    //FIX choice can't be logged, because it contains an object
    console.log('Choice after normalization:', JSON.stringify(choice));
    if (choice && choice.finish_reason === 'tool_calls' && choice.message?.tool_calls?.length > 0) {
      const toolCalls = choice.message.tool_calls;
      console.log('Processing tool calls:', toolCalls);

      llmMessages.push({ role: 'assistant', content: choice.message.content, tool_calls: toolCalls });

      for (const call of toolCalls) {
        const toolId = tools.find(t => normalizeName(t.id) === call.function.name)?.id || call.function.name;
        let args = {};
        try {
          args = JSON.parse(call.function.arguments || '{}');
        } catch (e) {
          console.error('Failed to parse tool arguments', e);
        }
        args.chatId = chatId;
        console.log(`Running tool ${toolId} with args:`, args);
        const result = await runTool(toolId, { ...args, chatId });

        // Log tool usage including input and output for tracking
        await logInteraction('tool_usage', buildLogData(!!clientRes, {
          toolId,
          toolInput: args,
          toolOutput: result
        }));

        llmMessages.push({
          role: 'tool',
          tool_call_id: call.id,
          name: call.function.name,
          content: JSON.stringify(result)
        });
      }

      const followRequest = createCompletionRequest(model, llmMessages, apiKey, {
        temperature,
        maxTokens,
        stream: !!clientRes,
        tools
      });

      if (clientRes) {
        return executeStreamingResponse({
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
      }

      return executeNonStreamingResponse({
        request: followRequest,
        res,
        buildLogData,
        messageId,
        model,
        llmMessages,
        DEFAULT_TIMEOUT
      });
    }

    // No tool calls - return or stream the first response
    if (clientRes) {
      const content = choice?.message?.content || '';
      sendSSE(clientRes, 'chunk', { content });
      sendSSE(clientRes, 'done', {});
      await logInteraction('chat_response', buildLogData(true, { responseType: 'success', response: content.substring(0, 1000) }));
      return;
    }

    firstResponse.messageId = messageId;
    await logInteraction('chat_response', buildLogData(false, { responseType: 'success', response: choice?.message?.content?.substring(0, 1000) || '' }));
    return res.json(firstResponse);
  } catch (error) {
    const errorDetails = getErrorDetails(error, model);
    let localizedMessage = errorDetails.message;
    if (error.code) {
      const translated = await getLocalizedError(error.code, {}, clientLanguage);
      if (translated && !translated.startsWith('Error:')) {
        localizedMessage = translated;
      }
    }

    if (clientRes) {
      const errMsg = {
        message: localizedMessage,
        code: error.code || errorDetails.code,
        modelId: model.id,
        provider: model.provider,
        recommendation: errorDetails.recommendation,
        details: error.details || error.message
      };
      sendSSE(clientRes, 'error', errMsg);
    } else {
      return res.status(500).json({
        error: localizedMessage,
        code: error.code || errorDetails.code,
        modelId: model.id,
        provider: model.provider,
        recommendation: errorDetails.recommendation,
        details: error.details || error.message
      });
    }
  }
}
