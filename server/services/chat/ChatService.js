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
import { activeRequests } from '../../sse.js';
import { isFailureFinishReason } from '../../adapters/toolCalling/index.js';
import PromptService from '../PromptService.js';
import logger from '../../utils/logger.js';
import defaultAgentLoop from '../loop/AgentLoop.js';
import runLogSingleton, { newRunId, isValidRunId } from '../loop/RunLog.js';
import interactionServiceSingleton from '../loop/InteractionService.js';
import { RunStreamEmitter, bindStreamRun, unbindStreamRun } from '../loop/RunStream.js';
import { SSE_V2_EVENTS } from '../../../shared/runEvents.js';
import {
  imageLiftSeam,
  knowledgeSourceSeam,
  markInteractiveTools,
  passthroughSeam,
  questionSeam
} from '../loop/seams/index.js';
import { createChatChannel } from './chatChannel.js';
import {
  chatTurnSeam,
  chatToolSeam,
  chatQuestionOptions,
  chatPassthroughOptions
} from './chatSeams.js';
import { describeChatError } from './chatErrors.js';
import * as defaultTelemetry from './chatTelemetry.js';

const COMPONENT = 'ChatService';

/** Tool rounds per chat turn (the loop forces a final answer on the last one). */
export const CHAT_MAX_TOOL_ROUNDS = 10;

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
 * Falls back to the floor when the model declares no usable contextWindow.
 *
 * @param {{contextWindow?: number}} model - resolved model config
 * @returns {number} threshold in estimated tokens
 */
export function chatCompactThresholdTokens(model) {
  const window = Number(model?.contextWindow);
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

/** Attach app variables to the last user message (where PromptService reads them). */
function withVariables(messages, variables) {
  const list = Array.isArray(messages) ? messages : [];
  if (!variables || Object.keys(variables).length === 0) return list;
  let lastUser = -1;
  for (let i = list.length - 1; i >= 0; i--) {
    if (list[i]?.role === 'user') {
      lastUser = i;
      break;
    }
  }
  if (lastUser < 0) return list;
  return list.map((m, i) =>
    i === lastUser ? { ...m, variables: { ...(m.variables || {}), ...variables } } : m
  );
}

/** Usage as carried on the wire (contract fields only). */
function wireUsage(usage) {
  if (!usage) return undefined;
  const out = {
    promptTokens: usage.promptTokens || 0,
    completionTokens: usage.completionTokens || 0,
    totalTokens: usage.totalTokens || (usage.promptTokens || 0) + (usage.completionTokens || 0)
  };
  if (usage.source === 'provider' || usage.source === 'estimate' || usage.source === 'mixed') {
    out.source = usage.source;
  }
  return out;
}

const NO_STREAM = { emit: () => null, runId: null };

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
    return await this.requestBuilder.prepareChatRequest({ ...params, processMessageTemplates });
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
   * Sources of a turn: what the loop recorded (tools, grounding, uploads,
   * email context) plus prompt-based sources PromptService tracked per chat.
   */
  getKnowledgeSources(chatId, loopSources = []) {
    return Array.from(new Set([...loopSources, ...PromptService.getPromptSources(chatId)]));
  }

  resetKnowledgeSources(chatId) {
    PromptService.resetPromptSources(chatId);
  }

  /**
   * The knowledge sources to report on a terminal answer (`run/ended`), and
   * clear the per-chat bookkeeping so nothing leaks into the next turn.
   */
  resolveAnswerSources(chatId, loopSources = []) {
    const sources = this.getKnowledgeSources(chatId, loopSources);
    this.resetKnowledgeSources(chatId);
    return sources;
  }

  // ── ledger ─────────────────────────────────────────────────────────────

  async _startLedgerRun({ runId, kind, user, refs, model, language, parentRunId }) {
    try {
      await this.runLog.startRun({
        runId,
        kind,
        user,
        refs,
        model: model?.id,
        language,
        ...(parentRunId ? { parentRunId } : {})
      });
    } catch (err) {
      logger.warn('Run ledger start failed', { component: COMPONENT, runId, error: err.message });
    }
  }

  _endLedgerRun(runId, { status, finishReason, usage, error, startedAt }) {
    try {
      this.runLog.endRun(runId, {
        status,
        finishReason: finishReason ?? null,
        usage: wireUsage(usage),
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
   * @returns {Promise<Object>} `{ runId, status, content, finishReason, usage, messages, knowledgeSources,
   *   pendingInteraction?, toolName?, error?, errorInfo? }`
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
    runId: givenRunId
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
      userFileData
    } = prep;
    const log = typeof buildLogData === 'function' ? buildLogData : () => ({});
    const loopTools = markInteractiveTools(tools);
    const startedAt = Date.now();
    const runId = givenRunId && isValidRunId(givenRunId) ? givenRunId : newRunId('chat');
    const refs = { chatId, appId: app?.id, ...(messageId ? { messageId } : {}) };

    // One in-flight request per chat: a new turn supersedes the previous one
    // and the stop endpoint / client disconnect abort through this controller.
    const controller = new AbortController();
    const trackRequest = streaming && !!chatId;
    if (trackRequest) {
      if (activeRequests.has(chatId)) activeRequests.get(chatId).abort();
      activeRequests.set(chatId, controller);
    }

    // The turn's SSE v2 emitter (chat stream id = chatId, run id = this turn).
    const stream =
      streaming && chatId ? new RunStreamEmitter({ streamId: chatId, runId }) : NO_STREAM;
    if (stream !== NO_STREAM) bindStreamRun(chatId, runId, stream);

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

    await this._startLedgerRun({ runId, kind: 'chat', user, refs, model, language });
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
    // knowledgeSourceSeam runs first so its `outcome.knowledgeSource` is on the
    // outcome when chatToolSeam projects the tool result to `tool/completed`.
    const seams = [
      knowledgeSourceSeam,
      chatToolSeam({ chatId, buildLogData: log, logInteraction: this.logInteraction }),
      questionSeam(
        chatQuestionOptions({
          chatId,
          appId: app?.id,
          buildLogData: log,
          logInteraction: this.logInteraction,
          headless: !streaming,
          getCount: () => this.getClarificationCount(chatId),
          incrementCount: () => this.incrementClarificationCount(chatId),
          interactionService: this.interactionService
        })
      ),
      passthroughSeam(
        chatPassthroughOptions({
          chatId,
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
      chatTurnSeam({ chatId, buildLogData: log, streaming, telemetry: this.telemetry })
    ];

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
          budgets: { maxToolRounds: CHAT_MAX_TOOL_ROUNDS },
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
        executeTool: (call, { toolId, args }) =>
          this.runTool(toolId, { language, ...args, chatId, user, appConfig: app })
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
        channel
      });
      this._endLedgerRun(runId, {
        status: outcome.status,
        finishReason: outcome.finishReason,
        usage: outcome.usage,
        error: outcome.error || (outcome.errorInfo ? outcome.errorInfo : undefined),
        startedAt
      });
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
      this._endLedgerRun(runId, { status: 'error', finishReason: 'error', error, startedAt });
      throw error;
    } finally {
      // Never let a detected source leak into the next turn on this chatId.
      this.resetKnowledgeSources(chatId);
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
    channel
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
      knowledgeSources: this.getKnowledgeSources(chatId, loopSources)
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

    if (result.status === 'aborted') {
      // Stop button, client disconnect or a superseding turn: no error bubble.
      await this.telemetry.recordChatCallEnd({
        baseLog: buildLogData(streaming),
        model,
        outcome: 'aborted'
      });
      endRun({ status: 'aborted', finishReason: 'connection_closed' });
      return { ...summary, status: 'aborted', finishReason: 'connection_closed' };
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
      // `interaction/raised`; no badge, and the caller's finally resets sources.
      const pendingInteraction = result.pendingInteraction;
      stream.emit(SSE_V2_EVENTS.RUN_PAUSED, {
        reason: 'interaction',
        ...(pendingInteraction?.id ? { interactionId: String(pendingInteraction.id) } : {})
      });
      return { ...summary, finishReason: 'clarification', pendingInteraction };
    }

    if (result.finishReason === 'tool_passthrough_complete') {
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
      const knowledgeSources = this.resolveAnswerSources(chatId, loopSources);
      endRun({
        status: 'completed',
        finishReason: 'tool_passthrough_complete',
        ...(toolName ? { toolName: String(toolName) } : {}),
        knowledgeSources
      });
      return { ...summary, status: 'completed', toolName, knowledgeSources };
    }

    // Degenerate completion: a failure finish reason (e.g. Gemini's
    // MALFORMED_FUNCTION_CALL) with no answer output would reach the client as
    // a clean end with an empty bubble — surface an error instead.
    const producedOutput = channel
      ? channel.state.answerOutput
      : content.length > 0 || (result.images?.length ?? 0) > 0;
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

    const finishReason = result.finishReason || 'stop';
    const knowledgeSources = this.resolveAnswerSources(chatId, loopSources);
    endRun({ status: result.status || 'completed', finishReason, knowledgeSources });
    await this.logInteraction(
      'chat_response',
      buildLogData(streaming, { responseType: 'success', response: content.substring(0, 1000) })
    );
    return { ...summary, finishReason, knowledgeSources };
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
    maxWallClockMs = 180_000
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
      const prepResult = await this.prepareChatRequest({
        appId,
        modelId: modelOverride,
        messages: withVariables(messages, variables),
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
        executeTool: (call, { toolId, args }) =>
          this.runTool(toolId, { language, ...args, chatId, user, appConfig: app })
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
