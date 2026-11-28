// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * Telemetry of one LLM call: the GenAI client span and the GenAI metrics.
 *
 * `LLMClient` starts an {@link LLMCallTelemetry} per model call and ends it with
 * `succeed()` or `fail()`. The span goes through the helpers of `spans.js` (the
 * attribute filter, `error.type`, abort handling, idempotent end) and names the
 * user only through `identity.js`.
 *
 * The metrics (`gen_ai.client.inference.duration`, the
 * `gen_ai.client.inference.operation.*` token histograms and the
 * `gen_ai.client.inference.usage.*` token counters) are built from the call's own data, never from `span.attributes`: a span that
 * is sampled out or switched off has none, and the metrics must not depend on
 * either. They are recorded whenever the metric instruments exist.
 *
 * @see https://github.com/open-telemetry/semantic-conventions-genai/blob/main/docs/gen-ai/client-inference.md
 */

import {
  buildOperationAttributes,
  buildProviderAttributes,
  buildRequestAttributes,
  buildResponseAttributes,
  buildServerAttributes,
  buildUsageAttributes
} from './attributes.js';
import { inputMessagesAttributes, outputMessagesAttributes } from './contentCapture.js';
import { conversationSpanAttributes, userSpanAttributes } from './identity.js';
import {
  recordInferenceDuration,
  recordInferenceTokens,
  recordLlmInflight,
  recordTimeToFirstChunk
} from './metrics.js';
import { errorTypeOf, isAbortError, SpanKind, startSpan } from './spans.js';

/**
 * One LLM call's span and metrics. Every method is safe to call more than
 * once and after the call ended, and never throws.
 */
export class LLMCallTelemetry {
  /**
   * @param {Object} config - The telemetry config (read for content capture)
   * @param {Object} call
   * @param {string} call.operation - `gen_ai.operation.name`
   * @param {Object} call.model - The model config (`modelId`, `url`)
   * @param {string} call.provider - `gen_ai.provider.name`
   * @param {string} [call.appId]
   * @param {string} [call.userId] - Pseudonymised by `identity.js`
   * @param {string} [call.conversationId] - Hashed by `identity.js`
   * @param {number} [call.messageCount]
   * @param {boolean} [call.isFollowUp]
   * @param {string} [call.surface] - `chat`, `agent`, `workflow`, `task`, `api`, `magic`, `system`
   * @param {number} [call.startedAt] - ms timestamp; defaults to now
   */
  constructor(config, call) {
    this.config = config || {};
    this.startedAt = call.startedAt ?? Date.now();
    this.ended = false;
    const modelId = call.model?.modelId;
    const server = buildServerAttributes(call.model);
    // The metric labels: closed sets only (operation, provider, model id and
    // endpoint host from config, app id from config, surface). Never read back
    // from the span.
    this.metricAttributes = {
      ...buildOperationAttributes(call.operation),
      ...buildProviderAttributes(call.provider),
      ...(modelId ? { 'gen_ai.request.model': modelId } : {}),
      ...(call.appId ? { 'app.id': call.appId } : {}),
      ...(call.surface ? { 'ihub.surface': call.surface } : {}),
      ...(server['server.address'] ? { 'server.address': server['server.address'] } : {})
    };
    this.firstChunkSeen = false;
    recordLlmInflight(1, this.metricAttributes['gen_ai.provider.name']);
    this.span = startSpan(`${this.metricAttributes['gen_ai.operation.name']} ${modelId}`, {
      kind: SpanKind.CLIENT,
      attributes: {
        ...this.metricAttributes,
        ...server,
        ...userSpanAttributes(call.userId),
        ...conversationSpanAttributes(call.conversationId),
        ...(Number.isInteger(call.messageCount)
          ? { 'conversation.message_count': call.messageCount }
          : {}),
        ...(typeof call.isFollowUp === 'boolean'
          ? { 'conversation.is_follow_up': call.isFollowUp }
          : {})
      }
    });
  }

  /**
   * Request parameters, and the prompt when prompt capture is on.
   *
   * @param {Array<Object>} messages
   * @param {Object} [options] - temperature, maxTokens, topP, topK, …
   */
  recordRequest(messages, options = {}) {
    if (this.ended || !this.span.isRecording) return;
    try {
      this.span.setAttributes({
        ...buildRequestAttributes(null, options),
        ...inputMessagesAttributes(messages, this.config)
      });
    } catch {
      /* telemetry must never break a call */
    }
  }

  /**
   * The call finished: response attributes, token and duration metrics, end.
   *
   * @param {Object} [result]
   * @param {Object} [result.usage] - inputTokens, outputTokens, cache/reasoning tokens
   * @param {Array<string>} [result.finishReasons]
   * @param {string} [result.responseModel]
   * @param {string} [result.outputText] - Captured only when completion capture is on
   * @param {Array<Object>} [result.toolCalls] - Names captured only when completion capture is on
   * @param {boolean} [result.aborted] - The user stopped the answer after it started:
   *   `ihub.aborted` on the span, tokens recorded, no duration
   */
  succeed({ usage, finishReasons, responseModel, outputText, toolCalls, aborted = false } = {}) {
    if (this.ended) return;
    this.ended = true;
    try {
      recordInferenceTokens(this.metricAttributes, usage);
      if (aborted) this.span.abort();
      else recordInferenceDuration(this.durationSeconds(), this.metricAttributes);
      if (this.span.isRecording) {
        this.span.setAttributes({
          ...buildResponseAttributes({ finishReasons, model: responseModel }),
          ...buildUsageAttributes(usage || {}),
          ...outputMessagesAttributes(
            { text: outputText, toolCalls, finishReason: finishReasons?.[0] },
            this.config
          )
        });
      }
    } catch {
      /* telemetry must never break a call */
    } finally {
      this._settled();
      this.span.end();
    }
  }

  /**
   * The call failed or was stopped. A failure sets `error.type` on the span,
   * the duration and the token histograms (with the provider's usage when it
   * sent one before failing, `0` otherwise); a stop (user, client disconnect)
   * sets `ihub.aborted` and records no metric, since the user chose it.
   *
   * @param {unknown} err
   * @param {Object} [options]
   * @param {Object} [options.usage] - The usage the provider reported before the failure
   */
  fail(err, { usage = null } = {}) {
    if (this.ended) return;
    this.ended = true;
    try {
      if (!isAbortError(err)) {
        recordInferenceDuration(this.durationSeconds(), this.metricAttributes, err);
        recordInferenceTokens(this.metricAttributes, usage, err);
        if (usage && this.span.isRecording) this.span.setAttributes(buildUsageAttributes(usage));
      }
      this.span.fail(err);
    } catch {
      /* telemetry must never break a call */
    } finally {
      this._settled();
      this.span.end();
    }
  }

  /**
   * A transient failure is retried: one event per attempt on the span.
   *
   * @param {number} attempt - 1 for the first retry
   * @param {unknown} err
   */
  retried(attempt, err) {
    if (this.ended) return;
    this.span.addEvent('ihub.llm.retry', {
      'ihub.retry.attempt': attempt,
      'error.type': errorTypeOf(err) ?? 'unknown'
    });
  }

  /**
   * The provider paused the turn (`pause_turn`) and the call continues on a new
   * request.
   *
   * @param {number} continuation - 1 for the first continuation
   */
  continued(continuation) {
    if (this.ended) return;
    this.span.addEvent('ihub.llm.pause_turn', { 'ihub.continuation': continuation });
  }

  /**
   * The stream of this call was dropped without being read to its end (no
   * consumer, no error): the span ends marked `ihub.stream.abandoned`.
   */
  abandon() {
    if (this.ended) return;
    this.ended = true;
    this.span.setAttributes({ 'ihub.stream.abandoned': true });
    this._settled();
    this.span.end();
  }

  /**
   * The first output chunk of a streamed call arrived: records
   * `gen_ai.client.inference.time_to_first_chunk` (once) and the span attribute.
   */
  firstChunk() {
    if (this.firstChunkSeen || this.ended) return;
    this.firstChunkSeen = true;
    const seconds = this.durationSeconds();
    recordTimeToFirstChunk(seconds, this.metricAttributes);
    this.span.setAttributes({ 'gen_ai.response.time_to_first_chunk': seconds });
  }

  /** The call is over: one less in flight. */
  _settled() {
    recordLlmInflight(-1, this.metricAttributes['gen_ai.provider.name']);
  }

  /** @returns {number} Seconds since the call started. */
  durationSeconds() {
    return (Date.now() - this.startedAt) / 1000;
  }
}

/**
 * Starts the telemetry of LLM calls. One instance exists while telemetry is
 * initialised (`getGenAIInstrumentation()`); it reads the live config, so
 * admin changes to content capture apply to the next call.
 */
export class GenAIInstrumentation {
  constructor(config = {}) {
    this.config = config;
  }

  /**
   * Start the telemetry of one call.
   *
   * @param {Object} call - See {@link LLMCallTelemetry}
   * @returns {LLMCallTelemetry}
   */
  startCall(call) {
    return new LLMCallTelemetry(this.config, call);
  }
}
