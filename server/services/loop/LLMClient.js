/**
 * LLMClient — the ONE public way to call a language model.
 *
 * Every provider call in the server (chat, workflow/agent nodes, the OpenAI
 * inference API, admin utilities, title generation, OCR, …) goes through this
 * class. It owns what used to be scattered across WorkflowLLMHelper,
 * `simpleCompletion`, the inference proxy's private plumbing and the chat
 * the former chat ToolExecutor's stream edge handling:
 *
 *   - model lookup (`resolveModel`, `findModel`) over the live model catalog
 *   - API key resolution (`resolveApiKey`) via ApiKeyVerifier
 *   - request construction through the adapter registry (always awaited)
 *   - per-model throttling (`throttledRun`) with an injectable transport
 *   - transient retry with backoff / Retry-After (llmRetry.js)
 *   - the canonical `LLMError` taxonomy (contracts/errors.js)
 *   - streaming AND non-streaming responses normalized to GenericChunks,
 *     parsed with each adapter's own `parseResponseStream` (so Bedrock's
 *     binary EventStream and iAssistant's block protocol work everywhere)
 *   - usage normalization (llmUsage.js) and tool-call delta merging
 *     (toolCallMerge.js) in `collect()`
 *   - a `request/header` ledger event (+ `request/retry`, `error`) per call
 *     and one GenAI OTel span per call
 *   - operator diagnostics (`LLM_DEBUG_DUMP_ALL`, 4xx failure dumps)
 *
 * Usage:
 *
 *   const result = await llmClient.complete({ modelId, messages, options: { temperature: 0.2 } });
 *   result.content, result.toolCalls, result.usage, result.finishReason
 *
 *   const stream = await llmClient.execute({ model, messages, telemetry: { runId, step } });
 *   for await (const chunk of stream) { … }        // GenericChunk per provider event
 *   const result = stream.result();                // accumulated view
 *
 * @module services/loop/LLMClient
 */
import crypto from 'node:crypto';
import { getAdapter, createCompletionRequest } from '../../adapters/index.js';
import { convertResponseToGeneric, clearStreamingState } from '../../adapters/toolCalling/index.js';
import { throttledRun } from '../../requestThrottler.js';
import { httpFetch, redactUrlSecrets } from '../../utils/httpConfig.js';
import { isDnsFailure } from '../../utils/dnsGuard.js';
import configCache from '../../configCache.js';
import config from '../../config.js';
import ApiKeyVerifier from '../../utils/ApiKeyVerifier.js';
import ErrorHandler from '../../utils/ErrorHandler.js';
import logger from '../../utils/logger.js';
import { getGenAIInstrumentation } from '../../telemetry.js';
import { resolveProviderName, resolveOperation } from '../../telemetry/providerMap.js';
import runLogSingleton, { hashPayload } from './RunLog.js';
import { LLMError, LLM_ERROR_CODES, isLLMError } from './contracts/errors.js';
import { RUN_LOG_EVENTS } from '../../../shared/runEvents.js';
import {
  runWithRetries,
  isTransientHttpStatus,
  isTransientLlmError,
  isAbortLike,
  parseRetryAfterMs,
  DEFAULT_TRANSIENT_RETRIES
} from './llmRetry.js';
import { normalizeUsage, mergeUsage, addUsage } from './llmUsage.js';
import { mergeToolCallDeltas } from './toolCallMerge.js';
import { dumpRequest, summarizeRequestShape, isDumpAllEnabled } from './llmDebug.js';
import { raceAbort, abortError } from './abortRace.js';

/** Upper bound on runs whose last request hash is kept for request/header dedupe. */
const MAX_TRACKED_RUN_HASHES = 5000;

const COMPONENT = 'LLMClient';

/** Providers whose adapters only speak a streaming protocol. */
const STREAM_ONLY_PROVIDERS = new Set(['iassistant-conversation']);

/** Extra per-chunk fields some adapters emit that a collected result should keep (last value wins). */
const PASSTHROUGH_FIELDS = [
  'citations',
  'searchStatus',
  'conversationTitle',
  'conversationId',
  'responseMessageId',
  'requestMessageId'
];

const TIMEOUT_REASON = Symbol('llm-timeout');
const CONNECT_TIMEOUT_REASON = Symbol('llm-connect-timeout');
const STREAM_IDLE_REASON = Symbol('llm-stream-idle');

/**
 * Ceiling for the connect/headers phase of one provider attempt.
 *
 * The whole-call deadline (REQUEST_TIMEOUT, 5 minutes by default) is sized for
 * long generations, so on its own it also governs a host that never answers at
 * all. A VPN-only endpoint reached with the VPN down has its SYNs blackholed
 * rather than refused, so the call sat for the full five minutes; each hung
 * chat stream held one of the browser's ~6 connections per origin, and once
 * they were gone every other model looked broken too. Bounding only the phase
 * before the first byte separates "cannot reach the provider" from "the
 * provider is generating slowly".
 *
 * Two limits on where that inference holds, both learned the hard way:
 *
 *   - It only holds for a STREAMED response, whose headers are flushed as soon
 *     as the provider accepts the request. A non-streamed response arrives in
 *     one piece and its headers are withheld until the whole answer has been
 *     generated — Google's `:generateContent`, and every other buffered
 *     completion endpoint — so time-to-first-byte there *is* generation time.
 *     Timing it capped generation at ten seconds and reported the provider as
 *     unreachable, so non-streamed calls are left to the whole-call deadline
 *     (see `_connectTimeoutMsFor`).
 *   - It only holds for time actually spent waiting on the network. Every
 *     attempt goes through the per-model throttle queue (platform
 *     `requestConcurrency` defaults to 5), and a request still queued behind
 *     five others has not been sent yet, let alone ignored. `_connect` arms
 *     the ceiling inside its throttle slot for that reason.
 *
 * Operators can override the default per deployment (platform.json `llm` or
 * LLM_CONNECT_TIMEOUT_MS) and per model (`connectTimeoutMs`).
 */
const DEFAULT_CONNECT_TIMEOUT_MS = 10_000;

/**
 * Ceiling for the gap between two chunks of a stream that has already started
 * producing.
 *
 * The connect ceiling above only covers the phase before the first byte, and
 * the whole-call deadline is five minutes, so a provider that emits some of
 * the answer and then goes silent without closing the stream or sending a
 * finish reason held the turn open for those five minutes: the answer sat on
 * screen with the stop button still lit and no source badge, because nothing
 * had ended the run. Some OpenAI-compatible servers do exactly this. Timing
 * only the gaps *after* the first chunk leaves a provider that thinks for a
 * long time before answering to the whole-call deadline, where it belongs.
 */
const DEFAULT_STREAM_IDLE_TIMEOUT_MS = 60_000;

/**
 * Resolve one transport ceiling, most specific source first: the model's own
 * override, then the value the client was constructed with (the embedding/test
 * seam), then the platform config, then the env default. Read per call rather
 * than cached in the constructor because the singleton below is built at
 * module load, before `configCache` has read platform.json.
 *
 * @param {object|undefined} model - resolved model config
 * @param {number|undefined} constructed - value passed to the constructor
 * @param {'connectTimeoutMs'|'streamIdleTimeoutMs'} key
 * @param {number} envDefault
 * @returns {number} milliseconds; 0 (or negative) disables the ceiling
 */
function resolveTimeoutMs(model, constructed, key, envDefault) {
  if (Number.isFinite(model?.[key])) return model[key];
  if (Number.isFinite(constructed)) return constructed;
  const platform = configCache.getPlatform() || {};
  if (Number.isFinite(platform.llm?.[key])) return platform.llm[key];
  return Number.isFinite(envDefault) ? envDefault : 0;
}

// ── Chunk normalization ─────────────────────────────────────────────────────

/**
 * Continuations of a turn the provider paused (`stop_reason: pause_turn`,
 * e.g. a long Anthropic web search). Each continuation is a new billable
 * request, so the count is bounded.
 */
const MAX_PAUSE_TURN_CONTINUATIONS = 3;

/**
 * The assistant content blocks of a paused turn, when a completing chunk
 * carries them (set by the provider converter), else null.
 * @param {Object} chunk - normalized chunk
 * @returns {Object[]|null}
 */
function pausedTurnContent(chunk) {
  if (!chunk.complete || chunk.finishReason !== 'pause_turn') return null;
  const blocks = chunk.metadata?.pausedAssistantContent;
  return Array.isArray(blocks) && blocks.length > 0 ? blocks : null;
}

/**
 * Bring any adapter's chunk to the canonical GenericChunk shape: array fields
 * always present, usage normalized and available both at `metadata.usage` and
 * top-level `usage`. Unknown fields pass through untouched.
 * @param {Object} raw
 * @returns {Object}
 */
export function normalizeChunk(raw) {
  const src = raw && typeof raw === 'object' ? raw : {};
  const usage = normalizeUsage(src.metadata?.usage || src.usage);
  const content = Array.isArray(src.content)
    ? src.content
    : src.content != null && src.content !== ''
      ? [src.content]
      : [];
  const chunk = {
    ...src,
    content,
    thinking: Array.isArray(src.thinking) ? src.thinking : [],
    tool_calls: Array.isArray(src.tool_calls) ? src.tool_calls : [],
    complete: src.complete === true,
    error: src.error === true,
    errorMessage: src.errorMessage ?? null,
    finishReason: src.finishReason ?? null,
    metadata: { ...(src.metadata || {}) }
  };
  if (usage) {
    chunk.metadata.usage = usage;
    chunk.usage = usage;
  } else {
    delete chunk.usage;
    delete chunk.metadata.usage;
  }
  return chunk;
}

// ── Result accumulation ─────────────────────────────────────────────────────

/**
 * Accumulates GenericChunks into a CompletionResult. Used by `collect()` and
 * kept up to date on every `LLMStream` so streaming consumers get the same
 * final view without re-implementing the merge rules.
 */
export class ResultAccumulator {
  constructor(meta = {}) {
    this.meta = meta;
    this.content = '';
    this.thinking = [];
    this.toolCalls = [];
    this.thoughtSignatures = [];
    this.images = [];
    this.groundingMetadata = null;
    this.finishReason = null;
    this.usage = null;
    this.complete = false;
    this.chunkCount = 0;
    this.extras = {};
    this.metadata = {};
  }

  push(chunk) {
    this.chunkCount += 1;
    if (chunk.content.length) this.content += chunk.content.join('');
    if (chunk.thinking.length) this.thinking.push(...chunk.thinking);
    if (chunk.tool_calls.length) mergeToolCallDeltas(this.toolCalls, chunk.tool_calls);
    if (Array.isArray(chunk.thoughtSignatures) && chunk.thoughtSignatures.length) {
      this.thoughtSignatures.push(...chunk.thoughtSignatures);
    }
    if (Array.isArray(chunk.images) && chunk.images.length) this.images.push(...chunk.images);
    if (chunk.groundingMetadata) this._mergeGrounding(chunk.groundingMetadata);
    if (chunk.usage) this.usage = mergeUsage(this.usage, chunk.usage);
    if (chunk.finishReason) this.finishReason = chunk.finishReason;
    if (chunk.complete) this.complete = true;
    for (const key of PASSTHROUGH_FIELDS) {
      if (chunk[key] != null) this.extras[key] = chunk[key];
    }
    if (chunk.metadata) {
      const { usage: _u, ...rest } = chunk.metadata;
      Object.assign(this.metadata, rest);
    }
  }

  _mergeGrounding(incoming) {
    if (!this.groundingMetadata) {
      this.groundingMetadata = { ...incoming };
      return;
    }
    for (const key of Object.keys(incoming)) {
      const value = incoming[key];
      if (Array.isArray(value)) {
        this.groundingMetadata[key] = [...(this.groundingMetadata[key] || []), ...value];
      } else if (value !== undefined) {
        this.groundingMetadata[key] = value;
      }
    }
  }

  snapshot() {
    return {
      requestId: this.meta.requestId,
      runId: this.meta.runId ?? null,
      model: this.meta.model
        ? {
            id: this.meta.model.id,
            provider: this.meta.model.provider,
            modelId: this.meta.model.modelId
          }
        : null,
      content: this.content,
      thinking: [...this.thinking],
      toolCalls: this.toolCalls.map(c => ({ ...c, function: { ...c.function } })),
      thoughtSignatures: [...this.thoughtSignatures],
      images: [...this.images],
      groundingMetadata: this.groundingMetadata,
      finishReason: this.finishReason,
      usage: this.usage ? { ...this.usage } : null,
      complete: this.complete,
      chunkCount: this.chunkCount,
      metadata: { ...this.metadata },
      durationMs: this.meta.startedAt ? Date.now() - this.meta.startedAt : undefined,
      ...this.extras
    };
  }
}

/**
 * Async-iterable handle returned by `LLMClient.execute()`. Iterates normalized
 * GenericChunks; `result()` returns the accumulated CompletionResult.
 */
export class LLMStream {
  constructor({ meta, iterate, accumulator }) {
    this.meta = meta;
    this._iterate = iterate;
    this._accumulator = accumulator;
    this._gen = null;
  }

  [Symbol.asyncIterator]() {
    if (!this._gen) this._gen = this._iterate();
    return this._gen;
  }

  /** Accumulated view of everything iterated so far (final after completion). */
  result() {
    return this._accumulator.snapshot();
  }
}

// ── Error mapping ───────────────────────────────────────────────────────────

function mapProviderCode(providerCode, status) {
  switch (providerCode) {
    case 'AUTH_FAILED':
      return LLM_ERROR_CODES.AUTH_FAILED;
    case 'MODEL_NOT_FOUND':
      return LLM_ERROR_CODES.MODEL_NOT_FOUND;
    case 'CONTEXT_WINDOW_EXCEEDED':
      return LLM_ERROR_CODES.CONTEXT_WINDOW_EXCEEDED;
    case 'INVALID_REQUEST':
      return LLM_ERROR_CODES.INVALID_REQUEST;
    case 'RATE_LIMIT':
      return LLM_ERROR_CODES.RATE_LIMITED;
    default:
      break;
  }
  if (status === 401 || status === 403) return LLM_ERROR_CODES.AUTH_FAILED;
  if (status === 404) return LLM_ERROR_CODES.MODEL_NOT_FOUND;
  if (status === 408 || status === 504) return LLM_ERROR_CODES.TIMEOUT;
  if (status === 429) return LLM_ERROR_CODES.RATE_LIMITED;
  if (status === 400 || status === 413 || status === 422) return LLM_ERROR_CODES.INVALID_REQUEST;
  return LLM_ERROR_CODES.PROVIDER_ERROR;
}

const OVERFLOW_PATTERNS = [
  'context length',
  'context window',
  'maximum context',
  'too long',
  'prompt is too long',
  'context_length_exceeded',
  'reduce the length',
  'too many tokens',
  'exceeds the maximum'
];

function looksLikeOverflow(text) {
  const lower = String(text || '').toLowerCase();
  return OVERFLOW_PATTERNS.some(p => lower.includes(p));
}

/**
 * Wrap any thrown error into an LLMError (idempotent for LLMErrors).
 * @param {*} err
 * @param {Object} ctx - { model, timedOut }
 * @returns {LLMError}
 */
export function toLLMError(err, ctx = {}) {
  if (isLLMError(err)) return err;
  const model = ctx.model || {};
  const base = { provider: model.provider, modelId: model.id, cause: err };
  if (ctx.streamIdleTimedOut) {
    return new LLMError(
      `Provider ${model.provider} stopped sending stream chunks for ${ctx.streamIdleTimeoutMs} ms`,
      {
        ...base,
        code: LLM_ERROR_CODES.TIMEOUT,
        providerCode: 'STREAM_IDLE_TIMEOUT'
      }
    );
  }
  if (ctx.timedOut) {
    return new LLMError(`LLM request timed out after ${ctx.timeoutMs} ms`, {
      ...base,
      code: LLM_ERROR_CODES.TIMEOUT,
      providerCode: 'TIMEOUT'
    });
  }
  if (isAbortLike(err)) {
    return new LLMError(err?.message || 'LLM request aborted', {
      ...base,
      code: LLM_ERROR_CODES.ABORTED,
      providerCode: 'ABORTED'
    });
  }
  const code = String(err?.code || err?.cause?.code || '');
  const message = String(err?.message || '');
  if (isDnsFailure(err)) {
    // Checked before the timeout patterns: the DNS guard's own timeout is a
    // resolution failure, not a slow model, and is never retried.
    return new LLMError(message || 'Hostname of the model endpoint could not be resolved', {
      ...base,
      code: LLM_ERROR_CODES.NETWORK,
      providerCode: 'DNS',
      details: err?.cause?.message
    });
  }
  if (
    /ETIMEDOUT|UND_ERR_CONNECT_TIMEOUT|UND_ERR_HEADERS_TIMEOUT/i.test(code) ||
    /timed? ?out/i.test(message)
  ) {
    return new LLMError(message || 'LLM request timed out', {
      ...base,
      code: LLM_ERROR_CODES.TIMEOUT,
      providerCode: code || 'TIMEOUT',
      details: err?.cause?.message
    });
  }
  if (
    isTransientLlmError(err) ||
    /fetch failed|ECONN|ENOTFOUND|EAI_AGAIN|EPIPE|socket/i.test(`${code} ${message}`)
  ) {
    return new LLMError(message || 'Network error while calling the model provider', {
      ...base,
      code: LLM_ERROR_CODES.NETWORK,
      providerCode: code || 'NETWORK',
      details: err?.cause?.message
    });
  }
  return new LLMError(message || 'LLM request failed', {
    ...base,
    code: LLM_ERROR_CODES.PROVIDER_ERROR,
    providerCode: code || null,
    status: typeof err?.status === 'number' ? err.status : undefined,
    details: err?.details
  });
}

// ── The client ──────────────────────────────────────────────────────────────

export class LLMClient {
  /**
   * @param {Object} [opts]
   * @param {(request, ctx:{signal, model}) => Promise<Response>} [opts.transport] - defaults to
   *   `httpFetch`; called inside the model's throttle slot (see `_connect`)
   * @param {Function} [opts.createRequest] - defaults to the adapter registry's createCompletionRequest
   * @param {ApiKeyVerifier} [opts.apiKeyVerifier]
   * @param {ErrorHandler} [opts.errorHandler]
   * @param {number} [opts.maxRetries] - default transient retry budget
   * @param {import('./RunLog.js').RunLog} [opts.runLog]
   * @param {(ms:number)=>Promise<void>} [opts.sleep] - retry sleep (tests stub it)
   * @param {(includeDisabled?:boolean)=>{data:Array}} [opts.getModels] - model catalog seam
   * @param {number} [opts.connectTimeoutMs] - connect/headers ceiling per streamed attempt;
   *   <=0 disables. Overrides platform.json `llm.connectTimeoutMs` and
   *   LLM_CONNECT_TIMEOUT_MS, and is itself overridden by a model's own `connectTimeoutMs`.
   * @param {number} [opts.streamIdleTimeoutMs] - ceiling for the gap between two chunks of a
   *   stream that has already produced one; <=0 disables. Same precedence as above.
   */
  constructor(opts = {}) {
    this.transport = opts.transport || defaultTransport;
    this.createRequest = opts.createRequest || createCompletionRequest;
    this.apiKeyVerifier = opts.apiKeyVerifier || new ApiKeyVerifier();
    this.errorHandler = opts.errorHandler || new ErrorHandler();
    this.maxRetries = Number.isFinite(opts.maxRetries)
      ? opts.maxRetries
      : DEFAULT_TRANSIENT_RETRIES;
    this.runLog = opts.runLog || runLogSingleton;
    this.sleep = opts.sleep;
    this.getModels = opts.getModels || (includeDisabled => configCache.getModels(includeDisabled));
    // Kept as the constructed values only; the effective ceilings are
    // resolved per call so platform.json and per-model overrides apply to the
    // module-level singleton too (see resolveTimeoutMs).
    this._connectTimeoutMsOpt = opts.connectTimeoutMs;
    this._streamIdleTimeoutMsOpt = opts.streamIdleTimeoutMs;
    // Operator diagnostics (request/failure dumps under contents/data/debug); tests turn them off.
    this.debugDumps = opts.debugDumps !== false;
    this._lastMessagesHash = new Map(); // runId -> { hash, count } of the last messages (request/header dedupe), LRU-bounded
    this._lastSchemaHash = new Map(); // runId -> responseSchema hash (recorded on change), LRU-bounded
    this._lastToolsHash = new Map(); // runId -> tool schemas hash (recorded on change), LRU-bounded
    this._lastConfigHash = new Map(); // runId -> model/options snapshot hash (recorded on change), LRU-bounded
  }

  // ── Model catalog ──────────────────────────────────────────────────────

  /**
   * Live list of models.
   * @param {boolean} [includeDisabled=false]
   * @returns {Array}
   */
  listModels(includeDisabled = false) {
    const result = this.getModels(includeDisabled);
    const list = Array.isArray(result) ? result : result?.data;
    return Array.isArray(list) ? list : [];
  }

  /**
   * Look a model up by its iHub id.
   * @param {string} modelId
   * @param {{includeDisabled?: boolean}} [opts]
   * @returns {Object|null}
   */
  findModel(modelId, { includeDisabled = false } = {}) {
    if (!modelId) return null;
    return this.listModels(includeDisabled).find(m => m.id === modelId) || null;
  }

  /**
   * Resolve a model from an ordered list of candidates with the shared
   * fallback chain: first existing candidate → platform default → first model.
   *
   * @param {Object} [opts]
   * @param {string} [opts.modelId] - highest-priority candidate
   * @param {Array<string|null|undefined>} [opts.preferredIds] - further candidates in order
   * @param {boolean} [opts.includeDisabled=false]
   * @param {boolean} [opts.requireTextCapable=false] - exclude image-generation / transcription models
   * @param {boolean} [opts.fallbackToDefault=true]
   * @returns {Object|null}
   */
  resolveModel({
    modelId,
    preferredIds = [],
    includeDisabled = false,
    requireTextCapable = false,
    fallbackToDefault = true
  } = {}) {
    let pool = this.listModels(includeDisabled);
    if (requireTextCapable) {
      pool = pool.filter(
        m => m.enabled !== false && !m.supportsImageGeneration && m.modelType !== 'transcription'
      );
    }
    if (pool.length === 0) return null;
    for (const id of [modelId, ...preferredIds]) {
      if (!id) continue;
      const found = pool.find(m => m.id === id);
      if (found) return found;
    }
    if (!fallbackToDefault) return null;
    return pool.find(m => m.default) || pool[0] || null;
  }

  // ── API keys ───────────────────────────────────────────────────────────

  /**
   * Resolve the API key for a model. Never writes HTTP responses.
   * @param {Object} model
   * @param {{language?: string, apiKey?: string|null}} [opts]
   * @returns {Promise<{success: boolean, apiKey: string|null, error?: Error}>}
   */
  async resolveApiKey(model, { language, apiKey } = {}) {
    if (apiKey !== undefined && apiKey !== null) return { success: true, apiKey };
    const result = await this.apiKeyVerifier.verifyApiKey(model, language || undefined);
    return result.success
      ? { success: true, apiKey: result.apiKey ?? null }
      : { success: false, apiKey: null, error: result.error };
  }

  // ── Execution ──────────────────────────────────────────────────────────

  /**
   * Execute one model call and return an async-iterable stream of
   * GenericChunks. Resolves after the HTTP response headers arrived (retries
   * already applied); the body is parsed lazily as you iterate.
   *
   * @param {Object} params
   * @param {Object} [params.model] - resolved model object (preferred)
   * @param {string} [params.modelId] - iHub model id (looked up when `model` is absent)
   * @param {boolean} [params.includeDisabled=false] - allow disabled models on lookup
   * @param {Array} params.messages - generic messages
   * @param {Object} [params.options] - adapter options (temperature, maxTokens, tools, toolChoice,
   *   responseFormat, responseSchema, nativeWebSearch, thinking*, user, chatId, appConfig, …)
   * @param {string|null} [params.apiKey] - explicit key; resolved via ApiKeyVerifier when omitted
   * @param {boolean} [params.stream=true] - false → single JSON body (one chunk)
   * @param {AbortSignal} [params.signal]
   * @param {number} [params.timeoutMs] - hard timeout for the whole call
   * @param {string} [params.language]
   * @param {number} [params.retries] - transient retry budget for this call
   * @param {Object} [params.telemetry] - { runId, step, segment, purpose, toolExecution,
   *   appId, userId, chatId }
   * @returns {Promise<LLMStream>}
   */
  async execute(params) {
    const {
      messages,
      options = {},
      stream = true,
      signal,
      timeoutMs,
      language,
      retries,
      telemetry = {},
      includeDisabled = false
    } = params;
    if (!Array.isArray(messages)) {
      throw new LLMError('messages must be an array', {
        code: LLM_ERROR_CODES.INVALID_REQUEST,
        providerCode: 'INVALID_MESSAGES'
      });
    }

    const model = params.model || this.findModel(params.modelId, { includeDisabled });
    if (!model) {
      throw new LLMError(`Model ${params.modelId || params.model?.id || '(none)'} not found`, {
        code: LLM_ERROR_CODES.MODEL_NOT_FOUND,
        providerCode: 'MODEL_NOT_CONFIGURED',
        modelId: params.modelId || null
      });
    }

    // Abort/timeout plumbing: one signal for key resolution, request
    // construction (model discovery may hit the network), the transport and
    // the body reader — the advertised whole-call deadline starts here.
    let timedOut = false;
    let streamIdleTimedOut = false;
    let timer = null;
    let idleTimer = null;
    const signals = signal ? [signal] : [];
    if (Number.isFinite(timeoutMs) && timeoutMs > 0) {
      const controller = new AbortController();
      timer = setTimeout(() => {
        timedOut = true;
        controller.abort(TIMEOUT_REASON);
      }, timeoutMs);
      signals.push(controller.signal);
    }
    const streamIdleTimeoutMs = this._streamIdleTimeoutMsFor(model);
    const streamIdleEnabled = Number.isFinite(streamIdleTimeoutMs) && streamIdleTimeoutMs > 0;
    const idleController = streamIdleEnabled ? new AbortController() : null;
    if (idleController) signals.push(idleController.signal);
    const callSignal =
      signals.length === 0
        ? undefined
        : signals.length === 1
          ? signals[0]
          : AbortSignal.any(signals);
    const errCtx = () => ({
      model,
      timedOut,
      timeoutMs,
      streamIdleTimedOut,
      streamIdleTimeoutMs
    });
    const clearStreamIdle = () => {
      if (idleTimer) {
        clearTimeout(idleTimer);
        idleTimer = null;
      }
    };
    /**
     * Race one pending chunk read against the idle deadline. The streaming
     * loop below drives its iterator by hand rather than with `for await`
     * precisely so this can settle first: aborting the request is not enough
     * on its own, because a body that ignores the signal would leave the read
     * pending forever. The abort still fires, so the socket is released even
     * though we have stopped reading from it.
     *
     * Only used from the second read onwards — see the loop.
     */
    const raceStreamIdle = pending => {
      if (!streamIdleEnabled) return pending;
      return new Promise((resolve, reject) => {
        clearStreamIdle();
        idleTimer = setTimeout(() => {
          idleTimer = null;
          streamIdleTimedOut = true;
          idleController.abort(STREAM_IDLE_REASON);
          reject(toLLMError(new Error('LLM stream went idle'), errCtx()));
        }, streamIdleTimeoutMs);
        pending.then(
          value => {
            clearStreamIdle();
            resolve(value);
          },
          err => {
            clearStreamIdle();
            reject(err);
          }
        );
      });
    };
    const failEarly = err => {
      if (timer) clearTimeout(timer);
      clearStreamIdle();
      throw err;
    };

    const keyResult = await this.resolveApiKey(model, { language, apiKey: params.apiKey });
    if (!keyResult.success) {
      const err = keyResult.error;
      failEarly(
        new LLMError(err?.message || `API key for ${model.provider} not found`, {
          code: LLM_ERROR_CODES.AUTH_FAILED,
          providerCode: err?.code || 'API_KEY_MISSING',
          provider: model.provider,
          modelId: model.id,
          cause: err
        })
      );
    }
    const apiKey = keyResult.apiKey;

    const effectiveStream = STREAM_ONLY_PROVIDERS.has(model.provider) ? true : stream !== false;
    const adapterOptions = buildAdapterOptions(options, model, effectiveStream);

    let request;
    try {
      // A builder that talks to the network (model discovery, a lazily created
      // conversation) gets the signal — and is raced against it, so a builder
      // that ignores the signal still cannot outlive the deadline.
      request = await raceAbort(
        () => this.createRequest(model, messages, apiKey, adapterOptions, { signal: callSignal }),
        callSignal,
        () => abortError('Aborted while the request was built')
      );
    } catch (err) {
      failEarly(toLLMError(err, errCtx()));
    }
    if (!request || typeof request.url !== 'string') {
      failEarly(
        new LLMError(`Adapter for ${model.provider} produced no request URL`, {
          code: LLM_ERROR_CODES.INVALID_REQUEST,
          providerCode: 'ADAPTER_REQUEST_INVALID',
          provider: model.provider,
          modelId: model.id
        })
      );
    }

    const requestId = `req-${crypto.randomUUID()}`;
    const startedAt = Date.now();
    const runId = telemetry.runId || null;
    const step = Number.isInteger(telemetry.step) ? telemetry.step : 0;
    const meta = { requestId, runId, step, model, request, startedAt, stream: effectiveStream };

    this._recordRequestHeader({
      runId,
      step,
      requestId,
      model,
      request,
      messages,
      adapterOptions,
      telemetry,
      language
    });

    if (this.debugDumps && isDumpAllEnabled()) {
      await dumpRequest(request, model, 'request').catch(() => {});
    }

    const span = this._beginSpan({ model, messages, request, telemetry, effectiveStream });

    logger.debug('Executing LLM request', {
      component: COMPONENT,
      requestId,
      runId,
      modelId: model.id,
      provider: model.provider,
      messageCount: messages.length,
      hasTools: Array.isArray(adapterOptions.tools) && adapterOptions.tools.length > 0,
      stream: effectiveStream
    });

    let response;
    try {
      response = await runWithRetries(
        async () => {
          if (callSignal?.aborted) {
            const abortErr = new Error('The operation was aborted');
            abortErr.name = 'AbortError';
            throw abortErr;
          }
          const res = await this._connect(request, callSignal, model, effectiveStream);
          if (!res || res.ok === false || (typeof res.status === 'number' && res.status >= 400)) {
            throw await this._httpError(res, model, language, request);
          }
          return res;
        },
        {
          signal: callSignal,
          maxRetries: Number.isFinite(retries) ? retries : this.maxRetries,
          sleep: this.sleep,
          onRetry: ({ attempt, err, delayMs }) => {
            logger.warn('Transient LLM error — retrying', {
              component: COMPONENT,
              requestId,
              modelId: model.id,
              status: err?.status ?? 'network',
              errorCode: err?.code,
              attempt: attempt + 1,
              maxRetries: Number.isFinite(retries) ? retries : this.maxRetries,
              delayMs
            });
            this._ledger(runId, RUN_LOG_EVENTS.REQUEST_RETRY, {
              step,
              requestId,
              attempt: attempt + 1,
              code: String(err?.code || 'NETWORK'),
              status: typeof err?.status === 'number' ? err.status : null,
              delayMs
            });
          }
        }
      );
    } catch (rawErr) {
      if (timer) clearTimeout(timer);
      const err = toLLMError(rawErr, errCtx());
      if (err.code !== LLM_ERROR_CODES.ABORTED && isTransientLlmError(rawErr)) {
        logger.error('LLM request failed after exhausting transient retries', {
          component: COMPONENT,
          requestId,
          modelId: model.id,
          status: err.status ?? 'network',
          errorCode: err.code
        });
      }
      this._recordError({ runId, step, err, span, startedAt });
      throw err;
    }

    const accumulator = new ResultAccumulator(meta);
    const client = this;
    const iterate = async function* () {
      let failure = null;
      // A provider can pause a server-tool turn (`stop_reason: pause_turn`,
      // e.g. a long Anthropic web search). The turn is continued on a fresh
      // request that replays the paused assistant message verbatim; to the
      // consumer it stays one uninterrupted stream.
      let continuations = 0;
      let priorUsage = null;
      let currentResponse = response;
      let currentRequest = request;
      let currentMessages = messages;
      try {
        for (;;) {
          let paused = null;
          if (effectiveStream) {
            const adapter = getAdapter(model.provider);
            const ctx = { model, chatId: requestId, request: currentRequest };
            const chunks = adapter
              .parseResponseStream(currentResponse, ctx)
              [Symbol.asyncIterator]();
            // The first read is left to the whole-call deadline: a reasoning
            // model can be silent for a long time before its first token, and
            // that is not the same failure as a stream that stops mid-answer.
            let produced = false;
            try {
              for (;;) {
                const next = produced ? await raceStreamIdle(chunks.next()) : await chunks.next();
                if (next.done) break;
                produced = true;
                const raw = next.value;
                if (callSignal?.aborted) {
                  const abortErr = new Error('The operation was aborted');
                  abortErr.name = 'AbortError';
                  throw abortErr;
                }
                if (!raw) continue;
                const chunk = normalizeChunk(raw);
                if (chunk.error) {
                  throw new LLMError(chunk.errorMessage || 'Error processing LLM response', {
                    code: looksLikeOverflow(chunk.errorMessage)
                      ? LLM_ERROR_CODES.CONTEXT_WINDOW_EXCEEDED
                      : LLM_ERROR_CODES.PROVIDER_ERROR,
                    providerCode: 'STREAM_ERROR',
                    provider: model.provider,
                    modelId: model.id,
                    details: chunk.errorMessage
                  });
                }
                const pausedBlocks = pausedTurnContent(chunk);
                if (pausedBlocks && continuations < MAX_PAUSE_TURN_CONTINUATIONS) {
                  // The pause marker carries no content of its own; the
                  // continuation delivers the real end of the turn.
                  paused = pausedBlocks;
                  break;
                }
                if (pausedBlocks) {
                  logger.warn(
                    'pause_turn continuation limit reached — returning the partial turn',
                    {
                      component: COMPONENT,
                      requestId,
                      modelId: model.id,
                      continuations
                    }
                  );
                }
                accumulator.push(chunk);
                yield chunk;
                if (chunk.complete) break;
              }
            } finally {
              clearStreamIdle();
              // `for await` released the parser on break/throw; do it by hand
              // now that the iterator is driven by hand — but never await it.
              // The generator is suspended inside `reader.read()`, so `return()`
              // only settles once that read does, which on the very stall this
              // deadline exists for is never. Its own `finally` releases the
              // reader whenever the aborted body errors, and the outer
              // `finally` below clears the converter state either way.
              try {
                Promise.resolve(chunks.return?.()).catch(() => {});
              } catch {
                /* the parser is already finished */
              }
            }
          } else {
            const text = await currentResponse.text();
            const raw = await convertResponseToGeneric(text, model.provider, requestId);
            const chunk = normalizeChunk({ ...raw, complete: true });
            if (chunk.error) {
              throw new LLMError(chunk.errorMessage || 'Error processing LLM response', {
                code: LLM_ERROR_CODES.PROVIDER_ERROR,
                providerCode: 'RESPONSE_PARSE_ERROR',
                provider: model.provider,
                modelId: model.id,
                details: chunk.errorMessage
              });
            }
            const pausedBlocks = pausedTurnContent(chunk);
            if (pausedBlocks && continuations < MAX_PAUSE_TURN_CONTINUATIONS) {
              // Everything produced before the pause is part of the answer;
              // only the completion marker is withheld.
              const { pausedAssistantContent: _paused, ...metadata } = chunk.metadata;
              const partial = normalizeChunk({
                ...chunk,
                metadata,
                complete: false,
                finishReason: null
              });
              accumulator.push(partial);
              yield partial;
              paused = pausedBlocks;
            } else {
              accumulator.push(chunk);
              yield chunk;
            }
          }
          if (!paused) break;

          continuations++;
          // Each continuation is its own billable request: add, never merge.
          priorUsage = addUsage(priorUsage, accumulator.usage);
          accumulator.usage = null;
          currentMessages = [
            ...currentMessages,
            {
              role: 'assistant',
              content: accumulator.content,
              providerContent: { provider: model.provider, blocks: paused }
            }
          ];
          logger.info('Provider paused the turn (pause_turn) — continuing on a new request', {
            component: COMPONENT,
            requestId,
            runId,
            modelId: model.id,
            continuation: continuations
          });
          client._ledger(runId, RUN_LOG_EVENTS.REQUEST_RETRY, {
            step,
            requestId,
            attempt: continuations,
            code: 'PAUSE_TURN',
            status: null,
            delayMs: 0
          });
          try {
            clearStreamingState(model.provider, requestId);
          } catch {
            /* providers without converter state */
          }
          currentRequest = await raceAbort(
            () =>
              client.createRequest(model, currentMessages, apiKey, adapterOptions, {
                signal: callSignal
              }),
            callSignal,
            () => abortError('Aborted while the continuation request was built')
          );
          const res = await client._connect(currentRequest, callSignal, model, effectiveStream);
          if (!res || res.ok === false || (typeof res.status === 'number' && res.status >= 400)) {
            throw await client._httpError(res, model, language, currentRequest);
          }
          currentResponse = res;
        }
        if (priorUsage) accumulator.usage = addUsage(priorUsage, accumulator.usage);
      } catch (rawErr) {
        failure = toLLMError(rawErr, errCtx());
        throw failure;
      } finally {
        if (timer) clearTimeout(timer);
        clearStreamIdle();
        try {
          clearStreamingState(model.provider, requestId);
        } catch {
          /* providers without converter state */
        }
        if (failure) {
          client._recordError({ runId, step, err: failure, span, startedAt });
        } else {
          client._endSpan(span, { model, accumulator, startedAt });
        }
      }
    };

    return new LLMStream({ meta, iterate, accumulator });
  }

  /**
   * Drain a stream (or any async iterable of chunks) into a CompletionResult.
   * @param {LLMStream|AsyncIterable} stream
   * @param {{onChunk?: (chunk) => void|Promise<void>}} [opts]
   * @returns {Promise<Object>} CompletionResult
   */
  async collect(stream, { onChunk } = {}) {
    if (stream instanceof LLMStream) {
      for await (const chunk of stream) {
        if (onChunk) await onChunk(chunk);
      }
      return stream.result();
    }
    const acc = new ResultAccumulator({});
    for await (const raw of stream) {
      const chunk = normalizeChunk(raw);
      acc.push(chunk);
      if (onChunk) await onChunk(chunk);
    }
    return acc.snapshot();
  }

  /**
   * Single-shot convenience: execute + collect. When no `telemetry.runId` is
   * given, the call is recorded as its own small run in the ledger (kind
   * `telemetry.kind || 'utility'`) so every model call is attributable.
   *
   * @param {Object} params - see execute(); plus `telemetry.kind`, `telemetry.user`,
   *   `telemetry.refs`, `telemetry.autoRun` (false disables the envelope)
   * @returns {Promise<Object>} CompletionResult
   */
  async complete(params) {
    const telemetry = params.telemetry || {};
    const run = await this.openRun(params);
    try {
      const stream = await this.execute({
        ...params,
        telemetry: { ...telemetry, runId: run.runId }
      });
      const result = await this.collect(stream, { onChunk: params.onChunk });
      run.finish(result);
      return result;
    } catch (err) {
      run.fail(err, params.model);
      throw err;
    }
  }

  /**
   * Open the ledger envelope for a call that has no run of its own yet. When
   * `telemetry.runId` is already set (the call belongs to a loop/workflow run)
   * this is a no-op handle. Returns `{ runId, finish(result), fail(err) }`;
   * `finish` records the assistant message and closes the run, `fail` closes it
   * with the error. Both are safe to call once and never throw.
   *
   * @param {Object} params - the execute()/complete() params
   * @returns {Promise<{runId: string|null, owned: boolean, finish: Function, fail: Function}>}
   */
  async openRun(params) {
    const telemetry = params.telemetry || {};
    const startedAt = Date.now();
    let runId = telemetry.runId || null;
    let owned = false;
    if (!runId && telemetry.autoRun !== false) {
      try {
        const started = await this.runLog.startRun({
          kind: telemetry.kind || 'utility',
          user: telemetry.user || null,
          parentRunId: telemetry.parentRunId,
          trigger: telemetry.trigger || { type: 'system', source: telemetry.purpose || 'llm' },
          refs: telemetry.refs || {},
          model: params.model?.id || params.modelId,
          language: params.language
        });
        runId = started.runId;
        owned = true;
      } catch (err) {
        logger.warn('Could not open ledger run for LLM call', {
          component: COMPONENT,
          error: err.message
        });
      }
    }
    let closed = false;
    const finish = result => {
      if (!owned || closed) return;
      closed = true;
      try {
        this._ledger(runId, RUN_LOG_EVENTS.MESSAGE_ASSISTANT, {
          step: 0,
          requestId: result.requestId,
          content: result.content,
          toolCalls: result.toolCalls.map(c => ({
            id: c.id || `${c.index}`,
            index: c.index,
            type: c.type || 'function',
            name: c.function?.name || '',
            arguments: c.function?.arguments || '',
            metadata: c.metadata
          })),
          thinkingChars: result.thinking.reduce(
            (n, t) => n + (typeof t === 'string' ? t.length : String(t?.content || '').length),
            0
          ),
          usage: result.usage || undefined,
          finishReason: result.finishReason,
          hasImages: result.images.length > 0
        });
        this.runLog.endRun(runId, {
          status: 'completed',
          finishReason: result.finishReason,
          usage: result.usage || undefined,
          durationMs: Date.now() - startedAt
        });
      } catch {
        /* best effort */
      }
    };
    const fail = (err, model) => {
      if (!owned || closed) return;
      closed = true;
      const llmErr = toLLMError(err, { model });
      try {
        this.runLog.endRun(runId, {
          status: llmErr.code === LLM_ERROR_CODES.ABORTED ? 'aborted' : 'error',
          durationMs: Date.now() - startedAt,
          error: { code: llmErr.code, message: llmErr.message, providerCode: llmErr.providerCode }
        });
      } catch {
        /* best effort */
      }
    };
    return { runId, owned, finish, fail };
  }

  // ── Internals ──────────────────────────────────────────────────────────

  /** Build an LLMError for a non-2xx provider response (with diagnostics). */
  /**
   * The connect/headers ceiling that applies to one attempt, or 0 for none.
   *
   * Non-streamed calls always get 0: their headers arrive with the finished
   * answer, so the phase this ceiling times is the generation itself (see
   * DEFAULT_CONNECT_TIMEOUT_MS). An operator who wants a non-streamed call
   * bounded sets the whole-call deadline (`timeoutMs`) instead.
   *
   * @param {object} model - resolved model config
   * @param {boolean} stream - whether this attempt asked for a streamed response
   * @returns {number} milliseconds; 0 disables the ceiling
   */
  _connectTimeoutMsFor(model, stream) {
    if (stream === false) return 0;
    return resolveTimeoutMs(
      model,
      this._connectTimeoutMsOpt,
      'connectTimeoutMs',
      config.LLM_CONNECT_TIMEOUT_MS ?? DEFAULT_CONNECT_TIMEOUT_MS
    );
  }

  /**
   * The idle ceiling between two chunks of an already-producing stream, or 0
   * for none.
   * @param {object} model - resolved model config
   * @returns {number} milliseconds; 0 disables the ceiling
   */
  _streamIdleTimeoutMsFor(model) {
    return resolveTimeoutMs(
      model,
      this._streamIdleTimeoutMsOpt,
      'streamIdleTimeoutMs',
      config.LLM_STREAM_IDLE_TIMEOUT_MS ?? DEFAULT_STREAM_IDLE_TIMEOUT_MS
    );
  }

  /**
   * One transport attempt: the per-model throttle slot on the outside, the
   * connect/headers ceiling on the inside.
   *
   * The order matters. Every attempt queues behind the model's own
   * `concurrency` (or the platform's `requestConcurrency`, 5 by default), and
   * queued time is not network time: arming the ceiling before the slot was
   * granted reported the sixth request of a batch as an unreachable endpoint
   * while the first five were still generating. So the timer starts once the
   * request is actually about to be sent, and the queue wait is left to the
   * whole-call deadline.
   *
   * Inside the slot, the transport promise settles when the response headers
   * arrive, so timing it bounds exactly DNS + TCP + TLS + time-to-first-byte
   * and leaves the streamed body to the whole-call deadline. On expiry the
   * attempt's own signal is aborted so the socket is not left dangling, and
   * the failure is reported as a timeout with providerCode CONNECT_TIMEOUT,
   * which the retry budget does not retry: a host that ignored the SYN for the
   * whole ceiling will not answer the next attempt either.
   *
   * @param {{url: string}} request - built provider request
   * @param {AbortSignal|undefined} callSignal - whole-call signal
   * @param {object} model - resolved model config
   * @param {boolean} [stream=true] - whether this attempt asked for a streamed response
   * @returns {Promise<Response>}
   */
  async _connect(request, callSignal, model, stream = true) {
    const ms = this._connectTimeoutMsFor(model, stream);
    return throttledRun(model.id, () => {
      if (!Number.isFinite(ms) || ms <= 0) {
        return this.transport(request, { signal: callSignal, model });
      }
      return this._connectWithin(ms, request, callSignal, model);
    });
  }

  /** `_connect`'s timed inner half; runs inside the throttle slot. */
  async _connectWithin(ms, request, callSignal, model) {
    const attempt = new AbortController();
    const signal = callSignal ? AbortSignal.any([callSignal, attempt.signal]) : attempt.signal;

    let timer = null;
    let expired = false;
    try {
      return await new Promise((resolve, reject) => {
        timer = setTimeout(() => {
          expired = true;
          attempt.abort(CONNECT_TIMEOUT_REASON);
        }, ms);
        this.transport(request, { signal, model }).then(resolve, reject);
      });
    } catch (err) {
      if (expired && !callSignal?.aborted) {
        // The endpoint goes to the log, not to the message: the message
        // travels to API clients (the inference API puts it in its error
        // envelope) and an internal provider URL is not theirs to see.
        logger.warn('Provider did not send response headers within the connect ceiling', {
          component: COMPONENT,
          provider: model.provider,
          modelId: model.id,
          connectTimeoutMs: ms,
          url: redactUrlSecrets(request.url)
        });
        throw new LLMError(
          `Provider ${model.provider} sent no response headers within ${ms} ms — ` +
            `endpoint unreachable. Raise llm.connectTimeoutMs in platform.json, or ` +
            `connectTimeoutMs on model ${model.id}, if this endpoint is reachable ` +
            `but slow to answer.`,
          {
            code: LLM_ERROR_CODES.TIMEOUT,
            providerCode: 'CONNECT_TIMEOUT',
            provider: model.provider,
            modelId: model.id,
            cause: err
          }
        );
      }
      throw err;
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  async _httpError(response, model, language, request) {
    if (!response) {
      return new LLMError('No response from model provider', {
        code: LLM_ERROR_CODES.NETWORK,
        providerCode: 'NO_RESPONSE',
        provider: model.provider,
        modelId: model.id
      });
    }
    const status = typeof response.status === 'number' ? response.status : 500;
    let info;
    try {
      info = await this.errorHandler.createEnhancedLLMApiError(response, model, language);
    } catch (err) {
      info = {
        message: `LLM API request failed with status ${status}`,
        code: String(status),
        httpStatus: status,
        details: err?.message || null
      };
    }
    const retryAfterMs = parseRetryAfterMs(
      typeof response.headers?.get === 'function' ? response.headers.get('retry-after') : null
    );
    const transient = isTransientHttpStatus(status);
    let dumpPath = null;
    let requestShape = null;
    if (!transient && status >= 400 && status < 500) {
      requestShape = summarizeRequestShape(request?.body || {});
      if (!this.debugDumps) dumpPath = 'disabled';
      else
        try {
          dumpPath = await dumpRequest(request, model, 'failures', {
            response: { status, body: info.details }
          });
        } catch (dumpErr) {
          dumpPath = `dump-failed: ${dumpErr.message}`;
        }
    }
    if (!transient) {
      logger.error('LLM request failed', {
        component: COMPONENT,
        modelId: model.id,
        provider: model.provider,
        status,
        errorCode: info.code,
        errorMessage: info.message,
        errorDetails: typeof info.details === 'string' ? info.details.slice(0, 2000) : info.details,
        requestShape,
        dumpPath
      });
    }
    const code =
      info.isContextWindowError || looksLikeOverflow(info.details)
        ? LLM_ERROR_CODES.CONTEXT_WINDOW_EXCEEDED
        : mapProviderCode(info.code, status);
    return new LLMError(info.message, {
      code,
      providerCode: info.code,
      status,
      provider: model.provider,
      modelId: model.id,
      retryAfterMs,
      details: info.details
    });
  }

  _ledger(runId, type, data) {
    if (!runId) return;
    try {
      this.runLog.append(runId, type, data);
    } catch (err) {
      logger.warn('RunLog append failed', {
        component: COMPONENT,
        runId,
        type,
        error: err.message
      });
    }
  }

  _recordRequestHeader({
    runId,
    step,
    requestId,
    model,
    request,
    messages,
    adapterOptions,
    telemetry,
    language
  }) {
    if (!runId) return;
    // Nothing to hash or validate when neither persistence nor a subscriber
    // would see the event (the default install has the ledger off).
    if (typeof this.runLog.isRecording === 'function' && !this.runLog.isRecording(runId)) return;
    const messagesHash = hashPayload(messages);
    const previous = this._lastMessagesHash.get(runId) || null;
    // A tool loop grows the context by appending: when the previous messages
    // are a prefix of the new ones only the delta is recorded (`append`);
    // reconstruction replays the deltas. Compaction or a rewritten history is
    // a `change` and records the whole array again.
    let reason;
    let messagesDelta;
    if (!previous) reason = 'initial';
    else if (previous.hash === messagesHash) reason = 'same';
    else if (
      messages.length > previous.count &&
      hashPayload(messages.slice(0, previous.count)) === previous.hash
    ) {
      reason = 'append';
      messagesDelta = messages.slice(previous.count);
    } else reason = 'change';
    // Re-insert to keep Map order as LRU order; evict the oldest past the cap so
    // a long-lived process does not keep one hash per run it ever served.
    this._lastMessagesHash.delete(runId);
    this._lastMessagesHash.set(runId, { hash: messagesHash, count: messages.length });
    while (this._lastMessagesHash.size > MAX_TRACKED_RUN_HASHES) {
      this._lastMessagesHash.delete(this._lastMessagesHash.keys().next().value);
    }
    // The structured-output schema follows the same change-based dedupe as the
    // messages: recorded in full the first time and whenever it changes, so a
    // schema-constrained request stays reconstructable from the ledger.
    const responseSchema = adapterOptions.responseSchema || null;
    const responseSchemaHash = responseSchema ? hashPayload(responseSchema) : null;
    const schemaChanged = responseSchemaHash !== (this._lastSchemaHash.get(runId) ?? null);
    this._lastSchemaHash.delete(runId);
    this._lastSchemaHash.set(runId, responseSchemaHash);
    while (this._lastSchemaHash.size > MAX_TRACKED_RUN_HASHES) {
      this._lastSchemaHash.delete(this._lastSchemaHash.keys().next().value);
    }
    const tools = Array.isArray(adapterOptions.tools) ? adapterOptions.tools : null;
    // Tool schemas follow their own change-based dedupe: a caller that repeats
    // identical messages with a different tool set still records the schemas
    // the model saw, so the request stays reconstructable from the ledger.
    const toolSchemasHash = tools ? hashPayload(tools) : null;
    const toolsChanged = toolSchemasHash !== (this._lastToolsHash.get(runId) ?? null);
    this._lastToolsHash.delete(runId);
    this._lastToolsHash.set(runId, toolSchemasHash);
    while (this._lastToolsHash.size > MAX_TRACKED_RUN_HASHES) {
      this._lastToolsHash.delete(this._lastToolsHash.keys().next().value);
    }
    // The request-shaping model fields and adapter options are snapshotted
    // (secrets stripped) so the request can be rebuilt from the ledger even
    // after the model catalog changed; recorded in full when they change.
    const modelSnapshot = snapshotModel(model);
    const optionsSnapshot = snapshotOptions(adapterOptions, {
      principalId: this.runLog.getRunMeta(runId)?.principalId ?? null
    });
    const configHash = hashPayload({ modelSnapshot, optionsSnapshot });
    const configChanged = configHash !== (this._lastConfigHash.get(runId) ?? null);
    this._lastConfigHash.delete(runId);
    this._lastConfigHash.set(runId, configHash);
    while (this._lastConfigHash.size > MAX_TRACKED_RUN_HASHES) {
      this._lastConfigHash.delete(this._lastConfigHash.keys().next().value);
    }
    const callConfig = {
      temperature:
        typeof adapterOptions.temperature === 'number' ? adapterOptions.temperature : undefined,
      maxTokens: Number.isInteger(adapterOptions.maxTokens) ? adapterOptions.maxTokens : undefined,
      responseFormat: adapterOptions.responseFormat ?? null,
      responseSchemaHash,
      ...(responseSchema && schemaChanged ? { responseSchema } : {}),
      thinking: pickThinking(adapterOptions),
      nativeWebSearch: adapterOptions.nativeWebSearch ?? null,
      toolChoice: adapterOptions.toolChoice,
      stream: adapterOptions.stream !== false
    };
    this._ledger(runId, RUN_LOG_EVENTS.REQUEST_HEADER, {
      step,
      segment: telemetry.segment,
      purpose: telemetry.purpose,
      requestId,
      model: model.id,
      provider: model.provider,
      modelId: model.modelId,
      requestHash: hashPayload(request.body ?? {}),
      messagesHash,
      messageCount: messages.length,
      reason,
      ...(reason === 'initial' || reason === 'change' ? { messages } : {}),
      ...(reason === 'append' ? { messagesDelta } : {}),
      toolSchemasHash,
      ...(tools && (reason === 'initial' || toolsChanged) ? { toolSchemas: tools } : {}),
      toolExecution: telemetry.toolExecution || (tools ? 'caller' : 'none'),
      callConfig,
      configHash,
      ...(reason === 'initial' || configChanged ? { modelSnapshot, optionsSnapshot } : {}),
      language
    });
  }

  _recordError({ runId, step, err, span, startedAt }) {
    this._ledger(runId, RUN_LOG_EVENTS.ERROR, {
      step,
      code: err.code,
      message: err.message,
      providerCode: err.providerCode ?? null,
      status: err.status ?? null,
      recoverable: err.retryable === true || err.code === LLM_ERROR_CODES.CONTEXT_WINDOW_EXCEEDED
    });
    if (span) {
      try {
        const instrumentation = getGenAIInstrumentation();
        if (instrumentation) instrumentation.endSpan(span, err, (Date.now() - startedAt) / 1000);
      } catch {
        /* telemetry must never break a call */
      }
    }
  }

  _beginSpan({ model, messages, request, telemetry, effectiveStream }) {
    let instrumentation;
    try {
      instrumentation = getGenAIInstrumentation();
    } catch {
      return null;
    }
    if (!instrumentation || !instrumentation.isEnabled()) return null;
    try {
      const span = instrumentation.createLLMSpan(
        resolveOperation(model.provider),
        model,
        resolveProviderName(model.provider),
        {
          appId: telemetry.appId,
          userId: telemetry.userId,
          chatId: telemetry.chatId || telemetry.runId,
          runId: telemetry.runId,
          messageCount: messages.length,
          isFollowUp: messages.length > 2
        }
      );
      instrumentation.recordRequest(span, model, messages, {
        temperature: request.body?.temperature ?? request.body?.generationConfig?.temperature,
        maxTokens:
          request.body?.max_tokens ||
          request.body?.max_output_tokens ||
          request.body?.generationConfig?.maxOutputTokens,
        topP: request.body?.top_p,
        stream: effectiveStream
      });
      return span;
    } catch {
      return null;
    }
  }

  _endSpan(span, { model, accumulator, startedAt }) {
    if (!span) return;
    try {
      const instrumentation = getGenAIInstrumentation();
      if (!instrumentation) return;
      const usage = accumulator.usage
        ? {
            inputTokens: accumulator.usage.promptTokens,
            outputTokens: accumulator.usage.completionTokens
          }
        : undefined;
      instrumentation.recordResponse(
        span,
        {
          finishReasons: accumulator.finishReason ? [accumulator.finishReason] : undefined,
          model: model.modelId
        },
        usage
      );
      instrumentation.endSpan(span, null, (Date.now() - startedAt) / 1000);
    } catch {
      /* telemetry must never break a call */
    }
  }
}

// ── Helpers ─────────────────────────────────────────────────────────────────

/**
 * The real transport: proxy/SSL-aware fetch, nothing else. Per-model
 * throttling deliberately lives one level up, in `_connect`, so that queue
 * time stays outside the connect/headers ceiling.
 */
function defaultTransport(request, { signal }) {
  return httpFetch(request.url, {
    method: request.method || 'POST',
    headers: request.headers,
    body: request.body !== undefined ? JSON.stringify(request.body) : undefined,
    signal
  });
}

/**
 * Prepare the options handed to the adapter: drop undefined values, pin
 * `stream`, and default the output cap to the model's own `maxOutputTokens`
 * (the adapters' hard-coded 1024/2048 fallbacks only apply when the model
 * config declares no cap either).
 */
function buildAdapterOptions(options, model, stream) {
  const out = {};
  for (const [key, value] of Object.entries(options || {})) {
    if (value !== undefined) out[key] = value;
  }
  delete out.signal;
  delete out.telemetry;
  out.stream = stream;
  if (
    out.maxTokens === undefined &&
    Number.isInteger(model.maxOutputTokens) &&
    model.maxOutputTokens > 0
  ) {
    out.maxTokens = model.maxOutputTokens;
  }
  return out;
}

/**
 * Keys that may carry a secret: API keys, passwords, credentials, bearer /
 * access / refresh tokens, raw header maps. Deliberately not "anything with
 * `token` in it" — `maxTokens`, `maxOutputTokens` and `tokenLimit` shape the
 * request and must stay in the snapshot.
 */
const SECRET_KEY_PATTERN =
  /(api[-_]?key|apikey|secret|password|passwd|credential|authorization|bearer|token$|^key$|^headers$)/i;

function isPlainValue(value) {
  return value !== undefined && typeof value !== 'function';
}

/** Recorded in place of the acting user when the run has no principal on record. */
const REDACTED_USER_ID = '[redacted]';
/** Bounds the recursive redaction; option objects are shallow, this only guards pathological input. */
const SNAPSHOT_MAX_DEPTH = 8;

/**
 * Copy a value for the ledger with every secret-like key dropped at any depth
 * (a nested header map, a credential inside an integration config).
 */
function redactDeep(value, depth = 0) {
  if (Array.isArray(value)) {
    return depth >= SNAPSHOT_MAX_DEPTH ? [] : value.map(v => redactDeep(v, depth + 1));
  }
  if (value && typeof value === 'object') {
    if (depth >= SNAPSHOT_MAX_DEPTH) return {};
    const out = {};
    for (const [key, v] of Object.entries(value)) {
      if (!isPlainValue(v) || SECRET_KEY_PATTERN.test(key)) continue;
      out[key] = redactDeep(v, depth + 1);
    }
    return out;
  }
  return value;
}

/**
 * The request-shaping fields of a model config, without secrets or localized
 * display blobs. Reconstruction rebuilds the request from this snapshot, not
 * from the current (mutable) catalog.
 */
export function snapshotModel(model) {
  const out = {};
  for (const [key, value] of Object.entries(model || {})) {
    if (!isPlainValue(value) || SECRET_KEY_PATTERN.test(key)) continue;
    if (key === 'name' || key === 'description') continue;
    out[key] = redactDeep(value);
  }
  return out;
}

/**
 * The adapter options as the adapter saw them, minus the parts recorded
 * separately (tools, responseSchema) and anything secret-like.
 */
export function snapshotOptions(adapterOptions, { principalId = null } = {}) {
  const out = {};
  for (const [key, value] of Object.entries(adapterOptions || {})) {
    if (!isPlainValue(value) || SECRET_KEY_PATTERN.test(key)) continue;
    if (key === 'tools' || key === 'responseSchema' || key === 'signal' || key === 'telemetry')
      continue;
    if (key === 'user') {
      // The acting user reaches adapters for authentication only, never the
      // request body: the ledger keeps the run's principal (in its identity
      // mode) and nothing else about the person.
      if (value) out.user = { id: principalId || REDACTED_USER_ID };
      continue;
    }
    out[key] = redactDeep(value);
  }
  return out;
}

function pickThinking(options) {
  const keys = ['thinkingEnabled', 'thinkingLevel', 'thinkingBudget', 'thinkingThoughts'];
  const out = {};
  let any = false;
  for (const k of keys) {
    if (options[k] !== undefined) {
      out[k] = options[k];
      any = true;
    }
  }
  return any ? out : null;
}

export { isTransientHttpStatus, isTransientLlmError, parseRetryAfterMs } from './llmRetry.js';
export { normalizeUsage, mergeUsage, addUsage, usageToBudget, usageToOpenAI } from './llmUsage.js';
export {
  mergeToolCallDelta,
  mergeToolCallDeltas,
  parseToolCallArguments
} from './toolCallMerge.js';
export { extractJson } from './extractJson.js';
export { LLMError, LLM_ERROR_CODES, isLLMError, isAbortError } from './contracts/errors.js';

const llmClient = new LLMClient();
export default llmClient;
