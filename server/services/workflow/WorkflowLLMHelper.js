/**
 * WorkflowLLMHelper
 *
 * Provides a clean interface for workflow LLM operations with proper option filtering.
 * This helper ensures that only valid adapter parameters are passed to LLM requests,
 * preventing provider-specific errors from invalid options.
 *
 * The root cause being fixed: AgentNodeExecutor was passing `user` and `chatId` options
 * directly to createCompletionRequest, but BaseAdapter.extractRequestOptions() only
 * accepts: temperature, stream, maxTokens, tools, toolChoice, responseFormat, responseSchema.
 * The extra options were corrupting request bodies for vLLM, Google, and other providers.
 *
 * @module services/workflow/WorkflowLLMHelper
 */

import { createCompletionRequest } from '../../adapters/index.js';
import { convertResponseToGeneric } from '../../adapters/toolCalling/index.js';
import { throttledFetch } from '../../requestThrottler.js';
import { getStreamReader } from '../../utils/streamUtils.js';
import ApiKeyVerifier from '../../utils/ApiKeyVerifier.js';
import ErrorHandler from '../../utils/ErrorHandler.js';
import logger from '../../utils/logger.js';
import { createParser } from 'eventsource-parser';
import { filterAdapterOptions as filterAdapterOptionsPure } from './adapterOptions.js';

/**
 * Default number of retries for transient LLM errors. A brief Google 503
 * ("temporarily unavailable") on a single sub-task used to kill an entire
 * multi-round agent run; retrying a few times with backoff absorbs the blip.
 * Overridable per-instance (constructor) or globally via env.
 * @type {number}
 */
const DEFAULT_TRANSIENT_RETRIES = (() => {
  const fromEnv = Number(process.env.WORKFLOW_LLM_TRANSIENT_RETRIES);
  return Number.isFinite(fromEnv) && fromEnv >= 0 ? fromEnv : 3;
})();

const NETWORK_ERROR_CODES =
  /ECONNRESET|ETIMEDOUT|ENOTFOUND|EAI_AGAIN|ECONNREFUSED|EPIPE|ECONNABORTED/i;
const NETWORK_ERROR_MESSAGES = /fetch failed|network|socket hang up|timeout|terminated|aborted/i;

/**
 * Whether an HTTP status from a provider is a TRANSIENT failure worth retrying.
 * 429 (rate limit — honor Retry-After) and any 5xx (server-side / overload).
 * 4xx other than 429 are caller errors (bad request, auth, context window) and
 * must NOT be retried — retrying can't fix them and just wastes the budget.
 *
 * @param {number} status - HTTP status code
 * @returns {boolean}
 */
export function isTransientHttpStatus(status) {
  if (typeof status !== 'number') return false;
  if (status === 429) return true;
  return status >= 500 && status < 600;
}

/**
 * Whether a thrown error should be retried. Two transient classes:
 *   1. A classified HTTP error (has `.status`) whose status is transient.
 *   2. A transport/network fault thrown BEFORE any response (no `.status`),
 *      recognized by its node error code or message. We deliberately do NOT
 *      treat an arbitrary status-less error (e.g. a logic bug) as transient,
 *      so we don't silently retry real defects.
 *
 * @param {Error & { status?: number, code?: string }} err
 * @returns {boolean}
 */
export function isTransientLlmError(err) {
  if (!err) return false;
  if (err.status != null) return isTransientHttpStatus(err.status);
  const code = typeof err.code === 'string' ? err.code : '';
  const msg = typeof err.message === 'string' ? err.message : '';
  return NETWORK_ERROR_CODES.test(code) || NETWORK_ERROR_MESSAGES.test(msg);
}

/**
 * Parse a `Retry-After` header into milliseconds. Supports the integer-seconds
 * form (what Google sends) and an HTTP-date; returns null when absent or
 * unparseable so the caller falls back to exponential backoff.
 *
 * @param {string|number|null|undefined} retryAfter - raw header value
 * @returns {number|null} delay in ms, or null
 */
export function parseRetryAfterMs(retryAfter) {
  if (retryAfter == null) return null;
  const s = String(retryAfter).trim();
  if (s === '') return null;
  if (/^\d+$/.test(s)) return Number(s) * 1000;
  const dateMs = Date.parse(s);
  if (!Number.isNaN(dateMs)) return Math.max(0, dateMs - Date.now());
  return null;
}

/**
 * Compute the delay before the next retry. Honors a server-instructed
 * `Retry-After` (bounded only by `retryAfterCapMs`); otherwise exponential
 * backoff (base · 2^attempt) plus up to `baseMs` of jitter, capped at `capMs`.
 *
 * A server-instructed delay is NOT clamped to the small backoff `capMs`:
 * retrying before the server's stated window has elapsed just re-trips the
 * rate limit and burns the whole retry budget. It is bounded by a separate,
 * larger `retryAfterCapMs` only to guard against an absurd header value.
 *
 * @param {number} attempt - zero-based attempt index that just failed
 * @param {Object} [opts]
 * @param {number|null} [opts.retryAfterMs] - server-instructed delay, if any
 * @param {number} [opts.baseMs=1000]
 * @param {number} [opts.capMs=15000] - cap for computed exponential backoff
 * @param {number} [opts.retryAfterCapMs=60000] - upper bound for an explicit Retry-After
 * @param {() => number} [opts.jitter=Math.random]
 * @returns {number} delay in ms
 */
export function computeRetryDelayMs(
  attempt,
  {
    retryAfterMs = null,
    baseMs = 1000,
    capMs = 15000,
    retryAfterCapMs = 60000,
    jitter = Math.random
  } = {}
) {
  if (typeof retryAfterMs === 'number' && retryAfterMs >= 0) {
    return Math.min(retryAfterMs, retryAfterCapMs);
  }
  const exp = baseMs * Math.pow(2, attempt);
  const jitterMs = Math.floor(jitter() * baseMs);
  return Math.min(exp + jitterMs, capMs);
}

/**
 * Helper class for workflow LLM operations.
 *
 * Provides centralized handling of:
 * - Option filtering to prevent invalid parameters
 * - API key verification using existing infrastructure
 * - Streaming request execution with proper error handling
 * - Response processing with node-fetch/Web Streams compatibility
 */
export class WorkflowLLMHelper {
  /**
   * Create a new WorkflowLLMHelper
   * @param {Object} options - Helper options
   * @param {ApiKeyVerifier} [options.apiKeyVerifier] - API key verifier instance
   * @param {ErrorHandler} [options.errorHandler] - Error handler instance
   */
  constructor(options = {}) {
    this.apiKeyVerifier = options.apiKeyVerifier || new ApiKeyVerifier();
    this.errorHandler = options.errorHandler || new ErrorHandler();
    this.maxRetries = Number.isFinite(options.maxRetries)
      ? options.maxRetries
      : DEFAULT_TRANSIENT_RETRIES;
  }

  /**
   * Sleep for `ms` milliseconds. Extracted so tests can stub it and run the
   * retry loop without real delays.
   * @param {number} ms
   * @returns {Promise<void>}
   */
  _sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
  }

  /**
   * Run `fn` and retry it on transient errors with exponential backoff.
   *
   * `fn(attempt)` is invoked once per attempt and must either return a value
   * (success) or throw. A thrown error is retried only when
   * `isTransientLlmError` says so and the retry budget remains; otherwise it
   * propagates unchanged. A `.retryAfterMs` on the error (parsed from a
   * provider Retry-After header) overrides the computed backoff.
   *
   * @param {(attempt: number) => Promise<any>} fn
   * @param {Object} [opts]
   * @param {number} [opts.maxRetries] - defaults to this.maxRetries
   * @param {(info: {attempt:number, err:Error, delayMs:number}) => void} [opts.onRetry]
   * @returns {Promise<any>} fn's successful return value
   */
  async _runWithRetries(fn, { maxRetries, onRetry } = {}) {
    const budget = Number.isFinite(maxRetries) ? maxRetries : this.maxRetries;
    for (let attempt = 0; ; attempt++) {
      try {
        return await fn(attempt);
      } catch (err) {
        if (attempt >= budget || !isTransientLlmError(err)) throw err;
        const delayMs = computeRetryDelayMs(attempt, {
          retryAfterMs: typeof err?.retryAfterMs === 'number' ? err.retryAfterMs : null
        });
        if (onRetry) onRetry({ attempt, err, delayMs });
        await this._sleep(delayMs);
      }
    }
  }

  /**
   * Filter options to only include valid adapter parameters.
   *
   * This is critical for provider compatibility. BaseAdapter.extractRequestOptions()
   * only accepts specific keys. Any extra keys (like user, chatId) pass through
   * unfiltered and corrupt the request body for many providers.
   *
   * @param {Object} options - Request options
   * @returns {Object} Filtered options with only valid adapter parameters
   */
  filterAdapterOptions(options = {}) {
    return filterAdapterOptionsPure(options);
  }

  /**
   * Verify API key for a model using centralized ApiKeyVerifier.
   *
   * @param {Object} model - Model configuration
   * @param {string} [language='en'] - Language for error messages
   * @returns {Promise<Object>} Result with { success, apiKey } or { success: false, error }
   */
  async verifyApiKey(model, language = 'en') {
    return await this.apiKeyVerifier.verifyApiKey(model, null, null, language);
  }

  /**
   * Verify the API key, then execute a single non-streaming-loop LLM call and
   * return a uniform success/error result — the "verify → call → catch"
   * boilerplate that several node executors (query-plan, quote validator)
   * used to hand-roll independently.
   *
   * Pass an already-resolved `apiKey` to skip verification (e.g. a caller
   * that verifies once and then calls this in a loop with the same key).
   * Only use this for genuinely single-shot calls — NOT inside a tool-use
   * loop, which needs the raw `executeStreamingRequest` result (tool calls,
   * finish reason, etc.) rather than this helper's collapsed `{content}`.
   *
   * @param {Object} params - Request parameters
   * @param {Object} params.model - Model configuration
   * @param {Array} params.messages - Messages to send
   * @param {string} [params.apiKey] - Pre-verified API key; verifies via
   *   `verifyApiKey` when omitted
   * @param {Object} [params.options] - Request options (will be filtered)
   * @param {string} [params.language='en'] - Language for error messages
   * @param {string} [params.errorLabel='LLM call'] - Prefix used in the
   *   error message on both verification and call failure
   * @returns {Promise<{success: true, content: string, response: Object}|{success: false, error: string}>}
   */
  async runSingleShotLLM({
    model,
    messages,
    apiKey,
    options = {},
    language = 'en',
    errorLabel = 'LLM call'
  }) {
    let resolvedApiKey = apiKey;
    if (!resolvedApiKey) {
      const apiKeyResult = await this.verifyApiKey(model, language);
      if (!apiKeyResult.success) {
        return {
          success: false,
          error: apiKeyResult.error?.message || `API key verification failed for ${errorLabel}`
        };
      }
      resolvedApiKey = apiKeyResult.apiKey;
    }

    try {
      const response = await this.executeStreamingRequest({
        model,
        messages,
        apiKey: resolvedApiKey,
        options,
        language
      });
      return { success: true, content: response?.content || '', response };
    } catch (err) {
      return { success: false, error: `${errorLabel} failed: ${err.message}` };
    }
  }

  /**
   * Execute a streaming LLM request with proper option filtering and error handling.
   *
   * @param {Object} params - Request parameters
   * @param {Object} params.model - Model configuration
   * @param {Array} params.messages - Messages to send
   * @param {string} params.apiKey - API key
   * @param {Object} params.options - Request options (will be filtered)
   * @param {string} [params.language='en'] - Language for error messages
   * @returns {Promise<Object>} Response with { content, toolCalls }
   * @throws {Error} If request fails or API returns error
   */
  async executeStreamingRequest({ model, messages, apiKey, options = {}, language = 'en' }) {
    // Filter options to only valid adapter parameters (critical for provider compatibility)
    const filteredOptions = this.filterAdapterOptions({
      ...options,
      stream: true // Always stream for workflow agent operations
    });

    // Create the request using centralized adapter infrastructure.
    // MUST be awaited: some adapters (openai, iassistant-conversation) implement
    // createCompletionRequest as async (they await model auto-discovery). Without
    // await, `request` is an unresolved Promise, `request.url` is undefined, and
    // throttledFetch falls back to using model.id as the URL — surfacing as the
    // confusing "Unsupported URL scheme: <model-id>".
    const request = await createCompletionRequest(model, messages, apiKey, filteredOptions);

    logger.debug('Executing streaming request', {
      component: 'WorkflowLLMHelper',
      modelId: model.id,
      provider: model.provider,
      messageCount: messages.length,
      hasTools: !!filteredOptions.tools
    });

    // Debug mode: when LLM_DEBUG_DUMP_ALL=1 is set in the environment, dump
    // EVERY outgoing request body to disk before it's sent — successes too,
    // not just 4xx failures. Use case: capture one Pro run and one Flash run
    // back-to-back, then diff the request bodies to see what (if anything)
    // differs in the wire format. Turn OFF for normal runs; the dumps include
    // the full prompt content and accumulate quickly.
    if (process.env.LLM_DEBUG_DUMP_ALL === '1') {
      try {
        await this._dumpRequest(request, model, 'request');
      } catch {
        // best-effort; never block the request
      }
    }

    // Execute the request, retrying transient provider failures (503 / other
    // 5xx / 429 / network blips) with exponential backoff. A single transient
    // Google 503 ("temporarily unavailable") on one agent sub-task previously
    // discarded an ENTIRE multi-round run. processStreamingResponse runs
    // OUTSIDE this loop — we only ever retry the request itself, never a
    // partially-consumed stream.
    const response = await this._runWithRetries(
      async () => {
        const response = await throttledFetch(model.id, request.url, {
          method: 'POST',
          headers: request.headers,
          body: JSON.stringify(request.body)
        });

        // Handle errors using centralized error handling
        if (!response.ok) {
          const errorInfo = await this.errorHandler.createEnhancedLLMApiError(
            response,
            model,
            language
          );

          // For 4xx errors (mostly INVALID_ARGUMENT) the provider's error body
          // is often generic ("Request contains an invalid argument."), which
          // makes diagnosis hard. Dump a SHAPE summary of the request body so
          // we can see what was sent without leaking the full prompt content to
          // logs. Sizes/keys are enough to spot empty messages, oversized
          // payloads, missing fields, etc. Skip transient 429s — they're
          // retried, so this would rebuild the shape (JSON.stringify(body)) on
          // every attempt for a request that isn't actually malformed.
          let requestShape = null;
          if (
            response.status >= 400 &&
            response.status < 500 &&
            !isTransientHttpStatus(response.status)
          ) {
            try {
              const body = request.body || {};
              const summarizeMessage = m => ({
                role: m?.role,
                contentType: typeof m?.content,
                contentLength:
                  typeof m?.content === 'string'
                    ? m.content.length
                    : Array.isArray(m?.content)
                      ? m.content.length
                      : null,
                contentPartsShape: Array.isArray(m?.content)
                  ? m.content.map(p => ({
                      type: p?.type,
                      textLength: typeof p?.text === 'string' ? p.text.length : null,
                      hasImageUrl: !!p?.image_url
                    }))
                  : undefined,
                hasImageData: Array.isArray(m?.imageData) || !!m?.imageData || undefined,
                hasToolCalls:
                  Array.isArray(m?.tool_calls) && m.tool_calls.length > 0 ? true : undefined
              });
              // Google adapter shape (contents/systemInstruction) vs OpenAI shape
              // (messages). Cover both so this works for every provider that
              // routes through this helper.
              const messages = Array.isArray(body.messages)
                ? body.messages.map(summarizeMessage)
                : null;
              const contents = Array.isArray(body.contents)
                ? body.contents.map(c => ({
                    role: c?.role,
                    partsCount: Array.isArray(c?.parts) ? c.parts.length : 0,
                    partsShape: Array.isArray(c?.parts)
                      ? c.parts.map(p => ({
                          keys: p ? Object.keys(p) : [],
                          textLength: typeof p?.text === 'string' ? p.text.length : null,
                          inlineDataMimeType: p?.inlineData?.mimeType,
                          inlineDataLength: p?.inlineData?.data?.length
                        }))
                      : undefined
                  }))
                : null;
              const sysInst = body.systemInstruction;
              requestShape = {
                topLevelKeys: Object.keys(body),
                model: body.model,
                stream: body.stream,
                maxTokens: body.max_tokens || body.generationConfig?.maxOutputTokens,
                temperature: body.temperature || body.generationConfig?.temperature,
                thinkingConfig: body.generationConfig?.thinkingConfig,
                responseModalities: body.generationConfig?.responseModalities,
                hasTools: Array.isArray(body.tools) && body.tools.length > 0,
                toolCount: Array.isArray(body.tools) ? body.tools.length : 0,
                hasResponseFormat: !!body.response_format,
                responseFormatType: body.response_format?.type,
                hasResponseSchema: !!body.generationConfig?.responseSchema,
                responseMimeType: body.generationConfig?.responseMimeType,
                messageCount: messages?.length,
                messages,
                contentsCount: contents?.length,
                contents,
                systemInstructionLength:
                  typeof sysInst?.parts?.[0]?.text === 'string'
                    ? sysInst.parts[0].text.length
                    : typeof sysInst === 'string'
                      ? sysInst.length
                      : null,
                bodyJsonLength: JSON.stringify(body).length
              };
            } catch (shapeErr) {
              requestShape = { shapeBuildError: shapeErr.message };
            }
          }

          // For non-transient 4xx failures, dump the FULL request body +
          // response to disk so we can inspect everything without overwhelming
          // the log line. Files land under contents/data/debug/llm-failures/.
          // Skip 429 (retried) so we don't write a dump file per attempt.
          // Best-effort — never let a disk-write failure mask the LLM error.
          let dumpPath = null;
          if (
            response.status >= 400 &&
            response.status < 500 &&
            !isTransientHttpStatus(response.status)
          ) {
            try {
              dumpPath = await this._dumpRequest(request, model, 'failures', {
                response: { status: response.status, body: errorInfo.details }
              });
            } catch (dumpErr) {
              dumpPath = `dump-failed: ${dumpErr.message}`;
            }
          }

          // Non-transient (4xx other than 429) failures are terminal — log the
          // full diagnostic now. Transient failures are logged by the retry
          // handler (warn per attempt), plus once at error level if the retry
          // budget is exhausted (see the .catch below).
          if (!isTransientHttpStatus(response.status)) {
            logger.error('LLM request failed', {
              component: 'WorkflowLLMHelper',
              modelId: model.id,
              status: response.status,
              errorCode: errorInfo.code,
              errorMessage: errorInfo.message,
              errorDetails: errorInfo.details,
              requestShape,
              dumpPath
            });
          }

          const error = new Error(errorInfo.message);
          error.code = errorInfo.code;
          error.status = errorInfo.httpStatus;
          error.details = errorInfo.details;
          error.retryAfterMs = parseRetryAfterMs(
            typeof response.headers?.get === 'function' ? response.headers.get('retry-after') : null
          );
          throw error;
        }
        return response;
      },
      {
        onRetry: ({ attempt, err, delayMs }) => {
          logger.warn('Transient LLM error — retrying', {
            component: 'WorkflowLLMHelper',
            modelId: model.id,
            status: err?.status ?? 'network',
            errorCode: err?.code,
            attempt: attempt + 1,
            maxRetries: this.maxRetries,
            delayMs
          });
        }
      }
    ).catch(err => {
      if (isTransientLlmError(err)) {
        logger.error('LLM request failed after exhausting transient retries', {
          component: 'WorkflowLLMHelper',
          modelId: model.id,
          status: err?.status ?? 'network',
          errorCode: err?.code,
          maxRetries: this.maxRetries
        });
      }
      throw err;
    });

    // Process the streaming response
    return await this.processStreamingResponse(response, model);
  }

  /**
   * Write a dump of the outbound request (and optionally the response) to
   * `contents/data/debug/llm-{bucket}/<ts>-<modelId>-<status>.json`.
   *
   * Two callers:
   *   - 4xx failure path (bucket='failures'): includes the error response
   *   - LLM_DEBUG_DUMP_ALL=1 path (bucket='request'): request only, sent
   *     BEFORE the fetch — used to compare what we send to different
   *     models (e.g. Pro vs Flash) byte-for-byte.
   *
   * API keys are stripped from the URL and auth-style headers are redacted.
   * Returns the absolute path to the file written.
   * @private
   */
  async _dumpRequest(request, model, bucket, extra = {}) {
    const { mkdir, writeFile } = await import('node:fs/promises');
    const path = await import('node:path');
    const { getRootDir } = await import('../../pathUtils.js');
    const cfg = (await import('../../config.js')).default;
    const dir = path.join(getRootDir(), cfg.CONTENTS_DIR, 'data', 'debug', `llm-${bucket}`);
    await mkdir(dir, { recursive: true });
    const ts = new Date().toISOString().replace(/[:.]/g, '-');
    const safeModelId = String(model.id || 'unknown').replace(/[^a-zA-Z0-9_-]+/g, '_');
    const statusSuffix = extra.response?.status ? `-${extra.response.status}` : '';
    const file = path.join(dir, `${ts}-${safeModelId}${statusSuffix}.json`);
    const redactedUrl =
      typeof request.url === 'string' ? request.url.replace(/key=[^&]+/, 'key=REDACTED') : null;
    const redactedHeaders = { ...(request.headers || {}) };
    for (const k of Object.keys(redactedHeaders)) {
      if (/auth|api[-_]?key|bearer|token/i.test(k)) redactedHeaders[k] = 'REDACTED';
    }
    await writeFile(
      file,
      JSON.stringify(
        {
          timestamp: new Date().toISOString(),
          model: { id: model.id, provider: model.provider, modelId: model.modelId },
          request: {
            url: redactedUrl,
            method: 'POST',
            headers: redactedHeaders,
            body: request.body
          },
          ...(extra.response ? { response: extra.response } : {})
        },
        null,
        2
      )
    );
    return file;
  }

  /**
   * Process a streaming response and extract content and tool calls.
   *
   * Uses getStreamReader() for node-fetch/Web Streams compatibility.
   * Uses convertResponseToGeneric() for provider-agnostic response parsing.
   *
   * @param {Response} response - Fetch response object
   * @param {Object} model - Model configuration (for provider info)
   * @returns {Promise<Object>} Collected response with { content, toolCalls }
   */
  async processStreamingResponse(response, model) {
    // Use getStreamReader for node-fetch/Web Streams compatibility
    const reader = getStreamReader(response);
    const decoder = new TextDecoder();
    const events = [];
    const parser = createParser({ onEvent: e => events.push(e) });

    let content = '';
    const toolCalls = [];
    const thoughtSignatures = [];
    let usage = null;
    let groundingMetadata = null;
    let done = false;

    while (!done) {
      const { value, done: readerDone } = await reader.read();
      if (readerDone) break;

      const chunk = decoder.decode(value, { stream: true });
      parser.feed(chunk);

      while (events.length > 0) {
        const evt = events.shift();
        const result = await convertResponseToGeneric(evt.data, model.provider);

        if (result.error) {
          throw new Error(result.errorMessage || 'Error processing LLM response');
        }

        // Accumulate content
        if (result.content?.length > 0) {
          content += result.content.join('');
        }

        // Collect tool calls
        if (result.tool_calls?.length > 0) {
          this.mergeToolCalls(toolCalls, result.tool_calls);
        }

        // Collect thoughtSignatures (required for Gemini 3 thinking models with tool calling)
        if (result.thoughtSignatures?.length > 0) {
          thoughtSignatures.push(...result.thoughtSignatures);
        }

        // Capture usage data (usually in final chunk)
        if (result.usage) {
          usage = result.usage;
        }

        // Capture native-web-search grounding metadata. Each chunk may carry
        // partial metadata — Gemini splits groundingChunks across chunks, and
        // Anthropic streams one citations_delta / web_search_tool_result per
        // event — so merge every known array shape instead of keeping only
        // the first chunk's arrays.
        if (result.groundingMetadata) {
          if (!groundingMetadata) {
            groundingMetadata = { ...result.groundingMetadata };
          } else {
            // groundingChunks/webSearchQueries: Google; searchResults/citations: Anthropic
            for (const key of [
              'groundingChunks',
              'webSearchQueries',
              'searchResults',
              'citations'
            ]) {
              if (Array.isArray(result.groundingMetadata[key])) {
                groundingMetadata[key] = [
                  ...(groundingMetadata[key] || []),
                  ...result.groundingMetadata[key]
                ];
              }
            }
          }
        }

        if (result.complete) {
          done = true;
          break;
        }
      }
    }

    return { content, toolCalls, thoughtSignatures, usage, groundingMetadata };
  }

  /**
   * Merge streaming tool call chunks into complete tool calls.
   *
   * Streaming responses send tool calls in chunks (index, id, function name, arguments).
   * This method accumulates them into complete tool call objects.
   *
   * @param {Array} collectedCalls - Array of collected tool calls (mutated)
   * @param {Array} newCalls - New tool call chunks to merge
   */
  mergeToolCalls(collectedCalls, newCalls) {
    for (const call of newCalls) {
      let existing = collectedCalls.find(c => c.index === call.index);

      if (existing) {
        if (call.id) existing.id = call.id;
        if (call.type) existing.type = call.type;
        if (call.function) {
          if (call.function.name) existing.function.name = call.function.name;
          if (call.function.arguments) {
            existing.function.arguments += call.function.arguments;
          }
        }
        // Preserve metadata (critical for Gemini thoughtSignatures)
        if (call.metadata) {
          existing.metadata = { ...(existing.metadata || {}), ...call.metadata };
        }
      } else if (call.index !== undefined) {
        collectedCalls.push({
          index: call.index,
          id: call.id || null,
          type: call.type || 'function',
          function: {
            name: call.function?.name || '',
            arguments: call.function?.arguments || ''
          },
          metadata: call.metadata || undefined
        });
      }
    }
  }
}

export default WorkflowLLMHelper;
