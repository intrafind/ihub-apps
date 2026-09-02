/**
 * Chat-turn usage and metrics bookkeeping — one record per model call.
 *
 * The OpenTelemetry span for a model call is owned by `LLMClient`; this module
 * only records what the chat surface adds on top: usage tracking
 * (`usageTracker`), user activity, per-app metrics and the stream outcome.
 *
 * @module services/chat/chatTelemetry
 */
import { estimateTokens, recordChatRequest, recordChatResponse } from '../../usageTracker.js';
import {
  recordAppUsage,
  recordConversation,
  recordError,
  recordStreamOutcome
} from '../../telemetry/metrics.js';
import activityTracker from '../../telemetry/ActivityTracker.js';
import { resolveProviderName } from '../../telemetry/providerMap.js';

function providerLabels(model) {
  return {
    'gen_ai.provider.name': resolveProviderName(model.provider),
    'gen_ai.request.model': model.modelId
  };
}

function estimatePromptTokens(messages) {
  return (Array.isArray(messages) ? messages : [])
    .map(m => estimateTokens(typeof m?.content === 'string' ? m.content : ''))
    .reduce((a, b) => a + b, 0);
}

/**
 * Record the request side of one model call: estimated prompt tokens, user
 * activity and app usage / conversation metrics. Call once per model call —
 * including once per round of a tool loop, since each round is billable.
 *
 * @param {Object} params
 * @param {Object} params.baseLog - `buildLogData()` output (appId, user, userSessionId)
 * @param {string} params.chatId
 * @param {Object} params.model
 * @param {Array} params.messages - messages sent on this call
 * @returns {Promise<{promptTokens:number}>}
 */
export async function recordChatCallStart({ baseLog, chatId, model, messages }) {
  const promptTokens = estimatePromptTokens(messages);
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
    const shared = providerLabels(model);
    recordAppUsage(baseLog.appId, baseLog.user?.id || baseLog.userSessionId, shared);
    recordConversation(chatId, (messages?.length || 0) > 2, { 'app.id': baseLog.appId, ...shared });
  }
  return { promptTokens };
}

/**
 * Record the response side of one model call: completion tokens (provider
 * usage when reported, estimated otherwise) and the stream outcome metric.
 *
 * @param {Object} params
 * @param {Object} params.baseLog
 * @param {Object} params.model
 * @param {Object|null} [params.usage] - normalized usage of this call
 * @param {string} [params.content] - text produced by this call (for the estimate)
 * @param {'completed'|'aborted'|'error'} params.outcome
 * @param {Error} [params.error]
 */
export async function recordChatCallEnd({ baseLog, model, usage, content, outcome, error }) {
  if (outcome === 'completed') {
    const completionTokens = usage?.completionTokens ?? estimateTokens(content || '');
    await recordChatResponse({
      userId: baseLog.userSessionId,
      appId: baseLog.appId,
      modelId: model.id,
      tokens: completionTokens,
      tokenSource: usage ? 'provider' : 'estimate',
      user: baseLog.user
    });
  }
  if (baseLog.appId) {
    const labels = { 'app.id': baseLog.appId, ...providerLabels(model) };
    if (error) recordError(error.name || 'Error', 'llm_call_streaming', labels);
    recordStreamOutcome(outcome, labels);
  }
}
