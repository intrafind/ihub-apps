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
 *              hallucination, circuit-breaker, compaction notifications)
 *
 * @module services/loop/AgentLoop
 */
import crypto from 'node:crypto';
import defaultLlmClient from './LLMClient.js';
import runLogSingleton, { isValidRunId } from './RunLog.js';
import defaultLogger from '../../utils/logger.js';
import { loopPoliciesSchema } from './contracts/loop.js';
import { LLMError, LLM_ERROR_CODES, isLLMError, isAbortError } from './contracts/errors.js';
import { RUN_LOG_EVENTS } from '../../../shared/runEvents.js';
import { addUsage, normalizeUsage, usageToBudget } from './llmUsage.js';
import { repairToolArguments, applyParameterDefaults, matchTool } from './toolArgs.js';
import { classifyToolResult, isCitationProducingTool } from './toolClassify.js';
import { planToolBatches } from './segmentPlanner.js';
import { takeSteers, steerMessage } from './steering.js';
import {
  compactIfOversized,
  microcompactMessages,
  isContextOverflowError,
  estimateTokens
} from './contextCompaction.js';
import {
  toolDisabledNudge,
  ALL_TOOLS_DEAD_NUDGE,
  tokenBudgetNudge,
  ROUND_CAP_NUDGE,
  nudgeMessage
} from './nudges.js';

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

/**
 * Run `start()` and settle as soon as `signal` aborts, even when the work
 * ignores the signal (a hanging tool must not outlive the invocation deadline).
 */
function raceAbort(start, signal) {
  if (!signal) return Promise.resolve().then(start);
  if (signal.aborted) {
    return Promise.reject(abortError('Agent loop aborted (cancelled or timed out)'));
  }
  return new Promise((resolve, reject) => {
    const onAbort = () => reject(abortError('Agent loop aborted (cancelled or timed out)'));
    signal.addEventListener('abort', onAbort, { once: true });
    Promise.resolve()
      .then(start)
      .then(
        value => {
          signal.removeEventListener('abort', onAbort);
          resolve(value);
        },
        err => {
          signal.removeEventListener('abort', onAbort);
          reject(err);
        }
      );
  });
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
   */
  constructor(opts = {}) {
    this.llmClient = opts.llmClient || defaultLlmClient;
    this.runLog = opts.runLog || runLogSingleton;
    this.logger = opts.logger || defaultLogger;
    this._seams = [...(opts.seams || [])];
  }

  /** Register a seam `{ name, preStep, preTool, postTool, stepEnd, onChunk, onHallucinated, onCircuitBroken, onCompaction }`. */
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
   * @param {'server'|'caller'} [request.toolExecution='server']
   * @param {Object} [request.policies] - partial loop policies (see contracts/loop.js)
   * @param {Object} [request.options] - LLMClient options (temperature, maxTokens, responseSchema, thinking*, …)
   * @param {string} [request.language]
   * @param {AbortSignal} [request.signal]
   * @param {Object} [request.refs] - correlation ids for ledger/telemetry
   * @param {Function} [request.executeTool] - `(call, { toolDef, args, ctx }) => result | toolMessage`
   * @param {Object} [request.channel] - `{ onChunk(chunk, ctx), onToolStart(info), onToolEnd(info) }`
   * @param {Object} [request.state] - `{ budget: {input, output, total} }` shared run-level budget
   * @param {Object} [request.meta] - opaque caller data forwarded to seams
   * @param {Array} [request.seams] - per-run seams (in addition to `use()`d ones)
   * @param {string} [request.purpose='agent-step']
   * @param {number} [request.timeoutMs] - hard timeout for each model call
   * @returns {Promise<Object>} LoopResult
   */
  async run(request) {
    const startedAt = Date.now();
    const policies = resolvePolicies(request.policies);
    const tools = Array.isArray(request.tools) ? request.tools : [];
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

    const options = { ...(request.options || {}) };
    const responseSchema = options.responseSchema;
    if (responseSchema && !options.responseFormat) options.responseFormat = 'json';
    const nativeWebSearch = options.nativeWebSearch ?? null;

    const ctx = {
      request,
      runId,
      ledgerId,
      kind: request.kind || 'agent',
      model,
      tools,
      policies,
      messages: [...request.messages],
      stream: null,
      iteration: 0,
      disabledTools: new Set(),
      knowledgeSources: new Set(),
      citations: [],
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
      addCitation: citation => {
        if (citation) ctx.citations.push(citation);
      }
    };

    let forceFinish = false;
    let forceReason = null;
    let reactiveAttempts = 0;
    let iteration = 0;
    let content = '';
    let finishReason = null;
    let usage = null;
    const thoughtSignatures = [];
    const images = [];
    let structuredLifted = false;
    let answered = false; // the model produced a turn without tool calls
    let terminal = null; // { status, finishReason, pendingInteraction?, toolCalls? }

    this._ledger(ledgerId, RUN_LOG_EVENTS.SEGMENT_START, { segment: segmentId, purpose });

    const assertNotAborted = () => {
      if (deadline?.signal.aborted) throw wallClockError();
      if (signal?.aborted) throw abortError('Agent loop aborted (cancelled or timed out)');
    };

    const buildResult = (status, extra = {}) => ({
      runId,
      status,
      content,
      structured: undefined,
      finishReason: extra.finishReason ?? finishReason,
      usage: usage || { promptTokens: 0, completionTokens: 0, totalTokens: 0, source: 'estimate' },
      runUsage: {
        promptTokens: runBudget.input,
        completionTokens: runBudget.output,
        totalTokens: runBudget.total
      },
      iterations: iteration,
      citations: ctx.citations,
      thoughtSignatures,
      images,
      disabledTools: [...ctx.disabledTools],
      budgetExhausted: forceFinish,
      budgetReason: forceReason,
      messages: ctx.messages,
      knowledgeSources: [...ctx.knowledgeSources],
      maxTokens: options.maxTokens ?? model.maxOutputTokens ?? null,
      durationMs: Date.now() - startedAt,
      ...extra
    });

    try {
      while (iteration < maxRounds) {
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

        await runHooks(seams, 'preStep', ctx);

        const availableTools = tools.filter(t => !ctx.disabledTools.has(t.id));
        const offeredTools = availableTools.length > 0 && !forceFinish ? availableTools : undefined;

        let result;
        try {
          const stream = await this.llmClient.execute({
            model,
            messages: ctx.messages,
            options: {
              ...options,
              tools: offeredTools,
              nativeWebSearch: forceFinish ? null : nativeWebSearch,
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
              executionId: ctx.refs.executionId
            }
          });
          ctx.stream = stream;
          for await (const chunk of stream) {
            for (const seam of seams) {
              if (typeof seam.onChunk === 'function') await seam.onChunk(ctx, chunk);
            }
            if (ctx.channel?.onChunk) await ctx.channel.onChunk(chunk, ctx);
          }
          result = stream.result();
        } catch (err) {
          if (
            !isAbortError(err) &&
            isContextOverflowError(err) &&
            reactiveAttempts < policies.context.maxReactiveAttempts
          ) {
            const mc = microcompactMessages(ctx.messages, {
              keepRecent: policies.context.reactiveKeepRecent
            });
            if (mc.freedChars > 0) {
              reactiveAttempts++;
              ctx.messages = mc.messages;
              this.logger.warn('Reactive context recovery: microcompacted messages, retrying', {
                component: COMPONENT,
                runId,
                attempt: reactiveAttempts,
                freedChars: mc.freedChars,
                collapsed: mc.collapsed
              });
              this._ledger(ledgerId, RUN_LOG_EVENTS.CONTEXT_COMPACTION, {
                step: iteration,
                trigger: 'overflow',
                collapsed: mc.collapsed,
                freedChars: mc.freedChars
              });
              await runHooks(seams, 'onCompaction', ctx, { trigger: 'overflow', ...mc });
              iteration--;
              continue;
            }
          }
          throw err;
        }

        // ── consume the step result ─────────────────────────────────────
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
            structuredLifted = true;
            toolCalls = toolCalls.filter(c => c !== jsonCall);
          }
        }

        const stepUsage = result.usage
          ? result.usage
          : normalizeUsage(
              {
                promptTokens: estimateTokens(ctx.messages.map(m => m.content || '').join(' ')),
                completionTokens: estimateTokens(result.content || '')
              },
              'estimate'
            );
        usage = addUsage(usage, stepUsage);
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

        if (toolCalls.length === 0) {
          answered = true;
          if (!finishReason) finishReason = result.finishReason || 'stop';
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

        const assistantMessage = {
          role: 'assistant',
          content: result.content || null,
          tool_calls: toolCalls
        };
        if (result.thoughtSignatures?.length)
          assistantMessage.thoughtSignatures = result.thoughtSignatures;
        ctx.messages.push(assistantMessage);

        // ── execute the tool calls (segment planner → batches) ──────────
        const resolved = toolCalls.map(call => {
          const toolDef = matchTool(call.function.name, tools);
          const repair = repairToolArguments(call.function.arguments);
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
        if (terminal) {
          return buildResult(terminal.status || 'completed', {
            finishReason: terminal.finishReason || finishReason,
            pendingInteraction: terminal.pendingInteraction,
            content: terminal.content !== undefined ? content + terminal.content : content,
            terminate: terminal
          });
        }

        // ── proactive compaction ────────────────────────────────────────
        const compaction = compactIfOversized(ctx.messages, {
          thresholdTokens: policies.context.compactThresholdTokens,
          keepRecent: policies.context.compactKeepRecent
        });
        if (compaction.compacted) {
          ctx.messages = compaction.messages;
          this.logger.info('Proactively compacted agent context', {
            component: COMPONENT,
            runId,
            iteration,
            collapsed: compaction.collapsed,
            freedChars: compaction.freedChars
          });
          this._ledger(ledgerId, RUN_LOG_EVENTS.CONTEXT_COMPACTION, {
            step: iteration,
            trigger: 'proactive',
            collapsed: compaction.collapsed,
            freedChars: compaction.freedChars
          });
          await runHooks(seams, 'onCompaction', ctx, { trigger: 'proactive', ...compaction });
        }

        // ── force-finish gates: exactly one per iteration ───────────────
        if (tools.length > 0 && tools.every(t => ctx.disabledTools.has(t.id))) {
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

      if (iteration >= maxRounds && !answered && finishReason !== 'budget_exhausted') {
        this.logger.warn('Max tool rounds reached', { component: COMPONENT, runId, maxRounds });
        finishReason = 'max_iterations';
        forceFinish = true;
        forceReason = forceReason || 'rounds';
      }
      const status =
        forceFinish && finishReason === 'budget_exhausted' ? 'budget_exhausted' : 'completed';
      return buildResult(status, { structured: structuredLifted ? undefined : undefined });
    } catch (caught) {
      // A model call or tool cut short by the wall-clock deadline surfaces as
      // an abort; report it as the budget failure it is.
      const err = deadline?.signal.aborted && isAbortError(caught) ? wallClockError() : caught;
      const llmErr = isLLMError(err) ? err : null;
      if (isAbortError(err)) {
        this._ledger(ledgerId, RUN_LOG_EVENTS.ERROR, {
          step: iteration,
          code: LLM_ERROR_CODES.ABORTED,
          message: err.message,
          recoverable: false
        });
        return buildResult('aborted', { error: err, finishReason: 'aborted' });
      }
      this._ledger(ledgerId, RUN_LOG_EVENTS.ERROR, {
        step: iteration,
        code: llmErr?.code || 'LOOP_ERROR',
        message: err.message,
        providerCode: llmErr?.providerCode ?? null,
        status: llmErr?.status ?? null,
        recoverable: false
      });
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

    if (ctx.signal?.aborted) throw abortError('Agent loop aborted (cancelled or timed out)');

    // pre-tool seams may take the call over (approval gate, question, passthrough)
    const handled = await runHooks(seams, 'preTool', ctx, info);
    if (handled) {
      this._ledger(ledgerId, RUN_LOG_EVENTS.TOOL_CALL, {
        step: iteration,
        callId: call.id || `${call.index}`,
        toolId,
        name,
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
      args,
      argsRepaired,
      execution: toolExecution,
      parallelGroup: groupIndex
    });
    if (ctx.channel?.onToolStart) await ctx.channel.onToolStart(info, ctx);

    let message;
    let rawResult;
    let failure = null;
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
        if (typeof ctx.request.executeTool !== 'function') {
          throw new LLMError(`No tool executor configured for '${toolId}'`, {
            code: LLM_ERROR_CODES.INVALID_REQUEST,
            providerCode: 'NO_TOOL_EXECUTOR'
          });
        }
        rawResult = await raceAbort(
          () =>
            ctx.request.executeTool(call, { toolDef, toolId, args, ctx, info, signal: ctx.signal }),
          ctx.signal
        );
        if (
          rawResult &&
          typeof rawResult === 'object' &&
          rawResult.role === 'tool' &&
          rawResult.tool_call_id
        ) {
          message = rawResult;
          rawResult = undefined;
        } else {
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

    const bound = await this._boundToolMessage(ctx, message, { call, toolId, iteration });
    const outcome = {
      rawResult,
      message: bound.message,
      durationMs: Date.now() - started,
      error: failure
    };
    await runHooks(seams, 'postTool', ctx, info, outcome);
    messages.push(outcome.message);

    const verdict = classifyToolResult(outcome.message);
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
      knowledgeSource: outcome.knowledgeSource
    });
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
            isSearch: isCitationProducingTool(key)
          })
        )
      );
    }
    return { position, messages, terminate: null };
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

export { usageToBudget };

const agentLoop = new AgentLoop();
export default agentLoop;
