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
 * The metrics (`gen_ai.client.token.usage`, `gen_ai.client.operation.duration`)
 * are built from the call's own data, never from `span.attributes`: a span that
 * is sampled out or switched off has none, and the metrics must not depend on
 * either. They are recorded whenever the metric instruments exist.
 *
 * @see https://opentelemetry.io/docs/specs/semconv/gen-ai/
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
import { recordOperationDuration, recordTokenUsage } from './metrics.js';
import { isAbortError, SpanKind, startSpan } from './spans.js';

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
   * @param {number} [call.startedAt] - ms timestamp; defaults to now
   */
  constructor(config, call) {
    this.config = config || {};
    this.startedAt = call.startedAt ?? Date.now();
    this.ended = false;
    const modelId = call.model?.modelId;
    // The metric labels: closed sets only (operation, provider, model id from
    // config, app id from config). Never read back from the span.
    this.metricAttributes = {
      ...buildOperationAttributes(call.operation),
      ...buildProviderAttributes(call.provider),
      ...(modelId ? { 'gen_ai.request.model': modelId } : {}),
      ...(call.appId ? { 'app.id': call.appId } : {})
    };
    this.span = startSpan(`${this.metricAttributes['gen_ai.operation.name']} ${modelId}`, {
      kind: SpanKind.CLIENT,
      attributes: {
        ...this.metricAttributes,
        ...buildServerAttributes(call.model),
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
      recordTokenUsage(this.metricAttributes, usage);
      if (aborted) this.span.abort();
      else recordOperationDuration(this.durationSeconds(), this.metricAttributes);
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
      this.span.end();
    }
  }

  /**
   * The call failed or was stopped. A failure sets `error.type` on the span
   * and the duration metric; a stop (user, client disconnect) sets
   * `ihub.aborted` and records no duration, since the user chose it.
   *
   * @param {unknown} err
   */
  fail(err) {
    if (this.ended) return;
    this.ended = true;
    try {
      if (!isAbortError(err)) {
        recordOperationDuration(this.durationSeconds(), this.metricAttributes, err);
      }
      this.span.fail(err);
    } catch {
      /* telemetry must never break a call */
    } finally {
      this.span.end();
    }
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
