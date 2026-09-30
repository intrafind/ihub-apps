/**
 * ChatService — one chat turn on the shared agent loop.
 *
 * `prepareChatRequest` resolves app, model, messages and tools
 * (`RequestBuilder`); `runTurn` runs the turn through `AgentLoop` and projects
 * it onto SSE v2 frames via `chatChannel` / `chatSeams` (one run per turn,
 * `run/started` … `run/ended`); `invokeAppInternal` runs an app headlessly
 * (app-as-tool gateway, MCP) and returns the assembled answer. There is no
 * chat-specific model loop any more: budgets, tool execution, argument
 * repair, compaction and abort handling are the loop's.
 *
 * @module services/chat/ChatService
 */
import { v4 as uuidv4 } from 'uuid';
import RequestBuilder from './RequestBuilder.js';
import { processMessageTemplates } from '../../serverHelpers.js';
import { logInteraction as defaultLogInteraction } from '../../utils.js';
import { runTool as defaultRunTool } from '../../toolLoader.js';
import configCache from '../../configCache.js';
import { findByIdCaseInsensitive } from '../../utils/resourceLookup.js';
import { activeRequests, hasChatClient } from '../../sse.js';
import { isFailureFinishReason } from '../../adapters/toolCalling/index.js';
import PromptService from '../PromptService.js';
import logger from '../../utils/logger.js';
import defaultAgentLoop from '../loop/AgentLoop.js';
import { OPTIONAL_COUNTERS } from '../loop/llmUsage.js';
import runLogSingleton, { newRunId, isValidRunId } from '../loop/RunLog.js';
import interactionServiceSingleton from '../loop/InteractionService.js';
import { RunStreamEmitter, bindStreamRun, unbindStreamRun } from '../loop/RunStream.js';
import {
  MODEL_KNOWLEDGE_SOURCE,
  RUN_LOG_EVENTS,
  SSE_V2_EVENTS
} from '../../../shared/runEvents.js';
import {
  imageLiftSeam,
  knowledgeSourceSeam,
  markInteractiveTools,
  passthroughSeam,
  questionSeam,
  structuredOutputSeam
} from '../loop/seams/index.js';
import { createChatChannel } from './chatChannel.js';
import { mergeCitations } from './chatCitations.js';
import { recordRunActivity } from './runActivity.js';
import { createPageReadGate, resolveMaxPageReads } from './pageReadLimit.js';
import { buildWebSearch } from '../../../shared/webCitations.js';
import {
  materializeAssistantTurn,
  materializeUserTurn,
  normalizeAttachments
} from './chatMaterializer.js';
import {
  chatTurnSeam,
  chatToolSeam,
  chatQuestionOptions,
  chatPassthroughOptions
} from './chatSeams.js';
import { describeChatError } from './chatErrors.js';
import { appendSchedulingContextNote } from '../scheduler/tasks/schedulingContext.js';
import * as defaultTelemetry from './chatTelemetry.js';
import modelDiscoveryService from '../ModelDiscoveryService.js';

const COMPONENT = 'ChatService';

/**
 * Tool rounds per chat turn (the loop forces a final answer on the last one).
 * Sized for multi-step web research: several searches plus reading the most
 * relevant pages with the page reader easily takes more than ten rounds.
 */
export const CHAT_MAX_TOOL_ROUNDS = 25;

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
 * `invokeAppInternal`, the other path that runs without a client, already
 * carries a deadline for the same reason; this is the chat path's.
 *
 * Half an hour rather than `invokeAppInternal`'s three minutes: a durable turn
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
/** Aggregate bound on the tool output an app invocation retains for its caller. */
export const APP_INVOKE_COLLECT_CAP_BYTES = 256 * 1024;

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
          variables: { ...(m.variables || {}), ...(variables || {}) },
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
function wireUsage(usage) {
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

const NO_STREAM = { emit: () => null, runId: null };

/**
 * Whether the reader of a durable turn is still there when it ends: the
 * caller's own answer when it supplied one (the inference API knows whether
 * its HTTP client is connected), else an attached SSE client.
 */
function clientConnectedOf(persist, chatId) {
  if (typeof persist?.clientConnected === 'function') {
    try {
      return persist.clientConnected() === true;
    } catch {
      return false;
    }
  }
  return hasChatClient(chatId);
}

class ChatService {
  /**
   * @param {Object} [options]
   * @param {RequestBuilder} [options.requestBuilder]
   * @param {import('../loop/AgentLoop.js').AgentLoop} [options.agentLoop]
   * @param {import('../loop/RunLog.js').RunLog} [options.runLog]
   * @param {Function} [options.logInteraction] - interaction logger (tests inject a spy)
   * @param {Function} [options.runTool] - tool runner (tests inject a stub)
   * @param {{recordChatCallStart: Function, recordChatCallEnd: Function}} [options.telemetry] -
   *   usage/metrics recorder (defaults to chatTelemetry.js)
   */
  constructor(options = {}) {
    this.requestBuilder = options.requestBuilder || new RequestBuilder();
    this.agentLoop = options.agentLoop || defaultAgentLoop;
    this.runLog = options.runLog || runLogSingleton;
    this.interactionService = options.interactionService || interactionServiceSingleton;
    this.logInteraction = options.logInteraction || defaultLogInteraction;
    this.runTool = options.runTool || defaultRunTool;
    this.telemetry = options.telemetry || defaultTelemetry;
    /** @type {Map<string, number>} clarification count per conversation */
    this.clarificationCounts = new Map();
  }

  async prepareChatRequest(params) {
    const result = await this.requestBuilder.prepareChatRequest({
      ...params,
      processMessageTemplates
    });
    // `PromptService` notes the app sources it loaded under the chat id while
    // the prompt is built. Take them with this request: a turn then reports
    // its own sources, never those of a newer turn on the same chat that was
    // prepared while it still ran (and superseded it).
    const promptSources = PromptService.getPromptSources(params?.chatId);
    PromptService.resetPromptSources(params?.chatId);
    if (result?.success && result.data) result.data.promptSources = promptSources;
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

  _endLedgerRun(runId, { status, finishReason, usage, error, knowledgeSources, startedAt }) {
    try {
      this.runLog.endRun(runId, {
        status,
        finishReason: finishReason ?? null,
        usage: wireUsage(usage),
        // What `run/ended` reported, so a replay of the ledger badges the
        // answer the same way the live stream did.
        ...(Array.isArray(knowledgeSources) ? { knowledgeSources } : {}),
        ...(error
          ? {
              error: {
                code: String(error.code || 'ERROR'),
                message: String(error.message || error)
              }
            }
          : {}),
        durationMs: Date.now() - startedAt
      });
    } catch (err) {
      logger.warn('Run ledger end failed', { component: COMPONENT, runId, error: err.message });
    }
  }

  // ── the turn ───────────────────────────────────────────────────────────

  /**
   * Run one chat turn.
   *
   * With `streaming: true` the turn is one run on the chat's SSE v2 stream
   * (`run/started`, `step/delta`, `tool/*`, `interaction/raised`,
   * `run/paused`, `stream/error`, `run/ended`) and the returned summary is
   * informational. With `streaming: false` nothing is emitted and the caller
   * answers the HTTP request from the summary. Interactive tools are headless
   * without a stream (nobody could answer), so `ask_user` gets a
   * `NO_USER_AVAILABLE` result instead of pausing.
   *
   * @param {Object} params
   * @param {Object} params.prep - `prepareChatRequest().data`
   * @param {string} params.chatId
   * @param {string} [params.messageId] - client exchange id of the assistant placeholder
   * @param {{skillName:string, description?:string}} [params.activatedSkill] - slash-command skill
   * @param {boolean} [params.streaming=true]
   * @param {Function} params.buildLogData - `(streaming, extra) => logData`
   * @param {number} [params.timeoutMs] - hard timeout per model call
   * @param {Function} [params.getLocalizedError] - `(key, params, language) => Promise<string>`
   * @param {string} [params.language='en']
   * @param {Object} [params.user]
   * @param {string} [params.runId] - run id to use (default: minted)
   * @param {Object} [params.persistence] - durable-chat context, supplied by the caller only
   *   when `isChatPersistenceActive()` said yes for this request. Omitted (the default) the
   *   turn is not stored and behaves exactly as it did before chat persistence existed.
   *   `{ repository, ownerId, identityMode, content, clientMessageId?, attachments?,
   *   replaceFromMessageId? }`, where `repository` is a `ChatRepository`, `ownerId`/
   *   `identityMode` are the run principal resolved once by the caller, and `content` is the
   *   raw text of the new user message (the stored history is never client-asserted, but the
   *   message being sent comes from the request). Optional extras for callers that store more
   *   than the chat UI does (the inference API): `message` (fields on the stored user message:
   *   `variables`, `renderedContent`), `chat` (fields patched onto the chat document with the
   *   user turn), `assistant` (fields on the stored answer: `model`), `origin` (how a chat
   *   created by this turn came about) and `clientConnected` (`() => boolean`, whether the
   *   caller is still there to read the answer; default: an SSE client is attached).
   * @param {RunStreamEmitter} [params.emitter] - Stream emitter to use instead of the chat's
   *   SSE-delivered one, for a caller that consumes the frames itself (the inference API
   *   turns them into OpenAI-shaped events).
   * @param {boolean} [params.headless=!streaming] - No user can answer a clarification: the
   *   ask_user tool is refused instead of pausing the turn.
   * @param {Object} [params.structuredOutput] - Check the final answer against an output
   *   contract: `{ validate: (content) => verdict, maxRetries?: number, onAttemptRejected? }`.
   *   An invalid answer is retried inside the run (`maxRetries`, default 1); one that never
   *   becomes valid ends the turn as an error (`OUTPUT_VALIDATION_FAILED`). A valid answer's
   *   content is the validated JSON, and the summary carries `structuredOutput`.
   * @param {Array<Object>} [params.extraSeams] - Further loop seams, run after the tool
   *   projection and before the question and passthrough seams (a scheduled run's approval
   *   gate).
   * @param {{type: string, source?: string}} [params.trigger] - What started the turn, as the
   *   run ledger records it (default: a user).
   * @param {number} [params.maxWallClockMs] - Tighter wall-clock ceiling for a durable turn
   *   than {@link DURABLE_TURN_WALL_CLOCK_MS}.
   * @param {string} [params.clientTimezone] - The user's IANA timezone, handed to the tools
   *   (the scheduling tools read it) and to the scheduling note in the system prompt.
   * @returns {Promise<Object>} `{ runId, status, content, finishReason, usage, messages, knowledgeSources,
   *   pendingInteraction?, toolName?, error?, errorInfo?, structuredOutput? }`
   */
  async runTurn({
    prep,
    chatId,
    messageId,
    activatedSkill = null,
    streaming = true,
    buildLogData,
    timeoutMs,
    getLocalizedError,
    language = 'en',
    user,
    runId: givenRunId,
    persistence = null,
    emitter = null,
    headless = !streaming,
    structuredOutput = null,
    extraSeams = [],
    trigger = null,
    maxWallClockMs = null,
    clientTimezone = null
  }) {
    const {
      app,
      model,
      llmMessages,
      tools = [],
      temperature,
      maxTokens,
      responseFormat,
      responseSchema,
      llmOptions = {},
      userFileData,
      promptSources = []
    } = prep;
    const log = typeof buildLogData === 'function' ? buildLogData : () => ({});
    const loopTools = markInteractiveTools(tools);
    const startedAt = Date.now();
    const runId = givenRunId && isValidRunId(givenRunId) ? givenRunId : newRunId('chat');
    const refs = { chatId, appId: app?.id, ...(messageId ? { messageId } : {}) };

    // One in-flight request per chat: a new turn supersedes the previous one
    // and the stop endpoint / client disconnect abort through this controller.
    //
    // A durable turn is tracked even without a stream. It was started by a
    // caller with no SSE connection — an integration, or a client whose stream
    // has not come up — and it keeps running after any client goes away, so
    // leaving it out of `activeRequests` would make it the one turn Stop can
    // never reach: the endpoint would answer "stopped" while the model ran to
    // completion and billed the tokens.
    const controller = new AbortController();
    const trackRequest = !!chatId && (streaming || !!persistence?.repository);
    if (trackRequest) {
      if (activeRequests.has(chatId)) activeRequests.get(chatId).abort();
      activeRequests.set(chatId, controller);
    }

    // The turn's SSE v2 emitter (chat stream id = chatId, run id = this turn).
    // A caller with its own consumer (the inference API turning frames into
    // OpenAI-shaped events) injects one; the chat UI gets the default one,
    // delivered through the SSE layer.
    //
    // A stored turn without a stream (an integration posting with no SSE
    // client) still emits its frames into an emitter that delivers nowhere:
    // they are what records what the turn did for the stored answer
    // (`runActivity.js`). It is not bound to the chat's stream, so nothing
    // that looks for the turn producing on that stream mistakes it for one.
    const recordOnly = !emitter && !streaming && !!chatId && !!persistence?.repository;
    const stream =
      emitter ||
      (streaming && chatId
        ? new RunStreamEmitter({ streamId: chatId, runId })
        : recordOnly
          ? new RunStreamEmitter({ streamId: chatId, runId, deliver: () => false })
          : NO_STREAM);
    if (stream !== NO_STREAM && !recordOnly) bindStreamRun(chatId, runId, stream);

    logger.info('Chat turn started', {
      component: COMPONENT,
      chatId,
      runId,
      appId: app?.id,
      modelId: model?.id,
      toolCount: loopTools.length,
      toolNames: loopTools.map(t => t.id).join(', '),
      streaming,
      hasUserFileData: !!userFileData
    });

    await this._startLedgerRun({ runId, kind: 'chat', user, refs, model, language, trigger });

    // Scheduling tools resolve "tomorrow at nine" against the user's clock, so
    // the model has to be told what that clock says.
    appendSchedulingContextNote(llmMessages, loopTools, { timezone: clientTimezone });

    // A durable turn records the human half twice: on the ledger, so the run
    // can be replayed as a conversation, and in the chat store, which is what
    // the history UI reads back. Both happen before the first client frame so
    // the chat document exists by the time anything can ask for it.
    const persist = persistence?.repository ? persistence : null;
    if (persist) {
      // What the turn does — its searches, tool calls, workflow steps — is
      // stored with the answer; folding starts before the first frame.
      recordRunActivity(runId);
      const attachments = normalizeAttachments(persist.attachments);
      this._appendUserMessageEvent({ runId, messageId, content: persist.content, attachments });
      await materializeUserTurn({
        repository: persist.repository,
        chatId,
        ownerId: persist.ownerId,
        identityMode: persist.identityMode,
        appId: app?.id,
        modelId: model?.id,
        settings: persist.settings,
        variables: persist.variables,
        runId,
        content: persist.content,
        // The only client id on the wire is the exchange id of the assistant
        // placeholder, which the client also puts on the message it sends.
        clientMessageId: persist.clientMessageId ?? messageId ?? null,
        attachments,
        replaceFromMessageId: persist.replaceFromMessageId,
        message: persist.message,
        chat: persist.chat,
        origin: persist.origin
      });
    }

    stream.emit(SSE_V2_EVENTS.RUN_STARTED, {
      kind: 'chat',
      ...(model?.id ? { model: model.id } : {}),
      refs
    });
    if (activatedSkill?.skillName) {
      stream.emit(SSE_V2_EVENTS.TOOL_PROGRESS, {
        phase: 'skill.activation',
        message: activatedSkill.skillName,
        data: { skillName: activatedSkill.skillName, description: activatedSkill.description || '' }
      });
    }

    const channel = streaming ? createChatChannel({ chatId, stream }) : null;
    // MCP App views this turn rendered, stored with the answer so reopening
    // the chat draws them again.
    const mcpAppViews = [];
    // Per-user OAuth MCP servers the turn's tools asked the user to connect,
    // stored with the answer so the Connect card survives the sign-in redirect.
    const mcpAuthPrompts = [];
    // Scheduled-task proposals the scheduling tools made, stored with the
    // answer so the confirmation card is still there when the chat reopens.
    const scheduledTaskProposals = [];
    // The turn's web search — tool calls with their sources, and the provider's
    // grounding per step — stored with the answer so reopening the chat shows
    // the same sources and citations (shared/webCitations.js).
    const webSearchLog = { tools: [], grounding: [] };
    const turnSeam = chatTurnSeam({
      chatId,
      buildLogData: log,
      streaming,
      telemetry: this.telemetry,
      webSearchLog
    });
    const outputSeam =
      typeof structuredOutput?.validate === 'function'
        ? structuredOutputSeam({
            validate: structuredOutput.validate,
            maxRetries: Number.isInteger(structuredOutput.maxRetries)
              ? structuredOutput.maxRetries
              : 1,
            onAttemptRejected: structuredOutput.onAttemptRejected
          })
        : null;
    // knowledgeSourceSeam runs first so its `outcome.knowledgeSource` is on the
    // outcome when chatToolSeam projects the tool result to `tool/completed`.
    const seams = [
      knowledgeSourceSeam,
      chatToolSeam({
        chatId,
        buildLogData: log,
        logInteraction: this.logInteraction,
        mcpAppViews,
        mcpAuthPrompts,
        scheduledTaskProposals,
        webSearchLog
      }),
      ...(Array.isArray(extraSeams) ? extraSeams.filter(Boolean) : []),
      questionSeam(
        chatQuestionOptions({
          chatId,
          appId: app?.id,
          buildLogData: log,
          logInteraction: this.logInteraction,
          headless,
          getCount: () => this.getClarificationCount(chatId),
          incrementCount: () => this.incrementClarificationCount(chatId),
          interactionService: this.interactionService
        })
      ),
      passthroughSeam(
        chatPassthroughOptions({
          chatId,
          chatStored: Boolean(persist),
          user,
          app,
          userFileData,
          streaming,
          buildLogData: log,
          logInteraction: this.logInteraction,
          runTool: this.runTool
        })
      ),
      imageLiftSeam,
      ...(outputSeam ? [outputSeam] : []),
      turnSeam
    ];

    const pageReads = createPageReadGate(resolveMaxPageReads(app));

    let outcome;
    try {
      const result = await this.agentLoop.run({
        runId,
        kind: 'chat',
        model,
        messages: llmMessages,
        tools: loopTools,
        toolExecution: 'server',
        policies: {
          budgets: {
            maxToolRounds: CHAT_MAX_TOOL_ROUNDS,
            // Only for a turn that can outlive its client; see the constant.
            ...(persist
              ? {
                  maxWallClockMs:
                    Number.isFinite(maxWallClockMs) && maxWallClockMs > 0
                      ? Math.min(maxWallClockMs, DURABLE_TURN_WALL_CLOCK_MS)
                      : DURABLE_TURN_WALL_CLOCK_MS
                }
              : {})
          },
          // Chat tools have side effects and the client renders tool frames in
          // order — run one call at a time.
          tools: { parallel: false },
          context: { compactThresholdTokens: chatCompactThresholdTokens(model) }
        },
        options: { temperature, maxTokens, responseFormat, responseSchema, ...llmOptions },
        language,
        signal: controller.signal,
        timeoutMs,
        refs: { ...refs, userId: user?.id },
        meta: { stream },
        seams,
        channel,
        // `language` is a default the tool may use; explicit model-provided
        // args of the same name win, while chatId/user/appConfig can never be
        // overridden by the model.
        //
        // An MCP tool of a server with MCP Apps enabled hands back its raw
        // result on the shared `info` object, where `chatToolSeam` builds the
        // view from it (declared, or embedded in the result).
        //
        // Page reads are capped per turn (`websearch.maxPageReads`): past the
        // cap the gate answers the call itself instead of fetching the page.
        executeTool: (call, { toolId, args, info, signal }) =>
          pageReads.admit(toolId) ||
          this.runTool(
            toolId,
            {
              language,
              ...args,
              chatId,
              user,
              appConfig: app,
              // The user's timezone, for the scheduling tools' defaults. Only
              // when known: a value the model put in `args` could only pick a
              // default timezone, which the schedule itself can name anyway.
              ...(clientTimezone ? { clientTimezone } : {}),
              // A workflow links its execution back to the chat only when the
              // chat is stored (see `tools/workflowRunner.js`).
              ...(String(toolId).startsWith('workflow_') ? { _chatStored: Boolean(persist) } : {})
            },
            {
              signal,
              onMcpAppResult: result => {
                if (info) info.mcpAppResult = result;
              }
            }
          )
      });
      outcome = await this._finishTurn({
        result,
        runId,
        chatId,
        streaming,
        stream,
        buildLogData: log,
        model,
        timeoutMs,
        getLocalizedError,
        language,
        channel,
        mcpAppViews,
        mcpAuthPrompts,
        scheduledTaskProposals,
        webSearchLog,
        promptSources,
        takePendingCall: () => turnSeam.takePendingCall(),
        structured: outputSeam
          ? {
              validate: structuredOutput.validate,
              attempts: () => outputSeam.attempts(),
              verdictFor: answer => outputSeam.verdictFor(answer)
            }
          : null
      });
      // The ledger's terminal frame first, then the chat document.
      //
      // A client reopening a chat asks the document whether a turn is running
      // and, if it is, replays the run's ledger to catch up. Materializing
      // first opens a window between the answer being appended and the run
      // being released — `materializeAssistantTurn` takes the chat lock for
      // each separately — in which the document still says `running` and the
      // ledger holds no `run/ended`. A client reopening inside it attaches to
      // a run that is already over: nothing further arrives, so the placeholder
      // spins and the composer stays behind a Stop button until the user
      // presses it. Ending the ledger first means the replay always carries the
      // terminal frame, and the reattach settles instead of latching.
      //
      // The reverse window — a released document while the ledger has not
      // ended — costs nothing: a document that is not `running` is never
      // reattached to in the first place.
      this._endLedgerRun(runId, {
        status: outcome.status,
        finishReason: outcome.finishReason,
        usage: outcome.usage,
        error: outcome.error || (outcome.errorInfo ? outcome.errorInfo : undefined),
        knowledgeSources: outcome.knowledgeSources,
        startedAt
      });
      // The single choke point: every terminal shape `_finishTurn` produces —
      // normal, aborted, error, passthrough answer, malformed response —
      // passes through here with the same summary.
      if (persist) {
        await materializeAssistantTurn({
          repository: persist.repository,
          chatId,
          runId,
          summary: outcome,
          clientConnected: clientConnectedOf(persist, chatId),
          message: persist.assistant
        });
      }
      return outcome;
    } catch (error) {
      // The loop never throws for model or tool failures; this is a bug path.
      logger.error('Chat turn crashed', { component: COMPONENT, chatId, runId, error });
      stream.emit(SSE_V2_EVENTS.STREAM_ERROR, {
        code: 'INTERNAL_ERROR',
        message: error.message || 'Internal error'
      });
      stream.emit(SSE_V2_EVENTS.RUN_ENDED, {
        status: 'error',
        finishReason: 'error',
        error: { code: 'INTERNAL_ERROR', message: error.message || 'Internal error' }
      });
      // Ledger first here too, for the reason above.
      this._endLedgerRun(runId, { status: 'error', finishReason: 'error', error, startedAt });
      // `_finishTurn` never ran, so nothing else releases the chat: without
      // this it stays `running` with a live `activeRunId` forever.
      if (persist) {
        await materializeAssistantTurn({
          repository: persist.repository,
          chatId,
          runId,
          summary: {
            status: 'error',
            content: '',
            finishReason: 'error',
            errorInfo: { code: 'INTERNAL_ERROR', message: error.message || 'Internal error' }
          },
          clientConnected: clientConnectedOf(persist, chatId)
        });
      }
      throw error;
    } finally {
      if (stream !== NO_STREAM) unbindStreamRun(chatId, runId);
      if (trackRequest && activeRequests.get(chatId) === controller) {
        activeRequests.delete(chatId);
      }
    }
  }

  /**
   * Project the loop result onto the terminal frames (`stream/error`,
   * `run/paused`, `run/ended`) and the interaction log.
   * @private
   */
  async _finishTurn({
    result,
    runId,
    chatId,
    streaming,
    stream,
    buildLogData,
    model,
    timeoutMs,
    getLocalizedError,
    language,
    channel,
    mcpAppViews = [],
    mcpAuthPrompts = [],
    scheduledTaskProposals = [],
    webSearchLog = null,
    promptSources = [],
    takePendingCall = () => null,
    structured = null
  }) {
    const loopSources = result.knowledgeSources || [];
    const content = result.content || '';
    const usage = wireUsage(result.usage);
    const summary = {
      runId,
      status: result.status,
      content,
      finishReason: result.finishReason,
      usage: result.usage,
      messages: result.messages,
      // On the summary rather than only on the stream: a generated image is
      // part of what the turn produced, and the materializer stores it beside
      // the transcript so reopening the chat still shows it. Every terminal
      // branch below spreads this object, so an aborted turn keeps the
      // pictures it had already emitted.
      images: result.images || [],
      // Same reasoning for MCP App views: part of the answer, restored on reopen.
      mcpApps: mcpAppViews,
      // And for the documents behind the answer (iAssistant citations, iFinder
      // tool documents), which the Documents panel draws again on reopen.
      citations: mergeCitations(result.citations),
      mcpAuthRequired: mcpAuthPrompts,
      scheduledTaskProposals,
      // The web sources behind the answer and the passages they back.
      webSearch: webSearchLog ? buildWebSearch(webSearchLog) : null
      // `knowledgeSources` is set by the branches that name the answer's
      // sources on `run/ended` — the ledger records the summary's list, so it
      // must be exactly what the stream reported.
    };
    const translate = async (key, params) => {
      if (typeof getLocalizedError !== 'function') return null;
      try {
        return await getLocalizedError(key, params || {}, language);
      } catch {
        return null;
      }
    };
    const endRun = data =>
      stream.emit(SSE_V2_EVENTS.RUN_ENDED, { ...(usage ? { usage } : {}), ...data });
    // Whether the turn wrote any answer — text or a picture — the user sees.
    const producedOutput = channel
      ? channel.state.answerOutput
      : content.length > 0 || (result.images?.length ?? 0) > 0;

    if (result.status === 'aborted') {
      // Stop button, client disconnect or a superseding turn: no error bubble.
      await this.telemetry.recordChatCallEnd({
        baseLog: buildLogData(streaming),
        model,
        // The call stopped mid-way is still billed: its request side, estimated.
        request: takePendingCall(),
        outcome: 'aborted'
      });
      // A stopped turn keeps what it had already written, and that answer is
      // based on what the turn used until then. One that wrote nothing has no
      // answer to name a source for.
      const knowledgeSources = producedOutput
        ? this.resolveAnswerSources(loopSources, promptSources)
        : undefined;
      endRun({
        status: 'aborted',
        finishReason: 'connection_closed',
        ...(knowledgeSources ? { knowledgeSources } : {})
      });
      return {
        ...summary,
        status: 'aborted',
        finishReason: 'connection_closed',
        ...(knowledgeSources ? { knowledgeSources } : {})
      };
    }

    if (result.status === 'error') {
      const err = result.error;
      const errorInfo = await describeChatError(err, {
        model,
        language,
        getLocalizedError,
        timeoutMs
      });
      await this.telemetry.recordChatCallEnd({
        baseLog: buildLogData(streaming),
        model,
        request: takePendingCall(),
        outcome: 'error',
        error: err
      });
      logger.error('Chat turn failed', {
        component: COMPONENT,
        chatId,
        runId,
        modelId: model?.id,
        provider: model?.provider,
        code: errorInfo.code,
        error: err?.message
      });
      if (errorInfo.isContextWindowError) {
        logger.warn('Context window exceeded', {
          component: COMPONENT,
          chatId,
          modelId: model?.id,
          contextWindow: model?.contextWindow
        });
      }
      await this.logInteraction(
        'chat_error',
        buildLogData(streaming, {
          responseType: 'error',
          error: {
            message: errorInfo.message,
            code: errorInfo.code,
            details: errorInfo.details,
            isContextWindowError: errorInfo.isContextWindowError
          },
          response: content
        })
      );
      stream.emit(SSE_V2_EVENTS.STREAM_ERROR, {
        code: String(errorInfo.code || 'ERROR'),
        message: errorInfo.message,
        ...(errorInfo.details !== undefined ? { details: errorInfo.details } : {}),
        retryable: false,
        isContextWindowError: !!errorInfo.isContextWindowError
      });
      endRun({
        status: 'error',
        finishReason: 'error',
        error: { code: String(errorInfo.code || 'ERROR'), message: errorInfo.message }
      });
      return { ...summary, status: 'error', finishReason: 'error', error: err, errorInfo };
    }

    if (result.status === 'paused') {
      // The turn pauses for the user's answer: the question seam already sent
      // `interaction/raised`; no badge.
      const pendingInteraction = result.pendingInteraction;
      stream.emit(SSE_V2_EVENTS.RUN_PAUSED, {
        reason: 'interaction',
        ...(pendingInteraction?.id ? { interactionId: String(pendingInteraction.id) } : {})
      });
      return { ...summary, finishReason: 'clarification', pendingInteraction };
    }

    // The output contract, checked on the answer the run ended with. A
    // passthrough answer never went through the seam, so this is its only
    // check; a model answer the seam already judged keeps that verdict (a
    // second run of the time-bounded pattern checks could disagree), and one
    // it never saw is checked here. Either way it is the answer alone that is
    // checked — the final step's text, or the passthrough tool's output — not
    // prose written before a tool call. Returns the terminal summary of a
    // failed check, or null.
    let structuredOutput;
    const checkStructuredOutput = async ({ passthrough = false } = {}) => {
      if (!structured) return null;
      const answer =
        passthrough && typeof result.terminate?.content === 'string'
          ? result.terminate.content
          : typeof result.answerText === 'string'
            ? result.answerText
            : content;
      let verdict = passthrough ? null : structured.verdictFor?.(answer) || null;
      if (!verdict) {
        try {
          verdict = structured.validate(answer);
        } catch (error) {
          verdict = { valid: false, errors: [{ path: '', message: error.message }] };
        }
      }
      const attempts = Math.max(1, structured.attempts?.() || 0);
      if (!verdict.valid) {
        const errors = Array.isArray(verdict.errors) ? verdict.errors : [];
        const message =
          (await translate('outputValidationFailed')) ||
          `The answer did not match the output schema after ${attempts} attempt${
            attempts === 1 ? '' : 's'
          }.`;
        logger.warn('Structured output failed validation', {
          component: COMPONENT,
          chatId,
          runId,
          modelId: model?.id,
          attempts,
          errorCount: errors.length
        });
        await this.logInteraction(
          'chat_error',
          buildLogData(streaming, {
            responseType: 'error',
            error: { message, code: 'OUTPUT_VALIDATION_FAILED', details: errors },
            response: content
          })
        );
        stream.emit(SSE_V2_EVENTS.STREAM_ERROR, {
          code: 'OUTPUT_VALIDATION_FAILED',
          message,
          details: errors,
          retryable: true
        });
        endRun({
          status: 'error',
          finishReason: 'error',
          error: { code: 'OUTPUT_VALIDATION_FAILED', message }
        });
        return {
          ...summary,
          status: 'error',
          finishReason: 'error',
          errorInfo: { message, code: 'OUTPUT_VALIDATION_FAILED', details: errors },
          structuredOutput: { valid: false, errors, attempts }
        };
      }
      structuredOutput = { valid: true, value: verdict.value, attempts };
      // What the caller and the stored history get is the validated JSON,
      // without the fences or prose a model may have wrapped it in.
      if (typeof verdict.text === 'string') summary.content = verdict.text;
      return null;
    };

    if (result.finishReason === 'tool_passthrough_complete') {
      const rejected = await checkStructuredOutput({ passthrough: true });
      if (rejected) return rejected;
      const toolName = result.terminate?.toolName;
      await this.logInteraction(
        'chat_response',
        buildLogData(streaming, {
          responseType: 'success',
          response: content.substring(0, 1000),
          source: 'passthrough_tool',
          toolName
        })
      );
      const knowledgeSources = this.resolveAnswerSources(loopSources, promptSources, {
        byModel: false
      });
      endRun({
        status: 'completed',
        finishReason: 'tool_passthrough_complete',
        ...(toolName ? { toolName: String(toolName) } : {}),
        knowledgeSources
      });
      return {
        ...summary,
        status: 'completed',
        toolName,
        knowledgeSources,
        ...(structuredOutput ? { structuredOutput } : {})
      };
    }

    // Degenerate completion: a failure finish reason (e.g. Gemini's
    // MALFORMED_FUNCTION_CALL) with no answer output would reach the client as
    // a clean end with an empty bubble — surface an error instead.
    if (!producedOutput && isFailureFinishReason(result.finishReason)) {
      const message =
        (await translate('malformedModelResponse')) ||
        'The model returned a malformed response. Please try again.';
      logger.warn('Model completed with failure finish reason and no output', {
        component: COMPONENT,
        chatId,
        runId,
        provider: model?.provider,
        modelId: model?.id,
        finishReason: result.finishReason
      });
      await this.logInteraction(
        'chat_error',
        buildLogData(streaming, {
          responseType: 'error',
          error: {
            message,
            code: 'MALFORMED_RESPONSE',
            details: { finishReason: result.finishReason }
          },
          response: content
        })
      );
      stream.emit(SSE_V2_EVENTS.STREAM_ERROR, {
        code: 'MALFORMED_RESPONSE',
        message,
        details: { finishReason: result.finishReason },
        retryable: true
      });
      endRun({
        status: 'error',
        finishReason: 'error',
        error: { code: 'MALFORMED_RESPONSE', message }
      });
      return {
        ...summary,
        status: 'error',
        finishReason: 'error',
        errorInfo: { message, code: 'MALFORMED_RESPONSE' }
      };
    }

    const rejected = await checkStructuredOutput();
    if (rejected) return rejected;

    const finishReason = result.finishReason || 'stop';
    const knowledgeSources = this.resolveAnswerSources(loopSources, promptSources);
    endRun({ status: result.status || 'completed', finishReason, knowledgeSources });
    await this.logInteraction(
      'chat_response',
      buildLogData(streaming, {
        responseType: 'success',
        response: summary.content.substring(0, 1000)
      })
    );
    return {
      ...summary,
      finishReason,
      knowledgeSources,
      ...(structuredOutput ? { structuredOutput } : {})
    };
  }

  // ── headless app invocation (app-as-tool gateway, MCP) ─────────────────

  /**
   * Run an app to completion without a client: the app-as-tool gateway and
   * the MCP `tools/call` surface. Tools execute server-side; interactive tools
   * are refused (no user to answer); passthrough output becomes the answer.
   *
   * @param {Object} opts
   * @param {string} opts.appId
   * @param {Object} opts.user - acting principal (must include groups)
   * @param {Array<Object>} [opts.messages] - chat messages `[{ role, content }]`
   * @param {Object} [opts.variables] - app variables (attached to the last user message)
   * @param {string} [opts.modelOverride]
   * @param {AbortSignal} [opts.abortSignal]
   * @param {string} [opts.runId] - the CALLER's run/execution id (namespaces the synthetic
   *   chatId and becomes the parent of this run in the ledger)
   * @param {string} [opts.language='en']
   * @param {number} [opts.timeoutMs=120000] - hard timeout per model call
   * @param {number} [opts.maxWallClockMs=180000] - deadline for the whole invocation
   * @param {(text: string, info: {step: number}) => void} [opts.onTextDelta] - called with
   *   each streamed text fragment of the model's answer (every step; the final
   *   answer is `finalMessage.content`)
   * @returns {Promise<Object>} `{ status: 'ok'|'error', runId, finalMessage, toolCalls, citations, usage, finishReason, error? }`
   */
  async invokeAppInternal({
    appId,
    user,
    messages = [],
    variables = {},
    modelOverride,
    abortSignal,
    runId: parentRunId,
    language = 'en',
    timeoutMs = 120_000,
    maxWallClockMs = 180_000,
    onTextDelta = null
  }) {
    if (!appId) throw new Error('appId is required');
    const chatId = `agent:${parentRunId || 'no-run'}:${uuidv4().slice(0, 8)}`;
    const runId = newRunId('subagent');
    const startedAt = Date.now();
    const buildLogData = (streaming, extra = {}) => ({
      appId,
      user: user || null,
      userSessionId: chatId,
      sessionId: chatId,
      ...extra
    });
    const collected = { toolCalls: [], citations: [] };

    try {
      const { data: knownApps = [] } = configCache.getApps();
      const appPrompt = findByIdCaseInsensitive(knownApps, appId)?.prompt || null;

      const prepResult = await this.prepareChatRequest({
        appId,
        modelId: modelOverride,
        messages: withAppPrompt(messages, variables, appPrompt),
        language,
        user,
        chatId
      });
      if (!prepResult.success) {
        return {
          status: 'error',
          runId,
          error: prepResult.error,
          finalMessage: null,
          toolCalls: []
        };
      }
      const {
        app,
        model,
        llmMessages,
        tools = [],
        temperature,
        maxTokens,
        responseFormat,
        responseSchema,
        llmOptions = {},
        userFileData
      } = prepResult.data;

      // What is retained is what the model saw — the loop's bounded (spilled)
      // tool message, not the raw result — under an aggregate cap, so a chatty
      // tool cannot grow this collector without bound.
      let collectedBytes = 0;
      const collector = {
        name: 'app-invoke-collector',
        postTool(ctx, info, outcome) {
          const content = outcome.message?.content ?? null;
          const bytes = Buffer.byteLength(
            typeof content === 'string' ? content : JSON.stringify(content),
            'utf8'
          );
          const kept = collectedBytes + bytes <= APP_INVOKE_COLLECT_CAP_BYTES;
          if (kept) collectedBytes += bytes;
          collected.toolCalls.push({
            toolName: info.toolId,
            toolInput: info.args,
            toolOutput: kept ? content : { truncated: true, bytes }
          });
        },
        onChunk(ctx, chunk) {
          if (chunk.citations) collected.citations.push(chunk.citations);
          // A caller that streams (the A2A endpoint) gets the model's text as
          // it arrives; the assembled answer is still what `finalMessage` holds.
          if (typeof onTextDelta === 'function') {
            for (const text of chunk.content || []) {
              if (text) onTextDelta(text, { step: ctx.iteration });
            }
          }
        }
      };

      await this._startLedgerRun({
        runId,
        kind: 'subagent',
        user,
        refs: { chatId, appId: app.id, ...(parentRunId ? { executionId: parentRunId } : {}) },
        model,
        language,
        parentRunId: parentRunId && isValidRunId(parentRunId) ? parentRunId : undefined
      });

      const pageReads = createPageReadGate(resolveMaxPageReads(app));
      const result = await this.agentLoop.run({
        runId,
        kind: 'subagent',
        model,
        messages: llmMessages,
        tools: markInteractiveTools(tools),
        toolExecution: 'server',
        policies: {
          budgets: { maxToolRounds: CHAT_MAX_TOOL_ROUNDS, maxWallClockMs },
          tools: { parallel: false },
          context: { compactThresholdTokens: chatCompactThresholdTokens(model) }
        },
        options: { temperature, maxTokens, responseFormat, responseSchema, ...llmOptions },
        language,
        signal: abortSignal,
        timeoutMs,
        refs: { chatId, appId: app.id, userId: user?.id, executionId: parentRunId },
        seams: [
          questionSeam(
            chatQuestionOptions({
              chatId,
              appId: app.id,
              buildLogData,
              logInteraction: this.logInteraction,
              headless: true,
              getCount: () => 0,
              incrementCount: () => 1
            })
          ),
          passthroughSeam(
            chatPassthroughOptions({
              chatId,
              user,
              app,
              userFileData,
              streaming: false,
              buildLogData,
              logInteraction: this.logInteraction,
              runTool: this.runTool
            })
          ),
          imageLiftSeam,
          collector
        ],
        executeTool: (call, { toolId, args, signal }) =>
          pageReads.admit(toolId) ||
          this.runTool(toolId, { language, ...args, chatId, user, appConfig: app }, { signal })
      });

      if (result.status === 'error' || result.status === 'aborted') {
        this._endLedgerRun(runId, {
          status: result.status,
          finishReason: result.finishReason,
          usage: result.usage,
          error: result.error,
          startedAt
        });
        return {
          status: 'error',
          runId,
          error: {
            message: result.error?.message || `App invocation ${result.status}`,
            code: result.error?.code
          },
          finalMessage: null,
          toolCalls: collected.toolCalls
        };
      }
      this._endLedgerRun(runId, {
        status: result.status,
        finishReason: result.finishReason,
        usage: result.usage,
        startedAt
      });
      return {
        status: 'ok',
        runId,
        finalMessage: { role: 'assistant', content: result.content || '' },
        toolCalls: collected.toolCalls,
        citations: collected.citations,
        usage: result.usage,
        finishReason: result.finishReason,
        model: model.id
      };
    } catch (error) {
      logger.error('invokeAppInternal failed', {
        component: COMPONENT,
        appId,
        runId,
        parentRunId,
        error: error.message
      });
      return {
        status: 'error',
        runId,
        error: { message: error.message },
        finalMessage: null,
        toolCalls: collected.toolCalls
      };
    }
  }
}

export default ChatService;
