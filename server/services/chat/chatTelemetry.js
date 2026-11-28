// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * Chat-turn metrics bookkeeping — one record per model call.
 *
 * Usage analytics are not recorded here: `LLMClient` writes one call record
 * per model call for every surface (services/usage/usageRecorder.js). This
 * module only records what the chat surface adds on top: user activity,
 * per-app metrics and the stream outcome (OpenTelemetry).
 *
 * @module services/chat/chatTelemetry
 */
import {
  recordAppUsage,
  recordConversation,
  recordError,
  recordStreamOutcome
} from '../../telemetry/metrics.js';
import activityTracker from '../../telemetry/ActivityTracker.js';
import { resolveProviderName } from '../../telemetry/providerMap.js';
import configCache from '../../configCache.js';
import { currentClientChannel } from '../../telemetry/channel.js';

function providerLabels(model) {
  return {
    'gen_ai.provider.name': resolveProviderName(model.provider),
    'gen_ai.request.model': model.modelId
  };
}

/**
 * The surface and client channel of a chat model call (`ihub.surface`,
 * `ihub.client.channel`): the inference API, MCP and A2A are `api`; a call
 * outside any request (a scheduled task) is `task`; everything else `chat`.
 *
 * @param {Object} baseLog
 * @returns {{'ihub.surface': string, 'ihub.client.channel': string}}
 */
function surfaceLabels(baseLog) {
  const channel = currentClientChannel({
    user: baseLog?.user,
    platform: configCache.getPlatform?.()
  });
  let surface = 'chat';
  if (channel === 'openai_proxy' || channel === 'mcp' || channel === 'a2a') surface = 'api';
  else if (channel === 'system') surface = 'task';
  return { 'ihub.surface': surface, 'ihub.client.channel': channel };
}

/**
 * Start one model call: user activity and app usage / conversation metrics.
 * Call once per model call — including once per round of a tool loop.
 *
 * @param {Object} params
 * @param {Object} params.baseLog - `buildLogData()` output (appId, user, userSessionId)
 * @param {string} params.chatId
 * @param {Object} params.model
 * @param {Array} params.messages - messages sent on this call
 */
export async function recordChatCallStart({ baseLog, chatId, model, messages }) {
  activityTracker.recordActivity({
    userId: baseLog.user?.id || baseLog.userSessionId,
    chatId
  });
  if (baseLog.appId) {
    const shared = { ...providerLabels(model), ...surfaceLabels(baseLog) };
    recordAppUsage(baseLog.appId, baseLog.user?.id || baseLog.userSessionId, shared);
    recordConversation(chatId, (messages?.length || 0) > 2, { 'app.id': baseLog.appId, ...shared });
  }
}

/**
 * Record the end of a model call or turn: the stream outcome metric, and the
 * error metric for a failed one.
 *
 * @param {Object} params
 * @param {Object} params.baseLog
 * @param {Object} params.model
 * @param {'completed'|'aborted'|'error'} params.outcome
 * @param {Error} [params.error]
 */
export async function recordChatCallEnd({ baseLog, model, outcome, error }) {
  if (baseLog.appId && model) {
    const labels = { 'app.id': baseLog.appId, ...providerLabels(model), ...surfaceLabels(baseLog) };
    if (error) recordError(error.name || 'Error', 'llm_call_streaming', labels);
    recordStreamOutcome(outcome, labels);
  }
}
