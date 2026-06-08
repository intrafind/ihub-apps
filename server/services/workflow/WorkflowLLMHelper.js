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

/**
 * Valid adapter options as defined in BaseAdapter.extractRequestOptions()
 * @type {string[]}
 */
const VALID_ADAPTER_OPTIONS = [
  'temperature',
  'stream',
  'maxTokens',
  'tools',
  'toolChoice',
  'responseFormat',
  'responseSchema'
];

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
    const filtered = {};

    for (const key of VALID_ADAPTER_OPTIONS) {
      if (options[key] !== undefined) {
        filtered[key] = options[key];
      }
    }

    return filtered;
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

    // Create the request using centralized adapter infrastructure
    const request = createCompletionRequest(model, messages, apiKey, filteredOptions);

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

    // Execute the request
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
      // payloads, missing fields, etc.
      let requestShape = null;
      if (response.status >= 400 && response.status < 500) {
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
            hasImageData:
              Array.isArray(m?.imageData) || !!m?.imageData || undefined,
            hasToolCalls: Array.isArray(m?.tool_calls) && m.tool_calls.length > 0 ? true : undefined
          });
          // Google adapter shape (contents/systemInstruction) vs OpenAI shape
          // (messages). Cover both so this works for every provider that
          // routes through this helper.
          const messages = Array.isArray(body.messages) ? body.messages.map(summarizeMessage) : null;
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

      // For 4xx failures, dump the FULL request body + response to disk
      // so we can inspect everything without overwhelming the log line. Files
      // land under contents/data/debug/llm-failures/. Best-effort — never let
      // a disk-write failure mask the original LLM error.
      let dumpPath = null;
      if (response.status >= 400 && response.status < 500) {
        try {
          dumpPath = await this._dumpRequest(request, model, 'failures', {
            response: { status: response.status, body: errorInfo.details }
          });
        } catch (dumpErr) {
          dumpPath = `dump-failed: ${dumpErr.message}`;
        }
      }

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

      const error = new Error(errorInfo.message);
      error.code = errorInfo.code;
      error.status = errorInfo.httpStatus;
      error.details = errorInfo.details;
      throw error;
    }

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

        // Capture grounding metadata (Gemini native googleSearch). Each
        // chunk may carry partial metadata; merge groundingChunks across
        // chunks so we don't drop URLs.
        if (result.groundingMetadata) {
          if (!groundingMetadata) {
            groundingMetadata = { ...result.groundingMetadata };
          } else {
            if (Array.isArray(result.groundingMetadata.groundingChunks)) {
              groundingMetadata.groundingChunks = [
                ...(groundingMetadata.groundingChunks || []),
                ...result.groundingMetadata.groundingChunks
              ];
            }
            if (Array.isArray(result.groundingMetadata.webSearchQueries)) {
              groundingMetadata.webSearchQueries = [
                ...(groundingMetadata.webSearchQueries || []),
                ...result.groundingMetadata.webSearchQueries
              ];
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
