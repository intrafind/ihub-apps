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
 * Start one model call: user activity and app usage / conversation metrics.
 * Call once per model call — including once per round of a tool loop, since
 * each round is billable.
 *
 * The request side of the usage record is written when the call ends, by
 * `recordChatCallEnd` (or `recordChatCallRequest` for a call that never
 * finished): only then are the provider's prompt and cache counts known. The
 * returned handle carries the estimate to fall back on.
 *
 * @param {Object} params
 * @param {Object} params.baseLog - `buildLogData()` output (appId, user, userSessionId)
 * @param {string} params.chatId
 * @param {Object} params.model
 * @param {Array} params.messages - messages sent on this call
 * @returns {Promise<{promptTokens:number}>} the pending request (estimated prompt tokens)
 */
export async function recordChatCallStart({ baseLog, chatId, model, messages }) {
  const promptTokens = estimatePromptTokens(messages);
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

/** Usage the provider reported (not a local estimate). */
function providerUsage(usage) {
  return usage && usage.source !== 'estimate' ? usage : null;
}

/**
 * Record the request side of one model call: the provider's prompt tokens
 * and prompt-cache counts when it reported them, the estimate taken at the
 * start of the call otherwise (a call that failed or was stopped mid-way).
 *
 * @param {Object} params
 * @param {Object} params.baseLog
 * @param {Object} params.model
 * @param {{promptTokens:number}|null} [params.request] - `recordChatCallStart()` handle
 * @param {Object|null} [params.usage] - normalized usage of this call
 */
export async function recordChatCallRequest({ baseLog, model, request, usage }) {
  const reported = providerUsage(usage);
  const hasPrompt = reported && reported.promptTokens > 0;
  await recordChatRequest({
    userId: baseLog.userSessionId,
    appId: baseLog.appId,
    modelId: model.id,
    tokens: hasPrompt ? reported.promptTokens : request?.promptTokens || 0,
    tokenSource: hasPrompt ? 'provider' : 'estimate',
    ...(hasPrompt
      ? { cacheReadTokens: reported.cacheReadTokens, cacheWriteTokens: reported.cacheWriteTokens }
      : {}),
    provider: model.provider,
    user: baseLog.user
  });
}

/**
 * Record the end of one model call: the request side (see
 * `recordChatCallRequest`, when `request` is given), the response side —
 * completion tokens (provider usage when reported, estimated otherwise) — and
 * the stream outcome metric.
 *
 * @param {Object} params
 * @param {Object} params.baseLog
 * @param {Object} params.model
 * @param {{promptTokens:number}|null} [params.request] - `recordChatCallStart()` handle of
 *   the call ending here; omitted when its request side was already recorded
 * @param {Object|null} [params.usage] - normalized usage of this call
 * @param {string} [params.content] - text produced by this call (for the estimate)
 * @param {'completed'|'aborted'|'error'} params.outcome
 * @param {Error} [params.error]
 */
export async function recordChatCallEnd({
  baseLog,
  model,
  request,
  usage,
  content,
  outcome,
  error
}) {
  if (request) {
    await recordChatCallRequest({
      baseLog,
      model,
      request,
      usage: outcome === 'completed' ? usage : null
    });
  }
  if (outcome === 'completed') {
    const reported = providerUsage(usage);
    const completionTokens = reported?.completionTokens ?? estimateTokens(content || '');
    await recordChatResponse({
      userId: baseLog.userSessionId,
      appId: baseLog.appId,
      modelId: model.id,
      tokens: completionTokens,
      tokenSource: reported ? 'provider' : 'estimate',
      reasoningTokens: reported?.reasoningTokens,
      webSearchRequests: usage?.webSearchRequests || 0,
      provider: model.provider,
      user: baseLog.user
    });
  }
  if (baseLog.appId) {
    const labels = { 'app.id': baseLog.appId, ...providerLabels(model) };
    if (error) recordError(error.name || 'Error', 'llm_call_streaming', labels);
    recordStreamOutcome(outcome, labels);
  }
}
