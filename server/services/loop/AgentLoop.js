// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * AgentLoop — the ONE tool loop.
 *
 * One invocation is one *segment*: the model works until it produces a final
 * answer, raises an interaction, exhausts its budget, or is aborted. Every
 * provider call goes through `LLMClient`; every cross-cutting behaviour is a
 * seam registration (`use()`), never a second loop:
 *
 *   built in   run-level token budget with graceful wrap-up, round cap, tool
 *              circuit breakers (rate limit / consecutive failures), proactive
 *              and reactive context compaction, abort awareness, structured
 *              output (incl. the Anthropic synthetic `json` tool lift),
 *              argument repair + parameter defaults, segment planner (parallel
 *              tool batches), hallucinated-tool envelopes, ledger events,
 *              caller-executed toolsets (degenerate run contract)
 *   seams      pre-step / pre-tool / post-tool / step-end hooks (+ chunk,
 *              stream-end, hallucination, circuit-breaker, compaction
 *              notifications)
 *
 * @module services/loop/AgentLoop
 */
import { combinePlans as combineTextPlans } from '../provenance/watermark/watermarkPlan.js';
import crypto from 'node:crypto';
import defaultLlmClient, { isErrorLedgered } from './LLMClient.js';
import runLogSingleton, { isValidRunId } from './RunLog.js';
import { raceAbort } from './abortRace.js';
import defaultLogger from '../../utils/logger.js';
import { loopPoliciesSchema } from './contracts/loop.js';
import { LLMError, LLM_ERROR_CODES, isLLMError, isAbortError } from './contracts/errors.js';
import { RUN_LOG_EVENTS } from '../../../shared/runEvents.js';
import { addUsage, normalizeUsage } from './llmUsage.js';
import { repairToolArguments, applyParameterDefaults, matchTool } from './toolArgs.js';
import { classifyToolResult } from './toolClassify.js';
import { isCitationProducing } from '../tools/toolCategory.js';
import { startedDisplayOf } from '../../utils/toolDisplay.js';
import { extractToolOutcome, extractToolSources, finalizeSourceFrame } from '../sources/index.js';
import { runToolCallScope } from '../sources/toolCallScope.js';
import {
  emptySourceSet,
  mergeSources,
  sourcesFromGrounding
} from '../../../shared/sources/index.js';
import { planToolBatches } from './segmentPlanner.js';
import { takeSteers, steerMessage, STEER_MARKER } from './steering.js';
import {
  isNativeWebSearchRejection,
  isNativeWebSearchUnavailable,
  markNativeWebSearchUnavailable,
  resolveNativeWebSearchFallbackTools as defaultResolveNativeWebSearchFallbackTools
} from './nativeWebSearchFallback.js';
import {
  isToolChoiceRejection,
  markForcedToolUseUnavailable,
  planToolChoice,
  turnHasToolCalls
} from './toolChoice.js';
import {
  compactIfOversized,
  elideRetriedCallArguments,
  microcompactMessages,
  isContextOverflowError,
  shrinkFailedToolCalls,
  isFailedResult,
  estimateTokens
} from './contextCompaction.js';
import { estimateTranscriptTokens } from './contextTracker.js';
import {
  RECALL_TOOL_ID,
  applyDigest,
  collectCalls,
  condensedStateOf,
  kindsOf,
  recallPage,
  recallToolDefinition,
  renderDigest,
  digestRoomOf,
  escapeCondensedPrefix,
  factsRoomOf,
  isCondensedContent,
  notesOf,
  DIGEST_FALLBACK_REASONS,
  MIN_DIGEST_CHARS,
  selectBatches,
  summarizeCalls,
  summaryFailureOf,
  taskOf
} from './findingsDigest.js';
import { MAX_COMPACTION_DIGEST_CHARS } from './contracts/sseV2.js';
import {
  toolDisabledNudge,
  ALL_TOOLS_DEAD_NUDGE,
  tokenBudgetNudge,
  ROUND_CAP_NUDGE,
  CONTEXT_WRAP_UP_NUDGE,
  CONTEXT_FULL_NUDGE,
  nudgeMessage
} from './nudges.js';

import { recordToolCall } from '../../telemetry/metrics.js';
import { toolCallOutcomeOf } from '../chat/answerOriginMetrics.js';

const COMPONENT = 'AgentLoop';
const PREVIEW_CHARS = 1024;
/** Longest preview kept in the transcript for a tool result that was spilled. */
const SPILL_PREVIEW_CHARS = 16 * 1024;

/** Resolve a (partial) policies object against the contract defaults. */
export function resolvePolicies(partial = {}) {
  return loopPoliciesSchema.parse(partial || {});
}

function abortError(message = 'Agent loop aborted') {
  return new LLMError(message, { code: LLM_ERROR_CODES.ABORTED, providerCode: 'ABORTED' });
}

function wallClockError() {
  return new LLMError('Agent loop wall-clock budget exceeded', {
    code: LLM_ERROR_CODES.TIMEOUT,
    providerCode: 'WALL_CLOCK'
  });
}

/** One signal that aborts when any of the given ones does (absent ones ignored). */
function combineSignals(...signals) {
  const list = signals.filter(Boolean);
  if (list.length === 0) return undefined;
  if (list.length === 1) return list[0];
  return AbortSignal.any(list);
}

function looksLikeJson(text) {
  return /^\s*[[{]/.test(text);
}

function previewValue(value) {
  if (value === null || value === undefined) return null;
  let text;
  try {
    text = typeof value === 'string' ? value : JSON.stringify(value);
  } catch {
    return '[unserialisable]';
  }
  if (typeof text !== 'string') return null;
  return text.length > PREVIEW_CHARS
    ? `${text.slice(0, PREVIEW_CHARS)}…[truncated ${text.length - PREVIEW_CHARS} chars]`
    : text;
}

function serializeToolContent(result) {
  if (typeof result === 'string') return result;
  if (result === undefined) return '';
  try {
    return JSON.stringify(result);
  } catch {
    return String(result);
  }
}

async function runHooks(seams, hook, ...args) {
  for (const seam of seams) {
    const fn = seam?.[hook];
    if (typeof fn !== 'function') continue;
    const out = await fn(...args);
    if (out && typeof out === 'object' && out.handled) return out;
  }
  return null;
}

export class AgentLoop {
  /**
   * @param {Object} [opts]
   * @param {import('./LLMClient.js').LLMClient} [opts.llmClient]
   * @param {import('./RunLog.js').RunLog} [opts.runLog]
   * @param {Object} [opts.logger]
   * @param {Array} [opts.seams] - initial seam registrations
   * @param {Function} [opts.resolveNativeWebSearchFallbackTools] - `(directive, {app, language, user}) => tools`
   *   offered when a provider rejects native web search (default: toolLoader's braveSearch)
   */
  constructor(opts = {}) {
    this.llmClient = opts.llmClient || defaultLlmClient;
    this.runLog = opts.runLog || runLogSingleton;
    this.logger = opts.logger || defaultLogger;
    this._seams = [...(opts.seams || [])];
    this.resolveNativeWebSearchFallbackTools =
      opts.resolveNativeWebSearchFallbackTools || defaultResolveNativeWebSearchFallbackTools;
  }

  /**
   * Register a seam `{ name, preStep, preTool, liftResult, postTool, stepEnd,
   * onChunk, streamEnd, onHallucinated, onCircuitBroken, onCompactionStart,
   * onCompaction, onAnswer }`.
   *
   * `onCompactionStart(ctx, info)` runs before a findings digest is written
   * (it can take a while: the summary model reads the results), and
   * `onCompaction(ctx, info)` once the transcript was compacted, by a digest
   * or by collapsing messages (`lossy`). `info` carries the fields of the
   * ledger's `context/compaction` (`compactionId`, `trigger`, `strategy`,
   * `lossy`, `tokensBefore`, `tokensAfter`, `itemsSummarised`, `kinds`,
   * `digest`, …) plus `freedTokens` and the new `messages`.
   *
   * `streamEnd(ctx, { outcome, result? })` closes every model call that `preStep`
   * opened, however it ended: `outcome` is `completed` (with the accumulated
   * `result`), `error` (the provider failed) or `aborted` (Stop, or the run's
   * deadline). It runs before `stepEnd` and before any tool of the step, and
   * on the paths that never reach `stepEnd` (the loop returns from its `catch`
   * on an error or an abort). A throw from the hook is logged, never raised.
   */
  use(seam) {
    if (seam) this._seams.push(seam);
    return this;
  }

  /**
   * Run one segment.
   *
   * @param {Object} request
   * @param {string} [request.runId] - ledger run this segment belongs to
   * @param {string} [request.kind='agent']
   * @param {Object} request.model - resolved model object
   * @param {Array} request.messages - starting transcript (not mutated)
   * @param {Array} [request.tools] - tool specs offered to the model
   * @param {Object} [request.toolSearch] - `createToolSearch()`: the tools left out of `tools`.
   *   What `search_tools` finds joins `tools` for the model's next step
   * @param {'server'|'caller'} [request.toolExecution='server']
   * @param {Object} [request.policies] - partial loop policies (see contracts/loop.js)
   * @param {Object} [request.options] - LLMClient options (maxTokens, responseSchema, thinking*, …)
   * @param {string} [request.language]
   * @param {AbortSignal} [request.signal]
   * @param {Object} [request.refs] - correlation ids for ledger/telemetry
   * @param {Function} [request.executeTool] - `(call, { toolDef, args, ctx }) => result | toolMessage`
   * @param {Object} [request.channel] - `{ onChunk(chunk, ctx), onToolStart(info), onToolEnd(info) }`
   * @param {Object} [request.state] - `{ budget: {input, output, total} }` shared run-level budget
   * @param {Object} [request.meta] - opaque caller data forwarded to seams
   * @param {Object} [request.summaryModel] - the model that writes findings digests
   *   (`policies.context.strategy: 'digest'`); default: `request.model`
   * @param {string[]} [request.archiveRunIds] - earlier runs of the same chat turn (a
   *   turn that continued a paused run under a new id) whose condensed results
   *   `recall_tool_result` may read; a run of another chat is ignored
   * @param {Array} [request.seams] - per-run seams (in addition to `use()`d ones)
   * @param {string} [request.purpose='agent-step']
   * @param {number} [request.timeoutMs] - hard timeout for each model call
   * @param {Object} [request.resume] - continue a turn that paused on an approval:
   *   `{ toolCall: { id, type, function: { name, arguments } }, args }`. Before the
   *   first model call the loop runs this call with `args` (through the seams, like any
   *   call) and puts its result where the transcript's placeholder for `toolCall.id` is.
   *   A resume after a connect names several: `{ toolCalls: [{ toolCall, args }, …] }`,
   *   run in order.
   * @returns {Promise<Object>} LoopResult
   */
  async run(request) {
    const startedAt = Date.now();
    const policies = resolvePolicies(request.policies);
    // Copied: the native web search fallback may add a tool for this run only.
    const tools = Array.isArray(request.tools) ? [...request.tools] : [];
    // Tools left out of `tools` that the model finds with `search_tools`: what
    // it finds is added to `tools` (services/tools/toolSearch.js).
    const toolSearch = request.toolSearch || null;
    const toolExecution = request.toolExecution === 'caller' ? 'caller' : 'server';
    const seams = [...this._seams, ...(request.seams || [])];
    const runId = request.runId || null;
    // Ledger events need a well-formed run id; anything else is telemetry-only.
    const ledgerId = runId && isValidRunId(runId) ? runId : null;
    if (runId && !ledgerId) {
      this.logger.debug('AgentLoop runId is not ledger-addressable; ledger events skipped', {
        component: COMPONENT,
        runId: String(runId).slice(0, 64)
      });
    }
    const purpose = request.purpose || 'agent-step';
    const segmentId = request.segment || `seg-${crypto.randomUUID().slice(0, 8)}`;
    const model = request.model;
    if (!model) {
      throw new LLMError('AgentLoop requires a resolved model', {
        code: LLM_ERROR_CODES.INVALID_REQUEST
      });
    }

    const maxRounds = policies.budgets.maxToolRounds;
    const maxTokensPerRun = policies.budgets.maxTokensPerRun || 0;
    // The wall-clock budget is an abort signal, not just a timestamp checked
    // between awaits: combined with the caller's signal it cuts an in-flight
    // model call or tool short when the invocation deadline passes.
    const wallClockMs = policies.budgets.maxWallClockMs || 0;
    const deadline = wallClockMs ? new AbortController() : null;
    // Not unref'd on purpose: while a tool or model call is in flight this
    // timer is what guarantees the invocation ends; it is cleared in `finally`.
    const deadlineTimer = deadline
      ? setTimeout(() => deadline.abort(wallClockError()), wallClockMs)
      : null;
    const signal = combineSignals(request.signal, deadline?.signal);
    const runBudget = request.state?.budget || { input: 0, output: 0, total: 0 };
    if (request.state) request.state.budget = runBudget;

    const options = { ...request.options };
    const responseSchema = options.responseSchema;
    if (responseSchema && !options.responseFormat) options.responseFormat = 'json';
    let nativeWebSearch = options.nativeWebSearch ?? null;

    const ctx = {
      request,
      runId,
      ledgerId,
      kind: request.kind || 'agent',
      model,
      tools,
      toolSearch,
      policies,
      messages: [...request.messages],
      stream: null,
      // The tools the model is offered in the model call under way (empty
      // while none are), and the lookup of the one a call name refers to. A
      // seam that sees a call as it streams (`onChunk`) resolves the name here.
      offeredTools: [],
      resolveTool: name => matchTool(name, ctx.offeredTools),
      iteration: 0,
      disabledTools: new Set(),
      knowledgeSources: new Set(),
      // The connected systems that informed the turn, by name ('' for one with
      // none): the answer's basis names each of them.
      integrations: new Set(),
      // What the segment's producers found (tool calls, adapters, provider search).
      sources: emptySourceSet(),
      // State the run's tool calls share (services/sources/toolCallScope.js):
      // the passage numbers already handed out, so citations stay unique.
      toolTurn: { passageMarkers: 0 },
      state: request.state,
      meta: request.meta || {},
      refs: request.refs || {},
      channel: request.channel || null,
      signal,
      logger: this.logger,
      llmClient: this.llmClient,
      runLog: this.runLog,
      addKnowledgeSource: source => {
        if (source) ctx.knowledgeSources.add(source);
      },
      addIntegration: label => {
        ctx.integrations.add(typeof label === 'string' ? label : '');
      },
      /**
       * Report sources a producer found: merged into `ctx.sources`, written to
       * the ledger and handed to the channel (`onSources`) as `sources/added`.
       * @param {Object|null} frame - `{ items, queries?, supports? }`
       * @param {{step?: number, callId?: string, toolId?: string, defaults?: Object}} [where]
       * @returns {Promise<Object|null>} the frame as reported, null when it held nothing
       */
      addSources: async (frame, { step, callId, toolId, defaults } = {}) => {
        const finalized = finalizeSourceFrame(frame, defaults);
        if (!finalized) return null;
        const merged = mergeSources(ctx.sources, finalized);
        // A repeat that adds nothing (Google sends its grounding again with
        // every chunk) is not reported again. A tool call's frame always is:
        // it is also that call's own list.
        if (merged === ctx.sources && !callId) return null;
        ctx.sources = merged;
        const data = {
          ...(Number.isInteger(step) ? { step } : {}),
          ...(callId ? { callId: String(callId) } : {}),
          ...(toolId ? { toolId: String(toolId) } : {}),
          ...finalized
        };
        this._ledger(ledgerId, RUN_LOG_EVENTS.SOURCES_ADDED, data);
        if (ctx.channel?.onSources) await ctx.channel.onSources(data, ctx);
        return data;
      }
    };

    // A turn that already holds a tool call (it resumed after the model asked a
    // question) has had its first call: nothing is forced again.
    const priorToolUse = policies.tools.choice === 'required' && turnHasToolCalls(request.messages);
    let forcedToolUseRejected = false;

    let forceFinish = false;
    let forceReason = null;
    let reactiveAttempts = 0;
    // The provider's count of the last call's prompt and how many transcript
    // messages it held: the compaction check adds what came after instead of
    // counting the transcript again. Dropped when the transcript is compacted.
    let promptAnchor = null;
    let callMessageCount = 0;
    let iteration = 0;
    let content = '';
    let answerText = ''; // what the last model step answered, without earlier steps' prose
    // Watermark plans of the text-producing steps (#3331): the turn is marked only if all were.
    const markingPlans = [];
    let finishReason = null;
    let usage = null;
    let lastStepUsage = null; // the final model call's own usage, not the turn's sum
    const thoughtSignatures = [];
    const images = [];
    let forcedFinalOffered = false; // a tool-less final call was made after a budget gate fired
    let terminal = null; // { status, finishReason, pendingInteraction?, toolCalls? }

    const archiveRunIds = (
      Array.isArray(request.archiveRunIds) ? request.archiveRunIds : []
    ).filter(id => isValidRunId(id) && id !== ledgerId);
    this._ledger(ledgerId, RUN_LOG_EVENTS.SEGMENT_START, {
      segment: segmentId,
      purpose,
      ...(archiveRunIds.length ? { archiveRunIds: archiveRunIds.slice(0, 16) } : {})
    });

    const assertNotAborted = () => {
      if (deadline?.signal.aborted) throw wallClockError();
      if (signal?.aborted) throw abortError('Agent loop aborted (cancelled or timed out)');
    };

    // What the turn condensed so far (#3819). A turn resumed after a pause
    // carries its digests in the transcript: refs and digest numbers go on
    // from there, and the recall tool is offered again.
    const condensedSoFar = condensedStateOf(ctx.messages);
    ctx.compaction = {
      nextRef: condensedSoFar.nextRef,
      digests: condensedSoFar.digests,
      // Carried over a pause: the cap and the failures hold for the whole run.
      count: condensedSoFar.summarized,
      failures: condensedSoFar.failures,
      recalls: 0,
      archive: new Map(),
      archiveLoading: null,
      archiveRuns: [],
      // Calls that failed when they ran: their result may later be elided or
      // bounded and no longer say so (shrinkFailedToolCalls).
      failedCallIds: new Set(),
      // A turn resumed after a pause that had wrapped up stays wrapped up:
      // its transcript holds the wrap-up nudge after its user message.
      ...(wrappedUpIn(ctx.messages) ? { wrapUp: true, wrapUpTold: true } : {}),
      // The prompt after the last digest (0: none yet), for the cooldown.
      lastTokensAfter: 0
    };
    if (condensedSoFar.nextRef > 1) this._offerRecall(ctx);

    const buildResult = (status, extra = {}) => ({
      runId,
      status,
      content,
      answerText,
      marking: (plan => (plan ? { text: plan } : null))(combineTextPlans(markingPlans)),
      finishReason: extra.finishReason ?? finishReason,
      usage: usage || { promptTokens: 0, completionTokens: 0, totalTokens: 0, source: 'estimate' },
      stepUsage: lastStepUsage,
      runUsage: {
        promptTokens: runBudget.input,
        completionTokens: runBudget.output,
        totalTokens: runBudget.total
      },
      iterations: iteration,
      sources: ctx.sources,
      thoughtSignatures,
      images,
      disabledTools: [...ctx.disabledTools],
      budgetExhausted: forceFinish,
      budgetReason: forceReason,
      messages: ctx.messages,
      knowledgeSources: [...ctx.knowledgeSources],
      integrations: [...ctx.integrations],
      maxTokens: options.maxTokens ?? model.maxOutputTokens ?? null,
      durationMs: Date.now() - startedAt,
      ...extra
    });

    // Native web search the provider turns down (a 400 naming web search:
    // disabled for the organisation, unsupported by the model or a gateway)
    // degrades to the app's web search engine instead of failing the turn.
    // The rejection is remembered per model so later calls skip the doomed
    // request.
    const applyNativeWebSearchFallback = async reason => {
      const directive = nativeWebSearch;
      nativeWebSearch = null;
      let fallbackTools = [];
      try {
        fallbackTools = await this.resolveNativeWebSearchFallbackTools(directive, {
          app: options.appConfig,
          language: request.language,
          // The engine's group grant holds for the fallback tool too: a chat
          // carries the user in the provider options, a workflow node on the
          // request itself.
          user: request.user ?? options.user
        });
      } catch (err) {
        this.logger.warn('Could not resolve the native web search fallback tool', {
          component: COMPONENT,
          runId,
          error: err?.message
        });
      }
      const added = [];
      for (const tool of fallbackTools || []) {
        if (tool && !tools.some(t => t.id === tool.id)) {
          tools.push(tool);
          added.push(tool.id);
        }
      }
      this.logger.warn('Native web search unavailable — falling back to a search tool', {
        component: COMPONENT,
        runId,
        modelId: model.id,
        provider: directive?.provider,
        reason,
        fallbackTools: added
      });
    };

    if (nativeWebSearch && isNativeWebSearchUnavailable(model.id)) {
      await applyNativeWebSearchFallback('provider rejected native web search earlier');
    }

    /** The result of a run a seam ended (pause, passthrough answer, refusal). */
    const terminalResult = terminal =>
      buildResult(terminal.status || 'completed', {
        finishReason: terminal.finishReason || finishReason,
        pendingInteraction: terminal.pendingInteraction,
        content: terminal.content !== undefined ? content + terminal.content : content,
        ...(terminal.error ? { error: terminal.error } : {}),
        terminate: terminal
      });

    try {
      // ── resume: run the one call a person approved ─────────────────────
      // A turn that paused on an approval continues here: the transcript ends
      // with the model's tool call and an `awaiting_approval` placeholder for
      // it. The call runs with exactly the arguments that were approved (the
      // model is not asked to issue it again) and its result takes the
      // placeholder's place; then the model continues as usual.
      // A resume after a connect (#3752) names several calls (`toolCalls`);
      // they run in order, each once, and the first one a seam ends (an
      // approval it asks for) ends the run, as it does for any call.
      let resumedCalls = [];
      if (toolExecution === 'server') {
        if (Array.isArray(request.resume?.toolCalls)) resumedCalls = request.resume.toolCalls;
        else if (request.resume?.toolCall) resumedCalls = [request.resume];
      }
      for (const [position, resumed] of resumedCalls.entries()) {
        const call = resumed.toolCall;
        // The model found the tool with `search_tools` in the request that
        // paused: this request starts with it left out again, so loading it is
        // part of running the call a person approved.
        let approvedTool = matchTool(call.function?.name, tools);
        if (!approvedTool) {
          approvedTool = toolSearch?.take(call.function?.name) || null;
          if (approvedTool) tools.push(approvedTool);
        }
        const item = {
          call,
          toolDef: approvedTool,
          args: resumed.args && typeof resumed.args === 'object' ? resumed.args : {},
          argsRepaired: false,
          position
        };
        ctx.iteration = 0;
        const outcome = await this._executeOne(ctx, item, {
          seams,
          iteration: 0,
          groupIndex: 0,
          toolExecution
        });
        const [first, ...rest] = outcome.messages;
        const placeholder = ctx.messages.findIndex(
          m => m?.role === 'tool' && m.tool_call_id === call.id
        );
        if (first && placeholder >= 0) ctx.messages.splice(placeholder, 1, first);
        else if (first) ctx.messages.push(first);
        // A circuit-breaker nudge (a user message) goes after the tool block.
        for (const message of rest) ctx.messages.push(message);
        if (outcome.terminate) return terminalResult(outcome.terminate);
      }

      // Past the round cap, exactly one more call is allowed when a budget gate
      // fired on the last round without a tool-less final call having been
      // made yet (a cap of 1 spends its only round on tools).
      while (iteration < maxRounds || (forceFinish && !forcedFinalOffered)) {
        iteration++;
        ctx.iteration = iteration;
        assertNotAborted();

        // Human steer messages queued for this run are delivered here, at the
        // step boundary, inside an explicit trust marker (see steering.js).
        for (const steer of takeSteers(runId)) {
          const message = steerMessage(steer);
          ctx.messages.push(message);
          this._ledger(ledgerId, RUN_LOG_EVENTS.MESSAGE_USER, {
            step: iteration,
            content: message.content,
            synthetic: 'steer'
          });
        }

        // `streamEnd` closes this model call whichever way it ends, so it
        // wraps everything from `preStep` on: a seam that armed something in
        // `preStep` is told even when a later hook, the request or the stream
        // fails.
        let result;
        let streamOutcome = 'error';
        let choicePlan = null;
        try {
          await runHooks(seams, 'preStep', ctx);

          // Wrapping up (the context is nearly full): told once, and the
          // tools that gather more — searches, page reads — are withdrawn;
          // the tools that make the answer's files stay.
          const wrapUp = ctx.compaction?.wrapUp === true;
          if (wrapUp && !ctx.compaction.wrapUpTold) {
            ctx.compaction.wrapUpTold = true;
            ctx.messages.push(nudgeMessage(CONTEXT_WRAP_UP_NUDGE));
          }
          const availableTools = tools.filter(
            t => !ctx.disabledTools.has(t.id) && !(wrapUp && gathers(t))
          );
          const offeredTools =
            availableTools.length > 0 && !forceFinish ? availableTools : undefined;
          ctx.offeredTools = offeredTools || [];

          // "Call a tool first": forced through the provider where the model
          // takes it, as a one-off instruction after the conversation where it
          // does not. Never kept in the transcript.
          choicePlan = planToolChoice({
            choice: policies.tools.choice,
            offeredTools,
            iteration,
            priorToolUse,
            model,
            forcedRejected: forcedToolUseRejected
          });

          callMessageCount = ctx.messages.length;
          const stream = await this.llmClient.execute({
            model,
            messages: choicePlan.nudge
              ? [...ctx.messages, nudgeMessage(choicePlan.nudge)]
              : ctx.messages,
            options: {
              ...options,
              ...(choicePlan.force ? { toolChoice: 'required' } : {}),
              tools: offeredTools,
              nativeWebSearch: forceFinish || ctx.compaction?.wrapUp ? null : nativeWebSearch,
              responseSchema,
              responseFormat: options.responseFormat
            },
            language: request.language,
            signal,
            timeoutMs: request.timeoutMs,
            telemetry: {
              runId,
              step: iteration,
              purpose,
              toolExecution: offeredTools ? toolExecution : 'none',
              segment: segmentId,
              appId: ctx.refs.appId,
              userId: ctx.refs.userId,
              chatId: ctx.refs.chatId,
              executionId: ctx.refs.executionId,
              // A workflow or agent run carries its user on the request, not in
              // the provider options: name it on the usage record only (no
              // usage-limit enforcement for workflows).
              reportUser: request.user ?? null
            }
          });
          ctx.stream = stream;
          for await (const chunk of stream) {
            for (const seam of seams) {
              if (typeof seam.onChunk === 'function') await seam.onChunk(ctx, chunk);
            }
            if (ctx.channel?.onChunk) await ctx.channel.onChunk(chunk, ctx);
            // What a model adapter found (iAssistant) and what provider-run web
            // search reported, as it streams in.
            // A model adapter's own sources are iAssistant's: its documents.
            if (chunk.sources) {
              await ctx.addSources(chunk.sources, {
                step: iteration,
                defaults: { origin: { kind: 'iassistant' } }
              });
            }
            if (chunk.groundingMetadata) {
              await ctx.addSources(sourcesFromGrounding(chunk.groundingMetadata), {
                step: iteration
              });
            }
          }
          result = stream.result();
          streamOutcome = 'completed';
        } catch (err) {
          streamOutcome = isAbortError(err) || signal?.aborted ? 'aborted' : 'error';
          // The provider turned down the forced call (the newest Claude models
          // do, as does extended thinking): remember it for this model and
          // retry the same round, which now asks in words instead.
          if (choicePlan?.force && !isAbortError(err) && isToolChoiceRejection(err)) {
            forcedToolUseRejected = true;
            markForcedToolUseUnavailable(model.id, { reason: err.message });
            this.logger.warn('Provider rejected a forced tool call — asking for one in words', {
              component: COMPONENT,
              runId,
              modelId: model.id,
              provider: model.provider,
              reason: err.message
            });
            iteration--;
            continue;
          }
          if (nativeWebSearch && !isAbortError(err) && isNativeWebSearchRejection(err)) {
            markNativeWebSearchUnavailable(model.id, { reason: err.message });
            await applyNativeWebSearchFallback(err.message);
            iteration--;
            continue;
          }
          if (
            !isAbortError(err) &&
            isContextOverflowError(err) &&
            reactiveAttempts < policies.context.maxReactiveAttempts
          ) {
            // A digest first: everything but the newest batch condensed to its
            // calls and sources, without a model call, and still readable by
            // ref. Only when that frees nothing are old bodies collapsed.
            if (policies.context.strategy === 'digest') {
              const freed = await this._digestCompaction(ctx, {
                seams,
                iteration,
                knownTokens: undefined,
                runBudget,
                options,
                overflow: true
              });
              if (freed > 0) {
                reactiveAttempts++;
                promptAnchor = null;
                iteration--;
                continue;
              }
            }
            const mc = microcompactMessages(ctx.messages, {
              keepRecent: policies.context.reactiveKeepRecent
            });
            if (mc.freedChars > 0) {
              reactiveAttempts++;
              const elided = elisionInfo(ctx.messages, mc, {
                step: iteration,
                trigger: 'overflow',
                fallbackReason: 'context_overflow'
              });
              const freedByMessage = freedByMessageOf(ctx.messages, mc.messages);
              ctx.messages = mc.messages;
              promptAnchor = null;
              this.logger.warn('Reactive context recovery: microcompacted messages, retrying', {
                component: COMPONENT,
                runId,
                attempt: reactiveAttempts,
                freedChars: mc.freedChars,
                collapsed: mc.collapsed
              });
              this._ledger(ledgerId, RUN_LOG_EVENTS.CONTEXT_COMPACTION, elided);
              await runHooks(seams, 'onCompaction', ctx, {
                ...mc,
                ...elided,
                freedByMessage
              });
              iteration--;
              continue;
            }
            // Nothing left to condense or shorten: long arguments of calls
            // that were refused (a model resending a broken workbook), then,
            // as a last resort, an answer without tools — the tool list
            // leaves the prompt, and the turn ends with an answer, not an
            // error.
            const shrunk = shrinkFailedToolCalls(ctx.messages, {
              failedIds: ctx.compaction?.failedCallIds
            });
            if (shrunk.freedChars > 0) {
              reactiveAttempts++;
              ctx.messages = shrunk.messages;
              promptAnchor = null;
              this.logger.warn('Reactive context recovery: shortened failed tool calls, retrying', {
                component: COMPONENT,
                runId,
                attempt: reactiveAttempts,
                freedChars: shrunk.freedChars,
                shortened: shrunk.shortened
              });
              iteration--;
              continue;
            }
            // Only when the call offered tools or native web search (a
            // wrap-up has withdrawn that already): without them the retry
            // would send the same prompt again.
            const sentNativeSearch = !!nativeWebSearch && !ctx.compaction?.wrapUp;
            if (!forceFinish && (ctx.offeredTools.length > 0 || sentNativeSearch)) {
              reactiveAttempts++;
              forceFinish = true;
              ctx.messages.push(nudgeMessage(CONTEXT_FULL_NUDGE));
              promptAnchor = null;
              this.logger.warn('Reactive context recovery: answering without tools', {
                component: COMPONENT,
                runId,
                attempt: reactiveAttempts
              });
              iteration--;
              continue;
            }
          }
          throw err;
        } finally {
          const endInfo =
            streamOutcome === 'completed'
              ? { outcome: streamOutcome, result }
              : { outcome: streamOutcome };
          // One seam at a time: a display hook must never replace the failure it
          // is reporting, nor stop the seams after it from learning that the call
          // ended (`chatToolSeam` stops its waiting timer here).
          for (const seam of seams) {
            if (typeof seam?.streamEnd !== 'function') continue;
            try {
              await seam.streamEnd(ctx, endInfo);
            } catch (hookErr) {
              this.logger.warn('streamEnd seam failed', {
                component: COMPONENT,
                runId,
                seam: seam?.name,
                error: hookErr?.message
              });
            }
          }
        }

        // ── consume the step result ─────────────────────────────────────
        // `stepText` is what this step answered, `content` the run's running total.
        let stepText = result.content || '';
        if (result.content) content += result.content;
        if (result.finishReason) finishReason = result.finishReason;
        if (result.thoughtSignatures?.length) thoughtSignatures.push(...result.thoughtSignatures);
        if (result.images?.length) images.push(...result.images);

        let toolCalls = (result.toolCalls || []).filter(c => c.function?.name?.trim());
        if (responseSchema && toolCalls.length > 0) {
          // Anthropic implements structured output as a synthetic `json` tool call.
          const jsonCall = toolCalls.find(c => c.function.name === 'json');
          if (jsonCall?.function?.arguments) {
            content += jsonCall.function.arguments;
            stepText += jsonCall.function.arguments;
            toolCalls = toolCalls.filter(c => c !== jsonCall);
          }
        }
        answerText = stepText;
        if (stepText) markingPlans.push(result.marking?.text ?? null);

        const stepUsage = result.usage
          ? result.usage
          : normalizeUsage(
              {
                // Per message, remembered on it: earlier messages are not counted again.
                promptTokens: estimateTranscriptTokens(ctx.messages),
                completionTokens: estimateTokens(result.content || '')
              },
              'estimate'
            );
        usage = addUsage(usage, stepUsage);
        lastStepUsage = stepUsage;
        promptAnchor =
          result.usage &&
          result.usage.source !== 'estimate' &&
          Number(result.usage.promptTokens) > 0
            ? { tokens: Number(result.usage.promptTokens), messageCount: callMessageCount }
            : null;
        runBudget.input += stepUsage.promptTokens || 0;
        runBudget.output += stepUsage.completionTokens || 0;
        runBudget.total = runBudget.input + runBudget.output;

        this._ledger(ledgerId, RUN_LOG_EVENTS.MESSAGE_ASSISTANT, {
          step: iteration,
          requestId: result.requestId,
          content: result.content || '',
          toolCalls: toolCalls.map(c => ({
            id: c.id || `${c.index}`,
            index: c.index,
            type: c.type || 'function',
            name: c.function.name,
            arguments: c.function.arguments || '',
            metadata: c.metadata
          })),
          usage: result.usage || undefined,
          finishReason: result.finishReason,
          hasImages: (result.images || []).length > 0,
          groundingMetadata: result.groundingMetadata || undefined
        });
        this._ledger(ledgerId, RUN_LOG_EVENTS.BUDGET_CHECKPOINT, {
          step: iteration,
          usage: stepUsage,
          runUsage: {
            promptTokens: runBudget.input,
            completionTokens: runBudget.output,
            totalTokens: runBudget.total
          },
          limits: { maxTokensPerRun, maxToolRounds: maxRounds }
        });

        await runHooks(seams, 'stepEnd', ctx, {
          iteration,
          result,
          usage: stepUsage,
          runBudget,
          toolCalls
        });

        if (forceFinish) forcedFinalOffered = true;

        if (toolCalls.length === 0) {
          if (!finishReason) finishReason = result.finishReason || 'stop';
          // A seam may reject the final answer and ask for one more attempt
          // (structured-output validation). The rejected answer and the
          // correction go into the transcript, and the answer starts over, so
          // the run's content is the accepted attempt alone. Only while a
          // round is left; otherwise the seam sees `canRetry: false` and the
          // answer stands as it is.
          const canRetry = !forceFinish && iteration < maxRounds;
          const review = await runHooks(seams, 'onAnswer', ctx, {
            content,
            stepText,
            finishReason,
            iteration,
            canRetry
          });
          if (canRetry && typeof review?.retry === 'string' && review.retry) {
            if (review.error) {
              this._ledger(ledgerId, RUN_LOG_EVENTS.ERROR, {
                step: iteration,
                code: String(review.error.code || 'ANSWER_REJECTED'),
                message: String(review.error.message || 'Answer rejected'),
                recoverable: true
              });
            }
            // Providers refuse an empty assistant message; an empty answer
            // is still an answer the correction refers to.
            ctx.messages.push({ role: 'assistant', content: stepText || '(no answer)' });
            ctx.messages.push(nudgeMessage(review.retry));
            this._ledger(ledgerId, RUN_LOG_EVENTS.MESSAGE_USER, {
              step: iteration,
              content: review.retry,
              synthetic: 'nudge'
            });
            content = '';
            finishReason = null;
            continue;
          }
          break;
        }

        if (toolExecution === 'caller') {
          // Degenerate run: hand the calls back; never execute, compact or ask.
          return buildResult('completed', {
            finishReason: 'tool_calls',
            toolCalls: toolCalls.map(c => ({
              id: c.id,
              index: c.index,
              name: c.function.name,
              arguments: repairToolArguments(c.function.arguments).args,
              rawArguments: c.function.arguments,
              metadata: c.metadata
            }))
          });
        }

        if (forceFinish) {
          finishReason = 'budget_exhausted';
          break;
        }

        const repairs = toolCalls.map(call => repairToolArguments(call.function.arguments));
        const assistantMessage = {
          role: 'assistant',
          content: result.content || null,
          // Replay the arguments the tools run with, as JSON. A call without
          // arguments streams `''` and broken JSON gets repaired; strict
          // OpenAI-compatible servers (Ollama) reject either in history.
          tool_calls: toolCalls.map((call, i) => ({
            ...call,
            function: { ...call.function, arguments: JSON.stringify(repairs[i].args) }
          }))
        };
        if (result.thoughtSignatures?.length)
          assistantMessage.thoughtSignatures = result.thoughtSignatures;
        ctx.messages.push(assistantMessage);

        // ── execute the tool calls (segment planner → batches) ──────────
        const resolved = toolCalls.map((call, i) => {
          const toolDef = matchTool(call.function.name, tools);
          const repair = repairs[i];
          const args = applyParameterDefaults(repair.args, toolDef);
          return { call, toolDef, args, argsRepaired: repair.repaired };
        });
        const batches = planToolBatches(resolved, policies.tools);
        const outcomes = new Array(resolved.length);
        let aborted = false;

        for (let groupIndex = 0; groupIndex < batches.length; groupIndex++) {
          const batch = batches[groupIndex];
          if (terminal || aborted) break;
          try {
            assertNotAborted();
          } catch (err) {
            aborted = err;
            break;
          }
          const settled = await Promise.all(
            batch.map(item =>
              this._executeOne(ctx, item, {
                seams,
                iteration,
                groupIndex,
                toolExecution
              }).catch(err => ({ position: item.position, error: err }))
            )
          );
          for (const outcome of settled) outcomes[outcome.position] = outcome;
          const abortedOutcome = settled.find(o => o.error && isAbortError(o.error));
          if (abortedOutcome) aborted = abortedOutcome.error;
          const terminating = settled.find(o => o.terminate);
          if (terminating) terminal = terminating.terminate;
        }

        // Append messages in the model's original call order; calls that never ran
        // (abort / termination) get synthetic results so the transcript stays consistent.
        for (let i = 0; i < resolved.length; i++) {
          const item = resolved[i];
          const outcome = outcomes[i];
          if (outcome?.error && !isAbortError(outcome.error)) {
            ctx.messages.push({
              role: 'tool',
              tool_call_id: item.call.id,
              name: item.call.function.name,
              content: JSON.stringify({ error: true, message: outcome.error.message })
            });
            continue;
          }
          if (!outcome || outcome.error) {
            ctx.messages.push({
              role: 'tool',
              tool_call_id: item.call.id,
              name: item.call.function.name,
              content: JSON.stringify({
                error: true,
                message: aborted ? 'aborted' : 'not executed (turn ended)'
              })
            });
            continue;
          }
          for (const message of outcome.messages) ctx.messages.push(message);
        }

        if (aborted) throw aborted;
        if (terminal) return terminalResult(terminal);

        // ── failed calls sent again: only the newest attempt in full ────
        const retried = elideRetriedCallArguments(ctx.messages);
        if (retried.collapsed > 0) {
          // Per message, so a context figure anchored on a provider count is
          // rebased only by what was freed inside it.
          const freedByMessage = freedByMessageOf(ctx.messages, retried.messages);
          ctx.messages = retried.messages;
          promptAnchor = null;
          this.logger.info('Shortened the arguments of failed tool calls sent again', {
            component: COMPONENT,
            runId,
            iteration,
            collapsed: retried.collapsed,
            freedChars: retried.freedChars
          });
          this._ledger(ledgerId, RUN_LOG_EVENTS.CONTEXT_COMPACTION, {
            step: iteration,
            trigger: 'retried_call',
            collapsed: retried.collapsed,
            freedChars: retried.freedChars
          });
          await runHooks(seams, 'onCompaction', ctx, {
            trigger: 'retried_call',
            ...retried,
            freedByMessage,
            freedTokens: freedByMessage.reduce((sum, [, tokens]) => sum + tokens, 0)
          });
        }

        // ── proactive compaction ────────────────────────────────────────
        const knownTokens = promptAnchor
          ? promptAnchor.tokens +
            estimateTranscriptTokens(ctx.messages.slice(promptAnchor.messageCount))
          : undefined;
        if (policies.context.strategy === 'digest') {
          // Older tool batches become a findings digest (#3819). The next
          // model call sets the anchor anew before it is read again; the
          // live context figure is rebased by the `onCompaction` seam.
          let freed = await this._digestCompaction(ctx, {
            seams,
            iteration,
            knownTokens,
            runBudget,
            options
          });
          // Still near the window with the newest batch kept: it is condensed
          // too, before the run wraps up.
          if (ctx.compaction.condenseNewest) {
            ctx.compaction.condenseNewest = false;
            const known =
              Number.isFinite(knownTokens) && knownTokens > 0
                ? Math.max(0, knownTokens - freed)
                : undefined;
            const more = await this._digestCompaction(ctx, {
              seams,
              iteration,
              knownTokens: known,
              runBudget,
              options,
              keepNone: true
            });
            if (more === 0) this._wrapUpIfFull(ctx, options, known);
            freed += more;
          }
          if (freed === 0) this._wrapUpIfFull(ctx, options, knownTokens);
        } else {
          const compaction = compactIfOversized(ctx.messages, {
            thresholdTokens: policies.context.compactThresholdTokens,
            keepRecent: policies.context.compactKeepRecent,
            knownTokens
          });
          if (compaction.compacted) {
            const elided = elisionInfo(ctx.messages, compaction, {
              step: iteration,
              trigger: 'proactive',
              knownTokens
            });
            const freedByMessage = freedByMessageOf(ctx.messages, compaction.messages);
            ctx.messages = compaction.messages;
            promptAnchor = null;
            this.logger.info('Proactively compacted agent context', {
              component: COMPONENT,
              runId,
              iteration,
              collapsed: compaction.collapsed,
              freedChars: compaction.freedChars
            });
            this._ledger(ledgerId, RUN_LOG_EVENTS.CONTEXT_COMPACTION, elided);
            await runHooks(seams, 'onCompaction', ctx, {
              ...compaction,
              ...elided,
              freedByMessage
            });
          }
        }

        // ── force-finish gates: exactly one per iteration ───────────────
        // The recall tool only reads this run's own results: it keeps no turn going.
        const workingTools = tools.filter(t => !t.isCompactionRecall);
        if (workingTools.length > 0 && workingTools.every(t => ctx.disabledTools.has(t.id))) {
          forceFinish = true;
          forceReason = 'tools_dead';
          ctx.messages.push(nudgeMessage(ALL_TOOLS_DEAD_NUDGE));
          this._ledger(ledgerId, RUN_LOG_EVENTS.BUDGET_EXHAUSTED, {
            step: iteration,
            reason: 'tools_dead',
            limits: { maxTokensPerRun, maxToolRounds: maxRounds }
          });
        } else if (maxTokensPerRun > 0 && runBudget.total >= maxTokensPerRun) {
          forceFinish = true;
          forceReason = 'tokens';
          ctx.messages.push(
            nudgeMessage(tokenBudgetNudge({ spent: runBudget.total, max: maxTokensPerRun }))
          );
          this._ledger(ledgerId, RUN_LOG_EVENTS.BUDGET_EXHAUSTED, {
            step: iteration,
            reason: 'tokens',
            runUsage: {
              promptTokens: runBudget.input,
              completionTokens: runBudget.output,
              totalTokens: runBudget.total
            },
            limits: { maxTokensPerRun, maxToolRounds: maxRounds }
          });
        } else if (iteration >= maxRounds - 1) {
          forceFinish = true;
          forceReason = 'rounds';
          ctx.messages.push(nudgeMessage(ROUND_CAP_NUDGE));
          this._ledger(ledgerId, RUN_LOG_EVENTS.BUDGET_EXHAUSTED, {
            step: iteration,
            reason: 'rounds',
            limits: { maxTokensPerRun, maxToolRounds: maxRounds }
          });
        }
      }

      const status =
        forceFinish && finishReason === 'budget_exhausted' ? 'budget_exhausted' : 'completed';
      return buildResult(status);
    } catch (caught) {
      // A model call or tool cut short by the wall-clock deadline surfaces as
      // an abort; report it as the budget failure it is.
      const err = deadline?.signal.aborted && isAbortError(caught) ? wallClockError() : caught;
      const llmErr = isLLMError(err) ? err : null;
      // A failed model call is already in the ledger, written by the client.
      const ledgered = isErrorLedgered(err, ledgerId);
      if (isAbortError(err)) {
        if (!ledgered) {
          this._ledger(ledgerId, RUN_LOG_EVENTS.ERROR, {
            step: iteration,
            code: LLM_ERROR_CODES.ABORTED,
            message: err.message,
            recoverable: false
          });
        }
        return buildResult('aborted', { error: err, finishReason: 'aborted' });
      }
      if (!ledgered) {
        this._ledger(ledgerId, RUN_LOG_EVENTS.ERROR, {
          step: iteration,
          code: llmErr?.code || 'LOOP_ERROR',
          message: err.message,
          providerCode: llmErr?.providerCode ?? null,
          status: llmErr?.status ?? null,
          recoverable: false
        });
      }
      return buildResult('error', { error: err, finishReason: 'error' });
    } finally {
      if (deadlineTimer) clearTimeout(deadlineTimer);
    }
  }

  /**
   * Keep the transcript bounded: a tool result above
   * `policies.context.spillThresholdBytes` is stored in the run's spill store
   * (when the ledger persists) and replaced by a preview plus reference, so a
   * large tool response neither fills the heap nor the next model call.
   * @private
   * @returns {Promise<{message: Object, bytes: number, spillRef: Object|null}>}
   */
  async _boundToolMessage(ctx, message, { call, toolId, iteration }) {
    const content = message?.content;
    const bytes = typeof content === 'string' ? Buffer.byteLength(content, 'utf8') : 0;
    const threshold = ctx.policies.context.spillThresholdBytes;
    if (typeof content !== 'string' || !threshold || bytes <= threshold) {
      return { message, bytes, spillRef: null };
    }
    let spillRef = null;
    if (ctx.ledgerId && typeof ctx.runLog?.spill === 'function') {
      try {
        spillRef = await ctx.runLog.spill(
          ctx.ledgerId,
          `tool-${iteration}-${call.id || call.index || 0}`,
          content,
          looksLikeJson(content) ? 'application/json' : 'text/plain'
        );
      } catch (err) {
        this.logger.warn('Tool result spill failed; keeping the preview only', {
          component: COMPONENT,
          runId: ctx.runId,
          tool: toolId,
          error: err.message
        });
      }
    }
    const previewChars = Math.min(SPILL_PREVIEW_CHARS, threshold);
    const bounded = {
      truncated: true,
      bytes,
      preview: content.slice(0, previewChars),
      ...(spillRef ? { spill: { path: spillRef.path, sha256: spillRef.sha256 } } : {}),
      note:
        `Tool result of ${bytes} bytes exceeded the transcript limit of ${threshold} bytes; ` +
        `only the first ${previewChars} characters are included.`
    };
    this.logger.info('Tool result exceeded the transcript limit', {
      component: COMPONENT,
      runId: ctx.runId,
      tool: toolId,
      bytes,
      threshold,
      spilled: !!spillRef
    });
    return { message: { ...message, content: JSON.stringify(bounded) }, bytes, spillRef };
  }

  /**
   * Execute one resolved tool call through the seams.
   * @private
   * @returns {Promise<{position:number, messages:Array, terminate?:Object}>}
   */
  async _executeOne(ctx, item, { seams, iteration, groupIndex, toolExecution }) {
    const { call, toolDef, args, argsRepaired, position } = item;
    const toolId = toolDef?.id || call.function.name;
    const name = call.function.name;
    const ledgerId = ctx.ledgerId;
    const runId = ctx.runId;
    const started = Date.now();
    const messages = [];
    const info = { call, toolDef, toolId, name, args, argsRepaired, iteration, groupIndex };
    const display = startedDisplayOf(toolDef);

    if (ctx.signal?.aborted) throw abortError('Agent loop aborted (cancelled or timed out)');

    // Withdrawn for the wrap-up: a model can still repeat a search it saw
    // earlier in the turn. Refused before any seam sees it, so it asks for no
    // approval, is taken over by no passthrough and shows no search starting.
    if (ctx.compaction?.wrapUp && gathers(toolDef)) {
      const content = JSON.stringify(WITHDRAWN_RESULT);
      const callId = call.id || `${call.index}`;
      this._ledger(ledgerId, RUN_LOG_EVENTS.TOOL_CALL, {
        step: iteration,
        callId,
        toolId,
        name,
        ...display,
        args,
        argsRepaired,
        execution: toolExecution,
        parallelGroup: groupIndex
      });
      this._ledger(ledgerId, RUN_LOG_EVENTS.TOOL_RESULT, {
        step: iteration,
        callId,
        toolId,
        name,
        resultPreview: previewValue(content),
        resultBytes: content.length,
        error: { message: WITHDRAWN_RESULT.message, rateLimited: false },
        durationMs: 0
      });
      messages.push({ role: 'tool', tool_call_id: call.id, name, content });
      return { position, messages, terminate: null };
    }

    // pre-tool seams may take the call over (approval gate, question, passthrough)
    const handled = await runHooks(seams, 'preTool', ctx, info);
    if (handled) {
      this._ledger(ledgerId, RUN_LOG_EVENTS.TOOL_CALL, {
        step: iteration,
        callId: call.id || `${call.index}`,
        toolId,
        name,
        ...display,
        args,
        argsRepaired,
        execution: handled.execution || (toolDef?.passthrough ? 'passthrough' : 'clarification'),
        parallelGroup: groupIndex
      });
      if (handled.message) messages.push(handled.message);
      if (Array.isArray(handled.messages)) messages.push(...handled.messages);
      return { position, messages, terminate: handled.terminate || null };
    }

    this._ledger(ledgerId, RUN_LOG_EVENTS.TOOL_CALL, {
      step: iteration,
      callId: call.id || `${call.index}`,
      toolId,
      name,
      ...display,
      args,
      argsRepaired,
      execution: toolExecution,
      parallelGroup: groupIndex
    });
    if (ctx.channel?.onToolStart) await ctx.channel.onToolStart(info, ctx);

    let message;
    let rawResult;
    let failure = null;
    // Files a seam took out of the result before it was serialised (`liftResult`).
    let lifted = null;
    // Sources the call reports beside its result (services/sources/toolCallScope).
    const reported = [];
    // Where the call looked (projects, a search profile), by name, beside its result.
    const places = [];
    if (!toolDef) {
      const available = ctx.tools.map(t => t.id).filter(Boolean);
      const safeMessage =
        `Tool '${String(name).slice(0, 80)}' is not registered for this agent. ` +
        `Available tools: ${available.length ? available.join(', ') : '(none)'}. ` +
        `Pick one of those or stop calling tools.`;
      rawResult = { error: true, reason: 'tool_not_registered', message: safeMessage };
      message = {
        role: 'tool',
        tool_call_id: call.id,
        name,
        content: JSON.stringify(rawResult)
      };
      await runHooks(seams, 'onHallucinated', ctx, {
        ...info,
        availableTools: available,
        message: safeMessage
      });
    } else {
      try {
        if (toolDef.isCompactionRecall) {
          // A condensed result read again by ref (#3819): answered from this
          // run's own results, never from a path the model names.
          rawResult = await this._recall(ctx, args);
        } else if (toolDef.isToolSearch && ctx.toolSearch) {
          // `search_tools` answers from the tools this request left out, and
          // what it finds joins the tools the model is offered from its next
          // step on (`availableTools` is read again on every round).
          const { text, found } = ctx.toolSearch.search(args);
          for (const tool of found) {
            if (!ctx.tools.some(t => t.id === tool.id)) ctx.tools.push(tool);
          }
          rawResult = text;
        } else {
          if (typeof ctx.request.executeTool !== 'function') {
            throw new LLMError(`No tool executor configured for '${toolId}'`, {
              code: LLM_ERROR_CODES.INVALID_REQUEST,
              providerCode: 'NO_TOOL_EXECUTOR'
            });
          }
          rawResult = await raceAbort(
            () =>
              runToolCallScope(
                reported,
                () =>
                  ctx.request.executeTool(call, {
                    toolDef,
                    toolId,
                    args,
                    ctx,
                    info,
                    signal: ctx.signal
                  }),
                ctx.toolTurn,
                places
              ),
            ctx.signal,
            () => abortError('Agent loop aborted (cancelled or timed out)')
          );
        }
        if (
          rawResult &&
          typeof rawResult === 'object' &&
          rawResult.role === 'tool' &&
          rawResult.tool_call_id
        ) {
          message = rawResult;
          rawResult = undefined;
        } else {
          // A seam may take binary payloads out of the result (an MCP tool's
          // base64 blocks) before it is serialised and bounded, so they never
          // reach the transcript or the run log's spill store.
          const holder = { rawResult };
          await runHooks(seams, 'liftResult', ctx, info, holder);
          rawResult = holder.rawResult;
          lifted = holder.lifted || null;
          message = {
            role: 'tool',
            tool_call_id: call.id,
            name,
            content: serializeToolContent(rawResult)
          };
        }
      } catch (err) {
        if (isAbortError(err)) throw err;
        failure = err;
        rawResult = {
          error: true,
          message: `Tool execution failed: ${err.message || 'Unknown error'}`
        };
        message = { role: 'tool', tool_call_id: call.id, name, content: JSON.stringify(rawResult) };
      }
    }

    // Whether the call failed, from the result as the tool returned it: once an
    // oversized result is bounded, the transcript holds a preview wrapper that
    // no longer says so.
    // Only a result the loop condensed may start like a condensed stub.
    if (isCondensedContent(message.content)) {
      message = { ...message, content: escapeCondensedPrefix(message.content) };
    }
    const callFailed =
      !!failure || classifyToolResult(message).failed || isFailedResult(message.content);
    if (callFailed && call.id) ctx.compaction?.failedCallIds.add(call.id);
    const bound = await this._boundToolMessage(ctx, message, { call, toolId, iteration });
    const outcome = {
      rawResult,
      message: bound.message,
      durationMs: Date.now() - started,
      error: failure,
      ...(places.length ? { places } : {}),
      ...(lifted ? { lifted } : {}),
      // What the call found, taken from the full result: the previews that
      // reach clients are too short to hold it (see services/sources).
      sources: extractToolSources({
        toolId,
        toolDef,
        args,
        result: rawResult ?? message.content,
        reported,
        failed: !!failure
      }),
      // What the call came to, declared from the full result: how many hits a
      // search returned, whether a read delivered text (`resultCount`,
      // `readOutcome`; absent when the result does not say).
      ...extractToolOutcome({
        toolId,
        toolDef,
        args,
        result: rawResult ?? message.content,
        failed: !!failure
      })
    };
    await runHooks(seams, 'postTool', ctx, info, outcome);
    messages.push(outcome.message);

    const verdict = classifyToolResult(outcome.message);
    // Where a search or fetch looked, and what it came to: the server's own
    // decision, counted so a call it cannot place shows up.
    if (display.activityKind === 'search' || display.activityKind === 'fetch') {
      recordToolCall(
        outcome.activityOrigin || display.activityOrigin,
        toolCallOutcomeOf(outcome, { failed: callFailed })
      );
    }
    this._ledger(ledgerId, RUN_LOG_EVENTS.TOOL_RESULT, {
      step: iteration,
      callId: call.id || `${call.index}`,
      toolId,
      name,
      resultPreview: previewValue(outcome.message.content),
      resultBytes: bound.bytes,
      ...(bound.spillRef ? { spillRef: bound.spillRef } : {}),
      error: verdict.failed
        ? { message: verdict.message, rateLimited: verdict.rateLimited }
        : undefined,
      durationMs: outcome.durationMs,
      hasImage: !!outcome.message.imageData,
      knowledgeSource: outcome.knowledgeSource,
      ...(outcome.activityOrigin ? { activityOrigin: outcome.activityOrigin } : {}),
      ...(Number.isInteger(outcome.resultCount) ? { resultCount: outcome.resultCount } : {}),
      ...(outcome.readOutcome ? { readOutcome: outcome.readOutcome } : {}),
      ...(outcome.places?.length ? { places: outcome.places } : {})
    });
    if (outcome.sources) {
      await ctx.addSources(outcome.sources, {
        step: iteration,
        callId: call.id || `${call.index}`,
        toolId
      });
    }
    if (ctx.channel?.onToolEnd) await ctx.channel.onToolEnd({ ...info, outcome, verdict }, ctx);

    // ── circuit breaker ───────────────────────────────────────────────
    const key = toolId;
    if (verdict.failed) {
      if (verdict.rateLimited) ctx._rateLimitFails = bump(ctx._rateLimitFails, key);
      ctx._consecutiveFails = bump(ctx._consecutiveFails, key);
    } else {
      ctx._consecutiveFails = reset(ctx._consecutiveFails, key);
    }
    const rl = ctx._rateLimitFails?.get(key) || 0;
    const streak = ctx._consecutiveFails?.get(key) || 0;
    const { maxRateLimitFailures, maxConsecutiveFailures } = ctx.policies.tools;
    const tripped =
      (verdict.rateLimited && rl >= maxRateLimitFailures) || streak >= maxConsecutiveFailures;
    if (tripped && !ctx.disabledTools.has(key)) {
      ctx.disabledTools.add(key);
      const reason = rl >= maxRateLimitFailures ? 'rate_limited' : 'repeated_failures';
      const count = reason === 'rate_limited' ? rl : streak;
      this.logger.warn('Tool circuit-broken — withholding for this segment', {
        component: COMPONENT,
        runId,
        tool: key,
        reason,
        failures: count
      });
      this._ledger(ledgerId, RUN_LOG_EVENTS.TOOL_DISABLED, {
        step: iteration,
        toolId: key,
        reason,
        failures: count,
        lastMessage: verdict.message?.slice(0, 200)
      });
      await runHooks(seams, 'onCircuitBroken', ctx, {
        tool: key,
        reason,
        failures: count,
        lastMessage: verdict.message,
        iteration
      });
      messages.push(
        nudgeMessage(
          toolDisabledNudge({
            toolId: key,
            reason,
            count,
            message: verdict.message,
            isSearch: isCitationProducing(toolDef)
          })
        )
      );
    }
    return { position, messages, terminate: null };
  }

  /**
   * Offer the tool that reads a condensed result again, once per run.
   * @private
   */
  _offerRecall(ctx) {
    if (ctx.policies.context.maxRecallsPerRun <= 0) return;
    if (ctx.tools.some(tool => tool?.id === RECALL_TOOL_ID)) return;
    ctx.tools.push(recallToolDefinition(ctx.request.language));
  }

  /**
   * Proactive compaction with a findings digest (#3819): when the prompt is
   * over the threshold, the oldest complete tool batches are condensed until
   * it is projected at `compactTargetShare` of the threshold. The decision
   * uses the provider's count (`knownTokens`), which holds the tool
   * definitions; only without one is the transcript estimated, tool
   * definitions included.
   *
   * The summary model pulls the facts out (`summarizeCalls`); when it fails,
   * the same batches still get a digest of their calls and sources, marked
   * `lossy`. After two failures, or `maxCompactionsPerRun` digests, the run
   * goes on with such digests without asking the model. An abort of the run
   * is thrown.
   *
   * @private
   * @returns {Promise<number>} the tokens freed (0 when nothing was condensed)
   */
  async _digestCompaction(
    ctx,
    { seams, iteration, knownTokens, runBudget, options, overflow = false, keepNone = false }
  ) {
    const policy = ctx.policies.context;
    const threshold = policy.compactThresholdTokens;
    const tokensBefore =
      Number.isFinite(knownTokens) && knownTokens > 0
        ? Math.round(knownTokens)
        : estimateTranscriptTokens(ctx.messages) + toolDefinitionTokens(ctx.offeredTools);
    // Near the model's window the next call may be refused as too long: then
    // neither the cooldown nor the second kept batch stands in the way. A
    // model whose output cap is large next to its window has its answer line
    // below the threshold: it condenses from there, before it would wrap up.
    const answerLine = this._answerLine(ctx, options);
    if (!overflow && tokensBefore <= Math.min(threshold, answerLine)) return 0;

    const state = ctx.compaction;
    const urgent = overflow || tokensBefore > answerLine;
    // The last compaction could not bring the prompt under the threshold (what
    // cannot be condensed — the system prompt, uploads, digests — is that
    // large): the next one waits until the prompt has grown by a tenth of the
    // threshold, instead of paying a summary call on every step.
    if (
      !urgent &&
      state.lastTokensAfter > threshold &&
      tokensBefore < state.lastTokensAfter + threshold * MIN_COMPACTION_PROGRESS
    ) {
      return 0;
    }
    const toolOf = name => matchTool(name, ctx.tools);
    const targetTokens = Math.floor(threshold * policy.compactTargetShare);
    // How many of the newest batches the selection kept as they are.
    let kept = keepNone ? 0 : overflow ? 1 : policy.digestKeepRecentBatches;
    let selection = selectBatches(ctx.messages, {
      tokensBefore,
      // After an overflow the estimate is below what the provider counted:
      // everything but the newest batch goes.
      targetTokens: overflow ? 0 : targetTokens,
      keepRecentBatches: kept,
      toolOf
    });
    // Urgent and the kept batches are what fills the window (large results,
    // a small window): keep only the newest, which the model has not read.
    if (urgent && !overflow && selection.projectedTokens > targetTokens && kept > 1) {
      kept = 1;
      selection = selectBatches(ctx.messages, {
        tokensBefore,
        targetTokens,
        keepRecentBatches: 1,
        toolOf
      });
    }
    // Still above the line with only the newest batch kept: that batch is
    // condensed too. The answer needs the room more than the raw pages do,
    // and its facts are in the notes.
    if (urgent && kept > 0 && selection.projectedTokens > answerLine) {
      kept = 0;
      selection = selectBatches(ctx.messages, {
        tokensBefore,
        targetTokens: overflow ? 0 : targetTokens,
        keepRecentBatches: 0,
        toolOf
      });
    }
    const { batches, freedTokens: projectedFreed } = selection;
    // Too little to free for what a compaction costs (a summary call, the
    // prompt cache from the first condensed message on, and of the tool list
    // when the recall tool joins it): left as it is. After an overflow any
    // room helps.
    if (
      batches.length === 0 ||
      (!overflow && projectedFreed < tokensBefore * MIN_COMPACTION_PROGRESS)
    ) {
      return 0;
    }
    const calls = collectCalls(ctx.messages, batches, { nextRef: state.nextRef, toolOf });
    if (calls.length === 0) return 0;
    // A digest never makes the transcript longer: it gets at most the room
    // the results leave, and results too short for one are left as they are.
    const digestNumber = state.digests + 1;
    const digestRoom = digestRoomOf(ctx.messages, calls, digestNumber);
    if (digestRoom < MIN_DIGEST_CHARS) return 0;
    // Nor more tokens: a repetitive result can count fewer than shorter,
    // denser notes. What a digest frees, by the same estimate as the prompt.
    const replaced = estimateTranscriptTokens(calls.map(call => ctx.messages[call.index]));
    const freedBy = text => {
      const next = applyDigest(ctx.messages, calls, text, digestNumber);
      return replaced - estimateTranscriptTokens(calls.map(call => next[call.index]));
    };
    // The smallest digest — calls and sources only — must free tokens with
    // whatever reason it may come to name, or the results are left as they
    // are: it is what a digest falls back to when a larger one would not.
    const smallest = reason =>
      renderDigest({
        number: digestNumber,
        calls,
        fallbackReason: reason,
        maxChars: MIN_DIGEST_CHARS
      });
    if ([null, ...DIGEST_FALLBACK_REASONS].some(reason => freedBy(smallest(reason).text) <= 0)) {
      return 0;
    }

    const started = Date.now();
    const compactionId = `cmp-${crypto.randomUUID().slice(0, 8)}`;
    const summaryModel = ctx.request.summaryModel || ctx.model;
    const info = {
      compactionId,
      step: iteration,
      trigger: overflow ? 'overflow' : 'proactive',
      strategy: 'digest',
      tokensBefore,
      itemsSummarised: calls.length,
      kinds: kindsOf(calls, toolDef => startedDisplayOf(toolDef).activityKind)
    };
    state.nextRef += calls.length;
    for (const call of calls) {
      state.archive.set(call.ref, {
        ref: call.ref,
        name: call.name,
        args: call.args,
        callId: call.callId,
        content: call.content
      });
    }
    await runHooks(seams, 'onCompactionStart', ctx, info);

    // The model is asked while it has not failed twice and the run is under its
    // cap — never after an overflow, which must free room before the retry.
    // The notes of the run are bounded: once their share of the window is
    // used up, a digest keeps calls and sources only, without a summary
    // call, and the run wraps up — more results could not be kept.
    const notesLeftTokens = this._notesLeftTokens(ctx, options);
    const notesLeft = Math.floor(notesLeftTokens * NOTES_CHARS_PER_TOKEN);
    const notesFull = notesLeft < MIN_DIGEST_CHARS;
    const useModel =
      !overflow && !notesFull && state.failures < 2 && state.count < policy.maxCompactionsPerRun;
    let summary = null;
    let fallbackReason = null;
    // A result over the spill threshold is a preview in the transcript: the
    // summary reads the original (the transcript stays bounded), or the
    // digest says the result was only partly read.
    const unread = useModel ? await this._readSpilledForSummary(ctx, calls) : 0;
    if (useModel) {
      try {
        summary = await summarizeCalls({
          llmClient: this.llmClient,
          model: summaryModel,
          calls,
          task: taskOf(ctx.messages),
          signal: ctx.signal,
          timeoutMs: policy.summaryTimeoutMs,
          maxTokens: policy.summaryMaxTokens,
          // The user the turn runs for: usage limits and reports count the summary.
          options: options.user ? { user: options.user } : {},
          language: ctx.request.language,
          // The room its lines have once condensed: told to the model, so it
          // chooses what to drop instead of losing the end of the notes.
          roomChars: factsRoomOf(
            Math.min(policy.maxDigestChars, digestRoom, Math.max(MIN_DIGEST_CHARS, notesLeft))
          ),
          telemetry: {
            // No ledger run of its own: the turn's `context/compaction` records it.
            autoRun: false,
            kind: 'utility',
            purpose: 'context-compaction',
            appId: ctx.refs.appId,
            chatId: ctx.refs.chatId,
            executionId: ctx.refs.executionId,
            reportUser: ctx.request.user ?? null
          }
        });
      } catch (err) {
        if (isAbortError(err)) throw err;
        // Stopped (or out of time) while the digest was written: the run ends as it would mid-step.
        if (ctx.signal?.aborted) throw abortError('Agent loop aborted (cancelled or timed out)');
        summary = null;
        this.logger.warn('Findings digest failed', {
          component: COMPONENT,
          runId: ctx.runId,
          error: err?.message
        });
      }
      fallbackReason = summaryFailureOf(summary, calls) || (unread > 0 ? 'summary_partial' : null);
      if (fallbackReason === 'summary_failed' || fallbackReason === 'summary_empty') {
        state.failures += 1;
      }
    } else {
      if (overflow) fallbackReason = 'context_overflow';
      else fallbackReason = state.failures >= 2 ? 'summary_unavailable' : 'compaction_limit';
    }
    if (summary?.usage) {
      runBudget.input += summary.usage.promptTokens || 0;
      runBudget.output += summary.usage.completionTokens || 0;
      runBudget.total = runBudget.input + runBudget.output;
    }

    const factsFound = summary?.facts?.length || 0;
    const notFoundFound = summary?.notFound?.length || 0;
    const render = maxChars =>
      renderDigest({
        number: digestNumber,
        calls,
        facts: summary?.facts || [],
        notFound: summary?.notFound || [],
        fallbackReason,
        maxChars
      });
    // Within the characters the results leave, then smaller until it frees
    // tokens too; at the smallest size, calls and sources only.
    let digestChars = Math.min(
      policy.maxDigestChars,
      digestRoom,
      Math.max(MIN_DIGEST_CHARS, notesLeft)
    );
    // The notes budget is in tokens: dense figures can take more of them than
    // the characters suggest.
    const overNotes = text =>
      estimateTranscriptTokens([{ role: 'tool', content: text }]) > notesLeftTokens;
    let rendered = render(digestChars);
    while (
      (freedBy(rendered.text) <= 0 || overNotes(rendered.text)) &&
      digestChars > MIN_DIGEST_CHARS
    ) {
      digestChars = Math.max(MIN_DIGEST_CHARS, Math.floor(digestChars * 0.7));
      rendered = render(digestChars);
    }
    // At the smallest size and still freeing nothing, or still over what the
    // notes have left: calls and sources only. The notes are then spent, and
    // the run wraps up — more results could not be kept.
    const notesSpent = overNotes(rendered.text);
    if (freedBy(rendered.text) <= 0 || notesSpent) {
      rendered = smallest(
        fallbackReason || (factsFound + notFoundFound > 0 ? 'digest_truncated' : null)
      );
    }
    const { text: digestText, factsShown, notFoundShown } = rendered;
    // Findings that did not fit — facts or what was not found — are in the
    // results only (the model is told to read them again): the compaction
    // lost something the summary had.
    if (!fallbackReason && (factsShown < factsFound || notFoundShown < notFoundFound)) {
      fallbackReason = 'digest_truncated';
    }
    const before = calls.map(call => ctx.messages[call.index]);
    const next = applyDigest(ctx.messages, calls, digestText, digestNumber);
    const after = calls.map(call => next[call.index]);
    const freedTokens = Math.max(
      0,
      estimateTranscriptTokens(before) - estimateTranscriptTokens(after)
    );
    const freedChars = Math.max(
      0,
      before.reduce((n, m) => n + String(m?.content ?? '').length, 0) -
        after.reduce((n, m) => n + String(m?.content ?? '').length, 0)
    );
    ctx.messages = next;
    state.digests = digestNumber;
    // `maxCompactionsPerRun` counts the digests the summary model was asked for.
    if (useModel) state.count += 1;
    state.lastTokensAfter = Math.max(0, tokensBefore - freedTokens);
    this._offerRecall(ctx);

    // The originals and a long digest go to the run's spill store: the
    // recall tool reads them after a resume, an admin from the journal.
    const archiveRef = await this._spill(ctx, `${compactionId}-results`, {
      refs: Object.fromEntries(calls.map(call => [call.ref, state.archive.get(call.ref)]))
    });
    const summaryRef =
      digestText.length > MAX_COMPACTION_DIGEST_CHARS
        ? await this._spill(ctx, `${compactionId}-digest`, digestText, 'text/plain')
        : null;

    // Still near the window after condensing: no room for more results and
    // the answer. The run wraps up — gathering stops, the answer is written.
    // Only once nothing is left to condense: when the projection let the
    // newest batch stay and the digest turned out larger, that batch goes
    // next (`condenseNewest`), before gathering stops.
    const stillFull = urgent && tokensBefore - freedTokens > answerLine;
    const wrapUp = (stillFull && kept === 0) || notesFull || notesSpent;
    if (wrapUp) state.wrapUp = true;
    if (stillFull && kept > 0) state.condenseNewest = true;
    const record = {
      ...info,
      ...(wrapUp ? { wrapUp: true } : {}),
      collapsed: calls.length,
      freedChars,
      lossy: Boolean(fallbackReason),
      ...(fallbackReason ? { fallbackReason } : {}),
      tokensAfter: Math.max(0, tokensBefore - freedTokens),
      digest:
        digestText.length > MAX_COMPACTION_DIGEST_CHARS
          ? `${digestText.slice(0, MAX_COMPACTION_DIGEST_CHARS)}…`
          : digestText,
      ...(digestText.length > MAX_COMPACTION_DIGEST_CHARS ? { digestTruncated: true } : {}),
      facts: factsShown,
      droppedFacts: (summary?.dropped || 0) + (factsFound - factsShown),
      ...(useModel && summaryModel?.id ? { model: String(summaryModel.id) } : {}),
      durationMs: Date.now() - started,
      ...(archiveRef ? { archiveRef } : {}),
      ...(summaryRef ? { summaryRef } : {})
    };
    this.logger.info('Condensed earlier tool results into a findings digest', {
      component: COMPONENT,
      runId: ctx.runId,
      iteration,
      items: calls.length,
      facts: record.facts,
      droppedFacts: record.droppedFacts,
      tokensBefore,
      tokensAfter: record.tokensAfter,
      lossy: record.lossy,
      fallbackReason: fallbackReason || undefined,
      durationMs: record.durationMs
    });
    this._ledger(ctx.ledgerId, RUN_LOG_EVENTS.CONTEXT_COMPACTION, record);
    await runHooks(seams, 'onCompaction', ctx, {
      ...record,
      digest: digestText,
      freedTokens,
      // Per message: a context figure anchored on a provider count subtracts
      // only what was freed inside it (the newest batch may lie after it).
      // Signed: the result that carries the digest can grow while the
      // others shrink.
      freedByMessage: calls.map((call, i) => [
        call.index,
        estimateTranscriptTokens([before[i]]) - estimateTranscriptTokens([after[i]])
      ]),
      messages: ctx.messages
    });
    return freedTokens;
  }

  /**
   * The originals of spilled results, for the summary only: a result over the
   * spill threshold is a bounded preview in the transcript, and a figure
   * after the preview could not reach the digest. Read from this run or a
   * run of the same chat; one that cannot be read is marked partly read.
   * Mutates `call.content` / `call.cut` of the calls being condensed (their
   * originals are archived before).
   * @private
   * @returns {Promise<number>} how many spilled results could not be read
   */
  async _readSpilledForSummary(ctx, calls) {
    let unread = 0;
    for (const call of calls) {
      let bounded = null;
      try {
        bounded = JSON.parse(call.content);
      } catch {
        continue;
      }
      if (bounded?.truncated !== true) continue;
      let original = null;
      if (bounded.spill?.path && typeof ctx.runLog?.readSpill === 'function') {
        await this._loadArchived(ctx, null);
        original = await this._readSpillOf(ctx, bounded.spill, [
          ctx.ledgerId,
          ...ctx.compaction.archiveRuns
        ]);
      }
      if (typeof original === 'string' && original.length > 0) {
        call.content = original;
      } else {
        call.cut = true;
        unread += 1;
      }
    }
    return unread;
  }

  /**
   * The prompt size above which the next call leaves too little room for
   * more tool results and the answer: {@link URGENT_WINDOW_SHARE} of what the
   * model takes as input — its window less the output the call asks for
   * (vLLM counts `maxTokens` against the window). Without a known window, a
   * multiple of the compaction threshold.
   * @private
   */
  _answerLine(ctx, options) {
    const inputLimit = this._inputLimit(ctx, options);
    return inputLimit
      ? inputLimit * URGENT_WINDOW_SHARE
      : ctx.policies.context.compactThresholdTokens * 1.6;
  }

  /**
   * What the model takes as input: its window less the output the call asks
   * for (vLLM counts `maxTokens` against the window), at least half the
   * window; 0 when the window is not known.
   * @private
   */
  _inputLimit(ctx, options) {
    const window = Number(ctx.model?.contextWindow) || 0;
    const reserve = Number(options?.maxTokens ?? ctx.model?.maxOutputTokens) || 0;
    return window ? Math.max(window - reserve, window * 0.5) : 0;
  }

  /**
   * How many tokens the notes of the run may still grow by: all digests
   * together take at most `maxNotesShare` of the model's input (of twice the
   * compaction threshold when the window is not known).
   * @private
   */
  _notesLeftTokens(ctx, options) {
    const policy = ctx.policies.context;
    const inputLimit = this._inputLimit(ctx, options) || policy.compactThresholdTokens * 2;
    return Math.max(0, policy.maxNotesShare * inputLimit - notesOf(ctx.messages).tokens);
  }

  /**
   * After a compaction that freed nothing: a prompt still above the answer
   * line leaves no room for more results, so the run wraps up.
   * @private
   */
  _wrapUpIfFull(ctx, options, knownTokens) {
    if (!ctx.compaction || ctx.compaction.wrapUp) return;
    const tokens =
      Number.isFinite(knownTokens) && knownTokens > 0
        ? knownTokens
        : estimateTranscriptTokens(ctx.messages) + toolDefinitionTokens(ctx.offeredTools);
    if (tokens > this._answerLine(ctx, options)) ctx.compaction.wrapUp = true;
  }

  /**
   * Store a compaction's payload in the run's spill store; null when the
   * ledger does not persist or the write failed (the recall tool then reads
   * from memory only).
   * @private
   */
  async _spill(ctx, name, payload, contentType = 'application/json') {
    if (!ctx.ledgerId || typeof ctx.runLog?.spill !== 'function') return null;
    try {
      const content = typeof payload === 'string' ? payload : JSON.stringify(payload);
      return await ctx.runLog.spill(ctx.ledgerId, name, content, contentType);
    } catch (err) {
      this.logger.warn('Compaction spill failed', {
        component: COMPONENT,
        runId: ctx.runId,
        error: err.message
      });
      return null;
    }
  }

  /**
   * `recall_tool_result`: one page of a condensed result of this run. A result
   * the loop had spilled (over the transcript limit) is read in full from the
   * spill store.
   * @private
   */
  async _recall(ctx, args) {
    const state = ctx.compaction;
    const ref = /r\s*(\d+)/i.exec(String(args?.ref ?? ''))?.[1];
    if (!ref) {
      return { error: true, message: 'Pass the ref of a condensed result, e.g. "r3".' };
    }
    const limitReached = () => ({
      error: true,
      message:
        'The limit of results read again in this turn is reached. Work with the condensed results.'
    });
    if (state.recalls >= ctx.policies.context.maxRecallsPerRun) return limitReached();
    const entry = state.archive.get(`r${ref}`) || (await this._loadArchived(ctx, `r${ref}`));
    if (!entry) {
      // A ref the transcript names whose original this run cannot reach (an
      // earlier run of the turn, or a ledger that does not persist).
      const known = Number(ref) < state.nextRef;
      return {
        error: true,
        message: known
          ? `The full text of r${ref} is no longer available. Work with the condensed results; run the call again only if they do not hold what you need.`
          : `There is no condensed result r${ref} in this turn. The refs are listed in the condensed results.`
      };
    }
    // Checked again after the wait: parallel recalls may have used the limit up.
    if (state.recalls >= ctx.policies.context.maxRecallsPerRun) return limitReached();
    state.recalls += 1;
    let content = entry.content;
    let bounded = null;
    try {
      bounded = JSON.parse(content);
    } catch {
      /* not a spilled result */
    }
    if (bounded?.truncated === true && bounded.spill?.path) {
      // The run that spilled it: the entry's, this one, or an earlier run of
      // the turn — only runs whose chat was checked (`_loadArchived`), never
      // a run id the request merely names.
      await this._loadArchived(ctx, null);
      const original = await this._readSpillOf(ctx, bounded.spill, [
        entry.runId,
        ctx.ledgerId,
        ...state.archiveRuns
      ]);
      if (original !== null) content = original;
    }
    return recallPage({ ...entry, content: String(content ?? '') }, Number(args?.offset) || 0);
  }

  /**
   * The condensed results of earlier segments of this run (a turn resumed
   * after a pause) and of the paused runs the turn continues from under a new
   * id, read once from the journals' spill stores. Each segment records the
   * runs it continues (`segment/start.archiveRunIds`), so a chain of pauses —
   * same id or new ones — is followed back, at most {@link MAX_ARCHIVE_RUNS}
   * runs and only those of the same chat.
   * @private
   */
  async _loadArchived(ctx, ref) {
    const state = ctx.compaction;
    if (typeof ctx.runLog?.readEvents !== 'function') return null;
    // Loaded once; parallel recalls in one batch all wait for the same load.
    state.archiveLoading ??= this._loadArchiveRuns(ctx);
    await state.archiveLoading;
    return ref ? state.archive.get(ref) || null : null;
  }

  /**
   * A spilled original, read from the run its reference names — only if that
   * run is one of `runs` (this run, or a checked run of the same chat) — and
   * checked against its hash when the reference carries one. Never another
   * run's blob of the same name.
   * @private
   * @returns {Promise<string|null>}
   */
  async _readSpillOf(ctx, spill, runs) {
    const checked = runs.filter(
      (id, index, all) => id && isValidRunId(id) && all.indexOf(id) === index
    );
    const owner = /^spill\/([^/]+)\/[^/]+$/.exec(String(spill?.path ?? ''))?.[1];
    for (const runId of owner ? checked.filter(id => id === owner) : checked) {
      let text;
      try {
        text = await ctx.runLog.readSpill(runId, { path: spill.path });
      } catch {
        continue; // not this run's spill
      }
      if (
        typeof spill.sha256 === 'string' &&
        crypto.createHash('sha256').update(text, 'utf8').digest('hex') !== spill.sha256
      ) {
        continue;
      }
      return text;
    }
    return null;
  }

  /** @private */
  async _loadArchiveRuns(ctx) {
    const state = ctx.compaction;
    const queue = [
      ctx.ledgerId,
      ...(Array.isArray(ctx.request.archiveRunIds) ? ctx.request.archiveRunIds : [])
    ];
    const seen = new Set();
    while (queue.length > 0 && seen.size < MAX_ARCHIVE_RUNS) {
      const runId = queue.shift();
      if (!runId || !isValidRunId(runId) || seen.has(runId)) continue;
      seen.add(runId);
      let events = [];
      try {
        events = await ctx.runLog.readEvents(runId);
      } catch (err) {
        this.logger.warn('Condensed results could not be read back', {
          component: COMPONENT,
          runId: ctx.runId,
          from: runId,
          error: err.message
        });
        continue;
      }
      if (runId !== ctx.ledgerId) {
        const start = events.find(event => event?.type === RUN_LOG_EVENTS.RUN_START);
        if (!ctx.refs.chatId || start?.data?.refs?.chatId !== ctx.refs.chatId) continue;
      }
      state.archiveRuns.push(runId);
      for (const event of events) {
        if (event?.type === RUN_LOG_EVENTS.SEGMENT_START) {
          for (const earlier of event.data?.archiveRunIds || []) queue.push(earlier);
          continue;
        }
        const archiveRef =
          event?.type === RUN_LOG_EVENTS.CONTEXT_COMPACTION && event.data?.archiveRef;
        if (!archiveRef) continue;
        try {
          const stored = JSON.parse(await ctx.runLog.readSpill(runId, archiveRef));
          for (const [key, entry] of Object.entries(stored?.refs || {})) {
            if (!state.archive.has(key) && typeof entry?.content === 'string') {
              state.archive.set(key, { ...entry, runId });
            }
          }
        } catch (err) {
          // One unreadable archive leaves the others readable.
          this.logger.warn('Condensed results could not be read back', {
            component: COMPONENT,
            runId: ctx.runId,
            from: runId,
            error: err.message
          });
        }
      }
    }
  }

  _ledger(runId, type, data) {
    if (!runId) return;
    try {
      this.runLog.append(runId, type, data);
    } catch (err) {
      this.logger.warn('RunLog append failed', {
        component: COMPONENT,
        runId,
        type,
        error: err.message
      });
    }
  }
}

/**
 * A digest compaction must free at least this share of the prompt, or it is
 * not worth its summary call and the prompt cache it breaks.
 */
const MIN_COMPACTION_PROGRESS = 0.1;

/**
 * Share of the model's context window above which a compaction is urgent: the
 * next model call may be refused as too long (#3819).
 */
const URGENT_WINDOW_SHARE = 0.8;

/** What a search or page read gets once the wrap-up has withdrawn it. */
const WITHDRAWN_RESULT = Object.freeze({
  error: true,
  reason: 'tool_withdrawn',
  message:
    'The context is nearly full, so searches and page reads are withdrawn. Answer from the condensed results; say a figure is not available rather than search again.'
});

/** Digest text is dense: about three characters to a token, for sizing it. */
const NOTES_CHARS_PER_TOKEN = 3;

/** How many runs a recall follows back through a chain of paused turns. */
const MAX_ARCHIVE_RUNS = 8;

/**
 * The record of a compaction that collapsed messages to previews (`elide`):
 * the data is gone, so it is `lossy`. Before/after are estimates unless the
 * provider's count of the transcript is known.
 */
/**
 * Whether the current turn of a transcript already wrapped up: the wrap-up
 * nudge comes after its last user message (a turn resumed after a pause). A
 * nudge from an earlier turn does not count.
 */
function wrappedUpIn(messages) {
  if (!Array.isArray(messages)) return false;
  for (let i = messages.length - 1; i >= 0; i--) {
    const message = messages[i];
    if (message?.role !== 'user') continue;
    if (message.content === CONTEXT_WRAP_UP_NUDGE) return true;
    // Loop nudges start with "[system]" and mid-run steers with their
    // marker: neither starts a new turn, also when a stored transcript lost
    // the flag.
    const text = String(message.content ?? '');
    const synthetic =
      message._nudge ||
      message._steer ||
      text.startsWith('[system] ') ||
      text.startsWith(STEER_MARKER);
    if (!synthetic) return false;
  }
  return false;
}

/**
 * Whether a tool gathers more material (a search or a page read) rather than
 * producing. Reading a condensed result back is not gathering: it is how a
 * wrap-up gets an exact figure the notes do not hold.
 */
function gathers(toolDef) {
  if (toolDef?.isCompactionRecall) return false;
  const kind = startedDisplayOf(toolDef).activityKind;
  return kind === 'search' || kind === 'fetch';
}

function elisionInfo(messagesBefore, result, { step, trigger, knownTokens, fallbackReason }) {
  const estimatedBefore = estimateTranscriptTokens(messagesBefore);
  const estimatedAfter = estimateTranscriptTokens(result.messages);
  const tokensBefore =
    Number.isFinite(knownTokens) && knownTokens > 0 ? Math.round(knownTokens) : estimatedBefore;
  return {
    compactionId: `cmp-${crypto.randomUUID().slice(0, 8)}`,
    step,
    trigger,
    strategy: 'elide',
    collapsed: result.collapsed,
    freedChars: result.freedChars,
    lossy: true,
    ...(fallbackReason ? { fallbackReason } : {}),
    tokensBefore,
    tokensAfter: Math.max(0, tokensBefore - Math.max(0, estimatedBefore - estimatedAfter)),
    itemsSummarised: result.collapsed
  };
}

/**
 * What an elision freed per message, as [index, tokens] (signed), for a
 * context figure anchored on a provider count: only what was freed inside
 * that count is subtracted from it (contextTracker.compacted).
 */
function freedByMessageOf(before, after) {
  const freed = [];
  for (let i = 0; i < before.length; i++) {
    if (before[i] === after[i]) continue;
    freed.push([i, estimateTranscriptTokens([before[i]]) - estimateTranscriptTokens([after[i]])]);
  }
  return freed;
}

/** Estimated tokens of the tool definitions sent with a call. */
function toolDefinitionTokens(tools) {
  if (!Array.isArray(tools) || tools.length === 0) return 0;
  try {
    return estimateTokens(
      JSON.stringify(
        tools.map(tool => ({
          name: tool?.id || tool?.name,
          description: tool?.description,
          parameters: tool?.parameters
        }))
      )
    );
  } catch {
    return 0;
  }
}

function bump(map, key) {
  const m = map || new Map();
  m.set(key, (m.get(key) || 0) + 1);
  return m;
}

function reset(map, key) {
  const m = map || new Map();
  m.set(key, 0);
  return m;
}

const agentLoop = new AgentLoop();
export default agentLoop;

export { usageToBudget } from './llmUsage.js';
