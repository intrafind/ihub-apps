// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * ChatService — one chat turn on the shared agent loop.
 *
 * `prepareChatRequest` resolves app, model, messages and tools
 * (`RequestBuilder`); `runTurn` runs the turn through `AgentLoop` and projects
 * it onto SSE v2 frames via `chatChannel` / `chatSeams` (one run per turn,
 * `run/started` … `run/ended`); the turn itself is `ChatHost`
 * (`services/run/hosts/ChatHost.js`), which uses this service as its
 * collaborator. An app that runs without a client (called as
 * a tool, through the MCP gateway or by an A2A agent) runs on the run service
 * (`services/run/RunService.js`), which prepares it here. There is no
 * chat-specific model loop any more: budgets, tool execution, argument
 * repair, compaction and abort handling are the loop's.
 *
 * @module services/chat/ChatService
 */
import { v4 as uuidv4 } from 'uuid';
import RequestBuilder from './RequestBuilder.js';
import { processMessageTemplates } from '../../serverHelpers.js';
import { logInteraction as defaultLogInteraction } from '../../utils.js';
import { ToolRunner } from '../run/ToolRunner.js';
import { ChatHost } from '../run/hosts/ChatHost.js';
import configCache from '../../configCache.js';
import { isFeatureEnabled } from '../../featureRegistry.js';
import PromptService from '../PromptService.js';
import logger from '../../utils/logger.js';
import defaultAgentLoop from '../loop/AgentLoop.js';
import { OPTIONAL_COUNTERS } from '../loop/llmUsage.js';
import runLogSingleton from '../loop/RunLog.js';
import interactionServiceSingleton from '../loop/InteractionService.js';
import { MODEL_KNOWLEDGE_SOURCE, RUN_LOG_EVENTS } from '../../../shared/runEvents.js';
import { boundCarriedBasis } from './answerBasis.js';
import { pausedTurnQuestion, pausedTurnTranscript } from './chatToolApproval.js';
import { buildPendingConnect } from './chatConnectResume.js';
import { resolveTitleModel } from './chatTitles.js';
import { chatCompactionSettings } from './chatPersistence.js';
import * as defaultTelemetry from './chatTelemetry.js';
import modelDiscoveryService from '../ModelDiscoveryService.js';

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
 * Cap on tracked chatIds in the clarification counter. The service is a
 * process-wide singleton with no "conversation ended" signal, so the map is
 * bounded (insertion-ordered, evict-oldest) — mirrors searchCache.js.
 */
const MAX_CHAT_ENTRIES = 5000;

/**
 * Attach app variables and the app's prompt template to the last user message
 * (where PromptService reads them).
 *
 * `PromptService.processMessageTemplates` only interpolates an app's `prompt`
 * when the message carries it as `promptTemplate` — the browser client puts it
 * there. Headless callers (MCP gateway, A2A, app-as-tool) build their messages
 * themselves, so without this the template and every declared variable were
 * silently dropped and the model saw only the raw message.
 */
export function withAppPrompt(messages, variables, promptTemplate) {
  const list = Array.isArray(messages) ? messages : [];
  const hasVariables = variables && Object.keys(variables).length > 0;
  if (!hasVariables && !promptTemplate) return list;
  let lastUser = -1;
  for (let i = list.length - 1; i >= 0; i--) {
    if (list[i]?.role === 'user') {
      lastUser = i;
      break;
    }
  }
  if (lastUser < 0) return list;
  return list.map((m, i) =>
    i === lastUser
      ? {
          ...m,
          variables: { ...m.variables, ...variables },
          ...(m.promptTemplate ? {} : { promptTemplate: promptTemplate || null })
        }
      : m
  );
}

/**
 * Usage as carried on the wire (contract fields only): the three counters,
 * the optional provider counters (cache read/write, reasoning, web searches)
 * when reported, and the source.
 */
/** The error of a run's end record, or nothing for a run that did not fail. */
function ledgerError(error) {
  if (!error) return {};
  return {
    error: { code: String(error.code || 'ERROR'), message: String(error.message || error) }
  };
}

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

class ChatService {
  /**
   * @param {Object} [options]
   * @param {RequestBuilder} [options.requestBuilder]
   * @param {import('../loop/AgentLoop.js').AgentLoop} [options.agentLoop]
   * @param {import('../loop/RunLog.js').RunLog} [options.runLog]
   * @param {Function} [options.logInteraction] - interaction logger (tests inject a spy)
   * @param {Function} [options.runTool] - `runTool` behind the tool runner (tests inject a stub)
   * @param {ToolRunner} [options.toolRunner] - the tool runner (defaults to one around `runTool`)
   * @param {{recordChatCallStart: Function, recordChatCallEnd: Function}} [options.telemetry] -
   *   usage/metrics recorder (defaults to chatTelemetry.js)
   */
  constructor(options = {}) {
    this.requestBuilder = options.requestBuilder || new RequestBuilder();
    this.agentLoop = options.agentLoop || defaultAgentLoop;
    this.runLog = options.runLog || runLogSingleton;
    this.interactionService = options.interactionService || interactionServiceSingleton;
    this.logInteraction = options.logInteraction || defaultLogInteraction;
    this.toolRunner = options.toolRunner || new ToolRunner({ runTool: options.runTool });
    this.telemetry = options.telemetry || defaultTelemetry;
    /** @type {Map<string, number>} clarification count per conversation */
    this.clarificationCounts = new Map();
  }

  async prepareChatRequest(params) {
    // The knowledge scope is noted under this preparation, not the chat: a
    // turn prepared while another one of the chat still awaits its tools
    // and API key must not take, or overwrite, the other one's scope.
    const preparationId = uuidv4();
    // How the refresh of outdated project documents this turn waits for
    // advances (#3622): the chat route shows it on the stream.
    const { onKnowledgeRefresh, ...request } = params || {};
    if (typeof onKnowledgeRefresh === 'function') {
      PromptService.watchKnowledgeRefresh(preparationId, onKnowledgeRefresh);
    }
    let result;
    try {
      result = await this.requestBuilder.prepareChatRequest({
        ...request,
        preparationId,
        processMessageTemplates
      });
    } finally {
      PromptService.unwatchKnowledgeRefresh(preparationId);
    }
    // `PromptService` notes the app sources it loaded under the chat id while
    // the prompt is built. Take them with this request: a turn then reports
    // its own sources, never those of a newer turn on the same chat that was
    // prepared while it still ran (and superseded it).
    const promptSources = PromptService.getPromptSources(params?.chatId);
    PromptService.resetPromptSources(params?.chatId);
    const knowledgeScope = PromptService.takeKnowledgeScope(preparationId);
    if (result?.success && result.data) {
      result.data.promptSources = promptSources;
      if (knowledgeScope) result.data.knowledgeScope = knowledgeScope;
    }
    return result;
  }

  // ── clarification bookkeeping ──────────────────────────────────────────

  getClarificationCount(chatId) {
    return this.clarificationCounts.get(chatId) || 0;
  }

  incrementClarificationCount(chatId) {
    const next = this.getClarificationCount(chatId) + 1;
    if (
      !this.clarificationCounts.has(chatId) &&
      this.clarificationCounts.size >= MAX_CHAT_ENTRIES
    ) {
      const oldest = this.clarificationCounts.keys().next().value;
      if (oldest !== undefined) this.clarificationCounts.delete(oldest);
    }
    this.clarificationCounts.set(chatId, next);
    return next;
  }

  // ── knowledge sources (answer-source badge) ────────────────────────────

  /**
   * The knowledge sources to report on a terminal answer (`run/ended`): what
   * the loop recorded (tools, grounding, uploads, email context) plus the app
   * sources this turn's prompt was built with (`prep.promptSources`).
   *
   * A model's answer that drew on nothing else is named as the model's own
   * knowledge, so the client never has to infer it from a missing list. A
   * passthrough answer is the tool's output, not the model's (`byModel: false`),
   * and is named by the sources it used alone.
   */
  resolveAnswerSources(loopSources = [], promptSources = [], { byModel = true } = {}) {
    const sources = Array.from(new Set([...(loopSources || []), ...(promptSources || [])]));
    return sources.length > 0 || !byModel ? sources : [MODEL_KNOWLEDGE_SOURCE];
  }

  // ── ledger ─────────────────────────────────────────────────────────────

  async _startLedgerRun({ runId, kind, user, refs, model, language, parentRunId, trigger }) {
    try {
      await this.runLog.startRun({
        runId,
        kind,
        user,
        refs,
        model: model?.id,
        language,
        ...(parentRunId ? { parentRunId } : {}),
        ...(trigger ? { trigger } : {})
      });
    } catch (err) {
      logger.warn('Run ledger start failed', { component: COMPONENT, runId, error: err.message });
    }
  }

  /**
   * Append the run's `message/user` event.
   *
   * Nothing else in the tree produces one for a real user turn — the only
   * other emitter covers synthetic steer messages — so without this a run's
   * ledger records every answer and none of the questions, and the turn cannot
   * be replayed as a conversation. Appended only for durable turns: chat
   * persistence implies the ledger is on, and off it there is nobody to read
   * the event back.
   * @private
   */
  _appendUserMessageEvent({ runId, messageId, content, attachments }) {
    try {
      this.runLog.append(runId, RUN_LOG_EVENTS.MESSAGE_USER, {
        step: 0,
        ...(messageId ? { messageId: String(messageId) } : {}),
        content: typeof content === 'string' ? content : '',
        ...(attachments.length > 0 ? { attachments } : {})
      });
    } catch (err) {
      logger.warn('Run ledger user message failed', {
        component: COMPONENT,
        runId,
        error: err.message
      });
    }
  }

  /**
   * The answer of a turn the chat was claimed for that yielded to a newer turn
   * (`runTurn`, `claimed`).
   *
   * @param {string} chatId
   * @param {string} runId
   * @returns {Object}
   */
  _yieldedTurn(chatId, runId) {
    logger.info('Next turn made of messages sent while answering yields to a newer turn', {
      component: COMPONENT,
      chatId,
      runId
    });
    return {
      runId,
      status: 'superseded',
      superseded: true,
      content: '',
      finishReason: 'aborted',
      knowledgeSources: []
    };
  }

  _endLedgerRun(
    runId,
    {
      status,
      finishReason,
      usage,
      error,
      knowledgeSources,
      answerBasis,
      limitReachedIn: limitReached,
      cause,
      provenance,
      startedAt
    }
  ) {
    try {
      this.runLog.endRun(runId, {
        status,
        finishReason: finishReason ?? null,
        usage: wireUsage(usage),
        // What `run/ended` reported, so a replay of the ledger badges the
        // answer the same way the live stream did.
        ...(Array.isArray(knowledgeSources) ? { knowledgeSources } : {}),
        ...(Array.isArray(answerBasis) ? { answerBasis } : {}),
        ...(limitReached ? { limitReachedIn: limitReached } : {}),
        ...(provenance ? { provenance } : {}),
        // Why an aborted turn was stopped (`services/chat/abortCause.js`).
        ...(cause ? { cause } : {}),
        ...ledgerError(error),
        durationMs: Date.now() - startedAt
      });
    } catch (err) {
      logger.warn('Run ledger end failed', { component: COMPONENT, runId, error: err.message });
    }
  }

  /**
   * Continue the paused run a stored turn answers (`RunLog.continueRun`): only
   * a chat run of this chat and app, started with the same model. Null when it
   * cannot be continued; the turn then runs as a run of its own.
   * @private
   */
  async _continueLedgerRun({ runId, interactionId, chatId, appId, modelId }) {
    if (typeof this.runLog.continueRun !== 'function') return null;
    try {
      return await this.runLog.continueRun(runId, {
        interactionId,
        accept: start =>
          start.data?.kind === 'chat' &&
          start.data.refs?.chatId === chatId &&
          (start.data.refs?.appId || null) === (appId || null) &&
          (start.data.model || null) === (modelId || null)
      });
    } catch (err) {
      logger.warn('Paused run could not be continued', {
        component: COMPONENT,
        runId,
        error: err.message
      });
      return null;
    }
  }

  // ── the turn ───────────────────────────────────────────────────────────

  /**
   * Run one chat turn. The turn itself is `ChatHost.runTurn`
   * (`services/run/hosts/ChatHost.js`), which uses this service as its
   * collaborator.
   *
   * @param {Object} params - see `ChatHost.runTurn`
   * @returns {Promise<Object>} see `ChatHost.runTurn`
   */
  async runTurn(params) {
    return new ChatHost(this).runTurn(params);
  }

  /**
   * Keep a paused turn's tool transcript with the chat (`toolApproval.pending`),
   * for the turn that continues it once the approval is answered
   * (see `chatToolApproval.js`). The stored chat transcript holds only text,
   * so this is the one place the call and its sibling results survive.
   *
   * A transcript that cannot be stored leaves the approval unanswerable: the
   * interaction is cancelled so the card does not wait for nothing.
   *
   * @private
   */
  async _storePendingApproval({
    repository,
    chatId,
    runId,
    grants,
    interaction,
    messages,
    startMessage,
    basis = null
  }) {
    const toolCallId = interaction.source?.toolCallId;
    const transcript = toolCallId
      ? pausedTurnTranscript(messages, { startMessage, toolCallId })
      : null;
    const call = transcript
      ?.flatMap(m => (Array.isArray(m.tool_calls) ? m.tool_calls : []))
      .find(c => c?.id === toolCallId);
    let stored = null;
    if (transcript && call) {
      try {
        stored = await repository.updateChat(chatId, {
          toolApproval: {
            grants,
            pending: {
              interactionId: interaction.id,
              runId,
              call: {
                id: toolCallId,
                name: call.function?.name || interaction.source?.toolId,
                toolId: interaction.source?.toolId || call.function?.name,
                args: interaction.prompt?.displayData?.args || {}
              },
              transcript,
              // For an app that sends no chat history: the continuation puts it back.
              question: pausedTurnQuestion(startMessage),
              // The sources the turn had used before it paused, for the basis of the answer.
              ...(basis ? { basis: boundCarriedBasis(basis) } : {}),
              createdAt: new Date().toISOString()
            }
          }
        });
      } catch (error) {
        logger.error('Paused tool approval could not be stored with the chat', {
          component: COMPONENT,
          chatId,
          runId,
          error: error.message
        });
      }
    }
    if (!stored) {
      await this.interactionService.cancel(interaction.id, 'unrecoverable').catch(() => {});
    }
    return Boolean(stored);
  }

  /**
   * Keep the calls that stopped on a missing connection with the chat
   * (`pendingConnect`, see `chatConnectResume.js`). Fail closed: a record that
   * cannot be built whole (cut arguments, an oversized step) or stored simply
   * leaves the Connect card without a resume. Never fatal to the turn.
   *
   * @private
   */
  async _storePendingConnect({
    repository,
    chatId,
    runId,
    user,
    calls,
    messages,
    startMessage,
    continues = [],
    basis = null
  }) {
    // A person with a connection of their own: no record for an anonymous or
    // guest owner (they cannot hold one), nor for a delegated caller.
    if (!user?.id || user.id === 'anonymous') return false;
    try {
      const record = buildPendingConnect({
        runId,
        calls,
        messages,
        startMessage,
        basis,
        continues
      });
      if (!record) {
        logger.info('Failed calls are not resumable after a connect', {
          component: COMPONENT,
          chatId,
          runId,
          calls: calls.length
        });
        return false;
      }
      const stored = await repository.setPendingConnect(chatId, runId, record);
      return Boolean(stored);
    } catch (error) {
      logger.warn('The pending call could not be kept with the chat', {
        component: COMPONENT,
        chatId,
        runId,
        error: error.message
      });
      return false;
    }
  }
}

export default ChatService;
