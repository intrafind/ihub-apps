import { estimateTokens, recordChatRequest, recordChatResponse } from '../../usageTracker.js';
import { getGenAIInstrumentation } from '../../telemetry.js';
import {
  recordAppUsage,
  recordConversation,
  recordError,
  recordStreamOutcome
} from '../../telemetry/metrics.js';
import activityTracker from '../../telemetry/ActivityTracker.js';
import { resolveProviderName, resolveOperation } from '../../telemetry/providerMap.js';

/**
 * Merge usage data from streaming chunks, preferring non-zero values from incoming data.
 * Handles Anthropic's split delivery (prompt tokens in message_start, completion in message_delta).
 */
export function mergeUsage(existing, incoming) {
  if (!incoming) return existing;
  if (!existing) return { ...incoming };
  return {
    promptTokens: incoming.promptTokens || existing.promptTokens,
    completionTokens: incoming.completionTokens || existing.completionTokens,
    totalTokens: incoming.totalTokens || existing.totalTokens
  };
}

/**
 * Record request-side usage/telemetry for one LLM HTTP round-trip and open its
 * OTel span. Call once per LLM call — including once per iteration of a
 * tool-calling loop, since each iteration is its own billable request.
 * @returns {Object} context to pass to recordLLMCallCompletion/finalizeLLMCallTelemetry
 */
export async function beginLLMCallTelemetry({ request, chatId, buildLogData, model, llmMessages }) {
  const baseLog = buildLogData(true);
  const promptTokens = llmMessages
    .map(m => estimateTokens(m.content || ''))
    .reduce((a, b) => a + b, 0);

  await recordChatRequest({
    userId: baseLog.userSessionId,
    appId: baseLog.appId,
    modelId: model.id,
    tokens: promptTokens,
    tokenSource: 'estimate',
    user: baseLog.user
  });

  activityTracker.recordActivity({
    userId: baseLog.user?.id || baseLog.userSessionId,
    chatId
  });

  if (baseLog.appId) {
    // Standard gen_ai.* keys so the metrics.js allow-list passes them through
    // as labels. Per-user / per-chat / per-message dimensions are intentionally
    // span-only.
    const sharedMetricLabels = {
      'gen_ai.provider.name': resolveProviderName(model.provider),
      'gen_ai.request.model': model.modelId
    };
    recordAppUsage(baseLog.appId, baseLog.user?.id || baseLog.userSessionId, sharedMetricLabels);
    recordConversation(chatId, llmMessages.length > 2, {
      'app.id': baseLog.appId,
      ...sharedMetricLabels
    });
  }

  const instrumentation = getGenAIInstrumentation();
  let llmSpan = null;
  const spanStart = Date.now();
  if (instrumentation && instrumentation.isEnabled()) {
    const operation = resolveOperation(model.provider);
    const providerName = resolveProviderName(model.provider);
    llmSpan = instrumentation.createLLMSpan(operation, model, providerName, {
      appId: baseLog.appId,
      userId: baseLog.user?.id || baseLog.userSessionId,
      chatId,
      messageCount: llmMessages.length,
      isFollowUp: llmMessages.length > 2
    });
    const requestOptions = {
      temperature: request.body?.temperature,
      maxTokens: request.body?.max_tokens || request.body?.maxOutputTokens,
      topP: request.body?.top_p,
      stream: true
    };
    instrumentation.recordRequest(llmSpan, model, llmMessages, requestOptions);
  }

  return { baseLog, promptTokens, instrumentation, llmSpan, spanStart };
}

/**
 * Record completion-token usage once the provider signals a completed answer
 * (a `result.complete` chunk). Call at most once per LLM call, only on the
 * success path — finalizeLLMCallTelemetry records the stream outcome either way.
 */
export async function recordLLMCallCompletion(ctx, { model, accumulatedUsage, fullResponseText }) {
  const completionTokens = accumulatedUsage?.completionTokens ?? estimateTokens(fullResponseText);
  const tokenSource = accumulatedUsage ? 'provider' : 'estimate';
  await recordChatResponse({
    userId: ctx.baseLog.userSessionId,
    appId: ctx.baseLog.appId,
    modelId: model.id,
    tokens: completionTokens,
    tokenSource,
    user: ctx.baseLog.user
  });
}

/**
 * Close out an LLM call's OTel span, error metric, and stream-outcome metric.
 * Call exactly once per call, in a finally block, regardless of how it ended.
 * @param {Object} ctx - the object returned by beginLLMCallTelemetry
 * @param {Error} [options.error] - set when the call is being finalized from a catch block;
 *   ends the span with the error and records an error metric before the outcome metric.
 */
export function finalizeLLMCallTelemetry(
  ctx,
  { model, finishReason, doneEmitted, accumulatedUsage, error }
) {
  const { baseLog, instrumentation, spanStart } = ctx;
  let { llmSpan } = ctx;

  if (error) {
    if (instrumentation && llmSpan) {
      const duration = (Date.now() - spanStart) / 1000;
      instrumentation.endSpan(llmSpan, error, duration);
      llmSpan = null;
    }
    if (baseLog.appId) {
      recordError(error.name || 'Error', 'llm_call_streaming', {
        'app.id': baseLog.appId,
        'gen_ai.provider.name': resolveProviderName(model.provider),
        'gen_ai.request.model': model.modelId
      });
    }
  }

  // Aborts come from the request's own AbortController (client disconnect or
  // our own timeout), normal completion from the model emitting a stop finish
  // reason. Translate finishReason into one of {completed, aborted, error} so
  // dashboards can distinguish "user closed the tab" from "model returned
  // cleanly."
  const streamOutcome = finishReason === 'error' ? 'error' : doneEmitted ? 'completed' : 'aborted';
  if (baseLog.appId) {
    recordStreamOutcome(streamOutcome, {
      'app.id': baseLog.appId,
      'gen_ai.provider.name': resolveProviderName(model.provider),
      'gen_ai.request.model': model.modelId
    });
  }

  if (instrumentation && llmSpan) {
    const duration = (Date.now() - spanStart) / 1000;
    const usage = accumulatedUsage
      ? {
          inputTokens: accumulatedUsage.promptTokens,
          outputTokens: accumulatedUsage.completionTokens
        }
      : undefined;
    instrumentation.recordResponse(
      llmSpan,
      {
        finishReasons: finishReason ? [finishReason] : undefined,
        model: model.modelId
      },
      usage
    );
    instrumentation.endSpan(llmSpan, null, duration);
  }
}
