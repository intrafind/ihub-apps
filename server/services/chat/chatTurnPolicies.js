// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * The policies of a chat turn: its tool rounds, the wall-clock ceiling of a
 * durable turn, compaction, how the tool calls of a step run, the model that
 * writes findings digests, and usage as it goes on the wire.
 *
 * A chat turn (`services/run/hosts/ChatHost.js`) and an app run on the run
 * service (`services/run/RunService.js`) read them. They live in a module of
 * their own so neither needs `ChatService.js` for them: the chat host and the
 * run service import no module that imports them back.
 *
 * @module services/chat/chatTurnPolicies
 */
import configCache from '../../configCache.js';
import { isFeatureEnabled } from '../../featureRegistry.js';
import { OPTIONAL_COUNTERS } from '../loop/llmUsage.js';
import { resolveTitleModel } from './chatTitles.js';
import { chatCompactionSettings } from './chatPersistence.js';
import modelDiscoveryService from '../ModelDiscoveryService.js';

/** The log component of a chat turn, whichever module writes the line. */
export const COMPONENT = 'ChatService';

/**
 * Tool rounds per chat turn (the loop forces a final answer on the last one).
 * Sized for multi-step web research (several searches plus reading the most
 * relevant pages with the page reader easily takes more than ten rounds) and for
 * resumable batch tools such as the website corpus crawl, which needs one round
 * per batch of pages.
 */
export const CHAT_MAX_TOOL_ROUNDS = 50;

/**
 * Wall-clock ceiling on a durable chat turn.
 *
 * An interactive turn has an implicit one: the browser goes away and the
 * disconnect aborts it. Durability removes exactly that, on purpose — the
 * answer has to survive a closed tab — which also removes the only thing that
 * ever ended a wedged turn. A tool that never returns then holds the request
 * entry, the cluster-wide durable mark and the provider connection for the
 * life of the process, and the chat stays `running` forever, so every reopen
 * replays a dead run and spins on an empty placeholder. There is nobody left
 * to press Stop.
 *
 * An app run without a client on the run service (`services/run/RunService.js`)
 * already carries a deadline for the same reason; this is the chat path's.
 *
 * Half an hour rather than that run's three minutes: a durable turn
 * is meant to be waited out across a commute, and killing a legitimate long
 * agentic turn is a worse failure than a wedged one taking thirty minutes to
 * clear. When it does fire, the loop aborts with a budget error, the turn is
 * stored as failed and the run is released — so the chat comes unstuck and
 * says what happened, rather than spinning.
 *
 * It is deliberately not applied to interactive turns: those are bounded by
 * their client, and a user watching a long tool chain must not have it cut
 * short by a ceiling that exists for absent clients.
 */
export const DURABLE_TURN_WALL_CLOCK_MS = 30 * 60 * 1000;

/**
 * Floor for the chat compaction threshold, and the share of a model's context
 * window a chat turn may fill before old tool output is collapsed.
 *
 * The loop's flat 16k default is sized for workflow nodes. Chat turns carry
 * websearch results and extracted pages, so on a 128k-1M window model that
 * default collapsed still-relevant tool output into a 200-char preview and
 * visibly shrank answers. Scaling with the window keeps the depth while still
 * bounding the O(N^2) prompt growth compaction exists to prevent; half the
 * window leaves ample room for the reply and the system prompt.
 */
export const CHAT_COMPACT_MIN_TOKENS = 16000;
const CHAT_COMPACT_WINDOW_SHARE = 0.5;

/**
 * Compaction threshold for a chat turn on `model`.
 *
 * A configured contextWindow always wins — operators lower it deliberately.
 * Only when the model declares none do we fall back to the context length
 * discovery saw on the endpoint (vLLM's `max_model_len`), and to the floor
 * when that is unknown too.
 *
 * @param {{contextWindow?: number, id?: string}} model - resolved model config
 * @returns {number} threshold in estimated tokens
 */
export function chatCompactThresholdTokens(model) {
  let window = Number(model?.contextWindow);
  if ((!Number.isFinite(window) || window <= 0) && model?.id) {
    window = Number(modelDiscoveryService.getDiscoveredContextWindow(model.id));
  }
  if (!Number.isFinite(window) || window <= 0) return CHAT_COMPACT_MIN_TOKENS;
  return Math.max(CHAT_COMPACT_MIN_TOKENS, Math.floor(window * CHAT_COMPACT_WINDOW_SHARE));
}

/**
 * Context policies of a chat turn: the threshold above, and tool results
 * condensed into a findings digest instead of collapsed to previews (#3819),
 * so a long research turn keeps what it found and the model does not search
 * again.
 *
 * @param {Object} model - resolved model config
 * @returns {Object} `policies.context`
 */
export function chatContextPolicies(model) {
  return { compactThresholdTokens: chatCompactThresholdTokens(model), strategy: 'digest' };
}

/**
 * How a chat turn (and an app run as a tool) runs the tool calls of one model
 * step (`policies.tools`).
 *
 * One call at a time, as always, unless the feature `parallelToolCalls` is on
 * and the model does not opt out (`parallelToolCalls: false` in its config):
 * then the calls of a step that are all trusted reads run side by side, at
 * most four at once (`segmentPlanner`, mode `readOnly`). A call that changes
 * something, asks a person or needs an approval makes its step serial again.
 *
 * @param {Object} params
 * @param {Object} params.app - the app (its `toolChoice`)
 * @param {Object} [params.model] - resolved model config
 * @param {Object} [params.features] - feature configuration (default: the cached one)
 * @returns {Object} `policies.tools`
 * @example
 * chatToolPolicies({ app: {}, model: { id: 'm' }, features: {} })
 * // → { parallel: false, choice: undefined }
 */
export function chatToolPolicies({ app, model, features = configCache.getFeatures() }) {
  const sideBySide =
    isFeatureEnabled('parallelToolCalls', features) && model?.parallelToolCalls !== false;
  return sideBySide
    ? { parallel: true, parallelMode: 'readOnly', maxParallel: 4, choice: app?.toolChoice }
    : { parallel: false, choice: app?.toolChoice };
}

/**
 * The model that writes a chat turn's findings digests (#3819): the one an
 * admin set (`chats.compaction.modelId`) when this user may use it, else the
 * chat's own model. Chosen like the chat-title model: a configured model the
 * user's groups do not allow is never used.
 *
 * @param {Object} params
 * @param {Object} params.model - the chat's model
 * @param {Object} [params.user]
 * @param {Object} [params.platform] - platform configuration (default: the cached one)
 * @returns {Object} resolved model config
 */
export function chatCompactionModel({ model, user, platform = configCache.getPlatform?.() }) {
  const { modelId } = chatCompactionSettings(platform || {});
  if (!modelId || modelId === model?.id) return model;
  return resolveTitleModel({ configuredId: modelId, chatModel: model, user }) || model;
}

/**
 * Usage as carried on the wire (contract fields only): the three counters,
 * the optional provider counters (cache read/write, reasoning, web searches)
 * when reported, and the source.
 */
export function wireUsage(usage) {
  if (!usage) return undefined;
  const out = {
    promptTokens: usage.promptTokens || 0,
    completionTokens: usage.completionTokens || 0,
    totalTokens: usage.totalTokens || (usage.promptTokens || 0) + (usage.completionTokens || 0)
  };
  for (const key of OPTIONAL_COUNTERS) {
    if (Number.isInteger(usage[key]) && usage[key] >= 0) out[key] = usage[key];
  }
  if (usage.source === 'provider' || usage.source === 'estimate' || usage.source === 'mixed') {
    out.source = usage.source;
  }
  return out;
}
