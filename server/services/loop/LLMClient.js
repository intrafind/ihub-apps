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
 *   - per-model throttling (`throttledFetch`) with an injectable transport
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
import { throttledFetch } from '../../requestThrottler.js';
import configCache from '../../configCache.js';
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
import { normalizeUsage, mergeUsage } from './llmUsage.js';
import { mergeToolCallDeltas } from './toolCallMerge.js';
import { dumpRequest, summarizeRequestShape, isDumpAllEnabled } from './llmDebug.js';

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

// ── Chunk normalization ─────────────────────────────────────────────────────

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
   * @param {(request, ctx:{signal, model}) => Promise<Response>} [opts.transport] - defaults to throttledFetch
   * @param {Function} [opts.createRequest] - defaults to the adapter registry's createCompletionRequest
   * @param {ApiKeyVerifier} [opts.apiKeyVerifier]
   * @param {ErrorHandler} [opts.errorHandler]
   * @param {number} [opts.maxRetries] - default transient retry budget
   * @param {import('./RunLog.js').RunLog} [opts.runLog]
   * @param {(ms:number)=>Promise<void>} [opts.sleep] - retry sleep (tests stub it)
   * @param {(includeDisabled?:boolean)=>{data:Array}} [opts.getModels] - model catalog seam
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
    let timer = null;
    let callSignal = signal;
    if (Number.isFinite(timeoutMs) && timeoutMs > 0) {
      const controller = new AbortController();
      timer = setTimeout(() => {
        timedOut = true;
        controller.abort(TIMEOUT_REASON);
      }, timeoutMs);
      callSignal = signal ? AbortSignal.any([signal, controller.signal]) : controller.signal;
    }
    const errCtx = () => ({ model, timedOut, timeoutMs });
    const failEarly = err => {
      if (timer) clearTimeout(timer);
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
      if (callSignal?.aborted) {
        throw Object.assign(new Error('Aborted before the request was built'), {
          name: 'AbortError'
        });
      }
      request = await this.createRequest(model, messages, apiKey, adapterOptions, {
        signal: callSignal
      });
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
          const res = await this.transport(request, { signal: callSignal, model });
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
      try {
        if (effectiveStream) {
          const adapter = getAdapter(model.provider);
          const ctx = { model, chatId: requestId, request };
          for await (const raw of adapter.parseResponseStream(response, ctx)) {
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
            accumulator.push(chunk);
            yield chunk;
            if (chunk.complete) break;
          }
        } else {
          const text = await response.text();
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
          accumulator.push(chunk);
          yield chunk;
        }
      } catch (rawErr) {
        failure = toLLMError(rawErr, errCtx());
        throw failure;
      } finally {
        if (timer) clearTimeout(timer);
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
    const optionsSnapshot = snapshotOptions(adapterOptions);
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

function defaultTransport(request, { signal, model }) {
  return throttledFetch(model.id, request.url, {
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
    out[key] = value;
  }
  return out;
}

/**
 * The adapter options as the adapter saw them, minus the parts recorded
 * separately (tools, responseSchema) and anything secret-like.
 */
export function snapshotOptions(adapterOptions) {
  const out = {};
  for (const [key, value] of Object.entries(adapterOptions || {})) {
    if (!isPlainValue(value) || SECRET_KEY_PATTERN.test(key)) continue;
    if (key === 'tools' || key === 'responseSchema' || key === 'signal' || key === 'telemetry')
      continue;
    out[key] = value;
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
