/**
 * ChatService — one chat turn on the shared agent loop.
 *
 * `prepareChatRequest` resolves app, model, messages and tools
 * (`RequestBuilder`); `runTurn` runs the turn through `AgentLoop` and projects
 * it onto the chat SSE dialect via `chatChannel` / `chatSeams`;
 * `invokeAppInternal` runs an app headlessly (app-as-tool gateway, MCP) and
 * returns the assembled answer. There is no chat-specific model loop any more:
 * budgets, tool execution, argument repair, compaction and abort handling are
 * the loop's.
 *
 * @module services/chat/ChatService
 */
import { v4 as uuidv4 } from 'uuid';
import RequestBuilder from './RequestBuilder.js';
import { processMessageTemplates } from '../../serverHelpers.js';
import { logInteraction as defaultLogInteraction } from '../../utils.js';
import { runTool as defaultRunTool } from '../../toolLoader.js';
import { activeRequests } from '../../sse.js';
import { actionTracker } from '../../actionTracker.js';
import { isFailureFinishReason } from '../../adapters/toolCalling/index.js';
import PromptService from '../PromptService.js';
import logger from '../../utils/logger.js';
import defaultAgentLoop from '../loop/AgentLoop.js';
import {
  imageLiftSeam,
  knowledgeSourceSeam,
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
 * Cap on tracked chatIds in the clarification counter. The service is a
 * process-wide singleton with no "conversation ended" signal, so the map is
 * bounded (insertion-ordered, evict-oldest) — mirrors searchCache.js.
 */
const MAX_CHAT_ENTRIES = 5000;

/**
 * Tools that ask the user (today `ask_user`, or anything flagged
 * `requiresUserInput`) are `interactive` for the loop's question seam.
 * @param {Array} tools
 * @returns {Array}
 */
export function markInteractiveTools(tools) {
  return (Array.isArray(tools) ? tools : []).map(tool =>
    tool && (tool.id === 'ask_user' || tool.requiresUserInput === true) && tool.interactive !== true
      ? { ...tool, interactive: true }
      : tool
  );
}

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

class ChatService {
  /**
   * @param {Object} [options]
   * @param {RequestBuilder} [options.requestBuilder]
   * @param {import('../loop/AgentLoop.js').AgentLoop} [options.agentLoop]
   * @param {Function} [options.logInteraction] - interaction logger (tests inject a spy)
   * @param {Function} [options.runTool] - tool runner (tests inject a stub)
   * @param {{recordChatCallStart: Function, recordChatCallEnd: Function}} [options.telemetry] -
   *   usage/metrics recorder (defaults to chatTelemetry.js)
   */
  constructor(options = {}) {
    this.requestBuilder = options.requestBuilder || new RequestBuilder();
    this.agentLoop = options.agentLoop || defaultAgentLoop;
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
   * Emit the answer-source badge for this turn (only when a source was
   * recorded) and clear the per-chat bookkeeping. Called on every terminal
   * answer path so a newly added path can't regress to "Based on AI knowledge".
   */
  finalizeAnswerSource(chatId, loopSources = []) {
    const sources = this.getKnowledgeSources(chatId, loopSources);
    if (sources.length > 0) {
      actionTracker.trackAnswerSource(chatId, { sources, type: 'mixed' });
    }
    this.resetKnowledgeSources(chatId);
  }

  // ── the turn ───────────────────────────────────────────────────────────

  /**
   * Run one chat turn.
   *
   * With `streaming: true` every event of the turn goes to the chat's SSE
   * channel (`actionTracker`) and the returned summary is informational. With
   * `streaming: false` nothing is emitted and the caller answers the HTTP
   * request from the summary. Interactive tools are headless without a
   * stream (nobody could answer), so `ask_user` gets a `NO_USER_AVAILABLE`
   * result instead of pausing.
   *
   * @param {Object} params
   * @param {Object} params.prep - `prepareChatRequest().data`
   * @param {string} params.chatId
   * @param {boolean} [params.streaming=true]
   * @param {Function} params.buildLogData - `(streaming, extra) => logData`
   * @param {number} [params.timeoutMs] - hard timeout per model call
   * @param {Function} [params.getLocalizedError] - `(key, params, language) => Promise<string>`
   * @param {string} [params.language='en']
   * @param {Object} [params.user]
   * @returns {Promise<Object>} `{ status, content, finishReason, usage, messages, knowledgeSources,
   *   clarificationData?, toolName?, error?, errorInfo? }`
   */
  async runTurn({
    prep,
    chatId,
    streaming = true,
    buildLogData,
    timeoutMs,
    getLocalizedError,
    language = 'en',
    user
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

    // One in-flight request per chat: a new turn supersedes the previous one
    // and the stop endpoint / client disconnect abort through this controller.
    const controller = new AbortController();
    const trackRequest = streaming && !!chatId;
    if (trackRequest) {
      if (activeRequests.has(chatId)) activeRequests.get(chatId).abort();
      activeRequests.set(chatId, controller);
    }

    logger.info('Chat turn started', {
      component: COMPONENT,
      chatId,
      appId: app?.id,
      modelId: model?.id,
      toolCount: loopTools.length,
      toolNames: loopTools.map(t => t.id).join(', '),
      streaming,
      hasUserFileData: !!userFileData
    });
    if (streaming && loopTools.length === 0) {
      actionTracker.trackAction(chatId, {
        event: 'processing',
        message: 'Processing your request...'
      });
    }

    const channel = streaming ? createChatChannel({ chatId }) : null;
    const seams = [
      chatToolSeam({ chatId, buildLogData: log, logInteraction: this.logInteraction }),
      questionSeam(
        chatQuestionOptions({
          chatId,
          buildLogData: log,
          logInteraction: this.logInteraction,
          headless: !streaming,
          getCount: () => this.getClarificationCount(chatId),
          incrementCount: () => this.incrementClarificationCount(chatId)
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
      knowledgeSourceSeam,
      chatTurnSeam({ chatId, buildLogData: log, streaming, telemetry: this.telemetry })
    ];

    try {
      const result = await this.agentLoop.run({
        kind: 'chat',
        model,
        messages: llmMessages,
        tools: loopTools,
        toolExecution: 'server',
        policies: {
          budgets: { maxToolRounds: CHAT_MAX_TOOL_ROUNDS },
          // Chat tools have side effects and the client renders tool events in
          // order — run one call at a time.
          tools: { parallel: false }
        },
        options: { temperature, maxTokens, responseFormat, responseSchema, ...llmOptions },
        language,
        signal: controller.signal,
        timeoutMs,
        refs: { chatId, appId: app?.id, userId: user?.id },
        seams,
        channel,
        // `language` is a default the tool may use; explicit model-provided
        // args of the same name win, while chatId/user/appConfig can never be
        // overridden by the model.
        executeTool: (call, { toolId, args }) =>
          this.runTool(toolId, { language, ...args, chatId, user, appConfig: app })
      });
      return await this._finishTurn({
        result,
        chatId,
        streaming,
        buildLogData: log,
        model,
        timeoutMs,
        getLocalizedError,
        language,
        channel
      });
    } finally {
      // Never let a detected source leak into the next turn on this chatId.
      this.resetKnowledgeSources(chatId);
      if (trackRequest && activeRequests.get(chatId) === controller) {
        activeRequests.delete(chatId);
      }
    }
  }

  /**
   * Project the loop result onto the terminal chat events (`answer.source`,
   * `error`, `done`) and the interaction log.
   * @private
   */
  async _finishTurn({
    result,
    chatId,
    streaming,
    buildLogData,
    model,
    timeoutMs,
    getLocalizedError,
    language,
    channel
  }) {
    const sources = result.knowledgeSources || [];
    const content = result.content || '';
    const summary = {
      status: result.status,
      content,
      finishReason: result.finishReason,
      usage: result.usage,
      messages: result.messages,
      knowledgeSources: this.getKnowledgeSources(chatId, sources)
    };
    const translate = async (key, params) => {
      if (typeof getLocalizedError !== 'function') return null;
      try {
        return await getLocalizedError(key, params || {}, language);
      } catch {
        return null;
      }
    };

    if (result.status === 'aborted') {
      // Stop button, client disconnect or a superseding turn: no error bubble.
      await this.telemetry.recordChatCallEnd({
        baseLog: buildLogData(streaming),
        model,
        outcome: 'aborted'
      });
      if (streaming) actionTracker.trackDone(chatId, { finishReason: 'connection_closed' });
      return { ...summary, finishReason: 'connection_closed' };
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
      if (streaming) {
        actionTracker.trackError(chatId, { ...errorInfo });
        actionTracker.trackDone(chatId, { finishReason: 'error' });
      }
      return { ...summary, status: 'error', finishReason: 'error', error: err, errorInfo };
    }

    if (result.status === 'paused') {
      // The turn pauses for the user's answer: no badge, but the sources must
      // not leak into the follow-up turn (the caller's finally resets them).
      const clarificationData = result.pendingInteraction;
      if (streaming) {
        actionTracker.trackDone(chatId, { finishReason: 'clarification', clarificationData });
      }
      return { ...summary, finishReason: 'clarification', clarificationData };
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
      if (streaming) {
        this.finalizeAnswerSource(chatId, sources);
        actionTracker.trackDone(chatId, { finishReason: 'tool_passthrough_complete', toolName });
      }
      return { ...summary, toolName };
    }

    // Degenerate completion: a failure finish reason (e.g. Gemini's
    // MALFORMED_FUNCTION_CALL) with no answer output would reach the client as
    // a clean 'done' with an empty bubble — surface an error instead.
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
      if (streaming) {
        actionTracker.trackError(chatId, { message, code: 'MALFORMED_RESPONSE' });
        actionTracker.trackDone(chatId, { finishReason: 'error' });
      }
      return {
        ...summary,
        status: 'error',
        finishReason: 'error',
        errorInfo: { message, code: 'MALFORMED_RESPONSE' }
      };
    }

    const finishReason = result.finishReason || 'stop';
    if (streaming) {
      // Badge before 'done' so the client attaches it to the message.
      this.finalizeAnswerSource(chatId, sources);
      actionTracker.trackDone(chatId, { finishReason });
    }
    await this.logInteraction(
      'chat_response',
      buildLogData(streaming, { responseType: 'success', response: content.substring(0, 1000) })
    );
    return { ...summary, finishReason };
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
   * @param {string} [opts.runId] - namespaces the synthetic chatId / ledger refs
   * @param {string} [opts.language='en']
   * @param {number} [opts.timeoutMs=120000] - hard timeout per model call
   * @param {number} [opts.maxWallClockMs=180000] - deadline for the whole invocation
   * @returns {Promise<Object>} `{ status: 'ok'|'error', finalMessage, toolCalls, citations, usage, finishReason, error? }`
   */
  async invokeAppInternal({
    appId,
    user,
    messages = [],
    variables = {},
    modelOverride,
    abortSignal,
    runId,
    language = 'en',
    timeoutMs = 120_000,
    maxWallClockMs = 180_000
  }) {
    if (!appId) throw new Error('appId is required');
    const chatId = `agent:${runId || 'no-run'}:${uuidv4().slice(0, 8)}`;
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
        return { status: 'error', error: prepResult.error, finalMessage: null, toolCalls: [] };
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

      const collector = {
        name: 'app-invoke-collector',
        postTool(ctx, info, outcome) {
          collected.toolCalls.push({
            toolName: info.toolId,
            toolInput: info.args,
            toolOutput: outcome.rawResult
          });
        },
        onChunk(ctx, chunk) {
          if (chunk.citations) collected.citations.push(chunk.citations);
        }
      };

      const result = await this.agentLoop.run({
        kind: 'subagent',
        model,
        messages: llmMessages,
        tools: markInteractiveTools(tools),
        toolExecution: 'server',
        policies: {
          budgets: { maxToolRounds: CHAT_MAX_TOOL_ROUNDS, maxWallClockMs },
          tools: { parallel: false }
        },
        options: { temperature, maxTokens, responseFormat, responseSchema, ...llmOptions },
        language,
        signal: abortSignal,
        timeoutMs,
        refs: { chatId, appId: app.id, userId: user?.id, executionId: runId },
        seams: [
          questionSeam(
            chatQuestionOptions({
              chatId,
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
        return {
          status: 'error',
          error: {
            message: result.error?.message || `App invocation ${result.status}`,
            code: result.error?.code
          },
          finalMessage: null,
          toolCalls: collected.toolCalls
        };
      }
      return {
        status: 'ok',
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
        error: error.message
      });
      return {
        status: 'error',
        error: { message: error.message },
        finalMessage: null,
        toolCalls: collected.toolCalls
      };
    }
  }
}

export default ChatService;
