/**
 * OpenTelemetry Gen-AI Instrumentation
 * Main class for instrumenting GenAI operations
 */

import { trace, SpanStatusCode } from '@opentelemetry/api';
import {
  buildProviderAttributes,
  buildOperationAttributes,
  buildRequestAttributes,
  buildResponseAttributes,
  buildUsageAttributes,
  buildServerAttributes,
  buildErrorAttributes,
  buildCustomAttributes,
  mergeAttributes
} from './attributes.js';
import { emitPromptEvent, emitCompletionEvent, emitChoiceEvent } from './events.js';
import { recordTokenUsage, recordOperationDuration } from './metrics.js';

/**
 * GenAI Instrumentation Class
 */
export class GenAIInstrumentation {
  constructor(config = {}) {
    this.config = config;
    this.tracer = trace.getTracer('ihub-apps-genai', '1.0.0');
    this.enabled = config.enabled !== false && config.spans?.enabled !== false;
  }

  /**
   * Create a span for an LLM operation
   * @param {string} operation - Operation name (chat, text_completion, etc.)
   * @param {Object} model - Model configuration
   * @param {string} provider - Provider name
   * @param {Object} customContext - Custom context (appId, userId, etc.)
   * @returns {Object} OpenTelemetry span
   */
  createLLMSpan(operation, model, provider, customContext = {}) {
    if (!this.enabled) return null;

    try {
      const spanName = `${operation} ${model.modelId}`;
      const spanAttributes = mergeAttributes(
        buildOperationAttributes(operation),
        buildProviderAttributes(provider),
        { 'gen_ai.request.model': model.modelId },
        buildServerAttributes(model),
        buildCustomAttributes(customContext)
      );

      return this.tracer.startSpan(spanName, {
        kind: 1, // SpanKind.CLIENT
        attributes: spanAttributes
      });
    } catch (error) {
      console.warn('Failed to create LLM span:', error.message);
      return null;
    }
  }

  /**
   * Record request attributes and emit prompt event
   * @param {Object} span - Active span
   * @param {Object} model - Model configuration
   * @param {Array} messages - Prompt messages
   * @param {Object} options - Request options
   */
  recordRequest(span, model, messages, options = {}) {
    if (!span || !this.enabled) return;

    try {
      // Set request attributes
      const requestAttrs = buildRequestAttributes(model, options);
      span.setAttributes(requestAttrs);

      // Emit prompt event if configured
      if (this.config.events?.enabled) {
        emitPromptEvent(span, messages, this.config);
      }
    } catch (error) {
      console.warn('Failed to record request:', error.message);
    }
  }

  /**
   * Record response attributes and emit completion event
   * @param {Object} span - Active span
   * @param {Object} response - API response
   * @param {Object} usage - Token usage information
   */
  recordResponse(span, response, usage) {
    if (!span || !this.enabled) return;

    try {
      // Set response attributes
      const responseAttrs = mergeAttributes(
        buildResponseAttributes(response),
        buildUsageAttributes(usage)
      );
      span.setAttributes(responseAttrs);

      // Emit completion event if configured
      if (this.config.events?.enabled) {
        emitCompletionEvent(span, response, this.config);
      }

      // Record token usage metrics
      if (this.config.metrics?.enabled && usage) {
        const spanAttrs = span.attributes || {};
        recordTokenUsage(spanAttrs, usage);
      }
    } catch (error) {
      console.warn('Failed to record response:', error.message);
    }
  }

  /**
   * Record tool/function call choice
   * @param {Object} span - Active span
   * @param {Object} choice - Choice object with tool calls
   * @param {number} index - Choice index
   */
  recordChoice(span, choice, index = 0) {
    if (!span || !this.enabled) return;

    try {
      if (this.config.events?.enabled) {
        emitChoiceEvent(span, choice, index, this.config);
      }
    } catch (error) {
      console.warn('Failed to record choice:', error.message);
    }
  }

  /**
   * End span with optional error
   * @param {Object} span - Span to end
   * @param {Error} error - Optional error object
   * @param {number} durationSeconds - Operation duration in seconds
   */
  endSpan(span, error = null, durationSeconds = null) {
    if (!span || !this.enabled) return;

    try {
      if (error) {
        // Record exception and set error status
        span.recordException(error);
        span.setStatus({ code: SpanStatusCode.ERROR, message: error.message });

        // Set error attributes
        const errorAttrs = buildErrorAttributes(error);
        span.setAttributes(errorAttrs);

        // Record duration with error
        if (this.config.metrics?.enabled && durationSeconds !== null) {
          const spanAttrs = span.attributes || {};
          recordOperationDuration(durationSeconds, spanAttrs, error);
        }
      } else {
        // Set OK status
        span.setStatus({ code: SpanStatusCode.OK });

        // Record duration without error
        if (this.config.metrics?.enabled && durationSeconds !== null) {
          const spanAttrs = span.attributes || {};
          recordOperationDuration(durationSeconds, spanAttrs);
        }
      }

      span.end();
    } catch (err) {
      console.warn('Failed to end span:', err.message);
      span?.end();
    }
  }

  /**
   * Wrap an async function with instrumentation
   * @param {string} operation - Operation name
   * @param {Object} model - Model configuration
   * @param {string} provider - Provider name
   * @param {Object} messages - Messages array
   * @param {Object} options - Request options
   * @param {Object} customContext - Custom context
   * @param {Function} fn - Async function to wrap
   * @returns {Promise} Result of wrapped function
   */
  async instrumentOperation(operation, model, provider, messages, options, customContext, fn) {
    const span = this.createLLMSpan(operation, model, provider, customContext);

    try {
      // Record request
      this.recordRequest(span, model, messages, options);

      // Execute operation
      const startTime = Date.now();
      const result = await fn();
      const duration = (Date.now() - startTime) / 1000;

      // Record response
      this.recordResponse(span, result, result.usage);

      // End span successfully
      this.endSpan(span, null, duration);

      return result;
    } catch (error) {
      // Calculate duration even on error
      const duration = span ? (Date.now() - span.startTime.getTime()) / 1000 : 0;

      // End span with error
      this.endSpan(span, error, duration);

      throw error;
    }
  }

  /**
   * Check if instrumentation is enabled
   * @returns {boolean} True if enabled
   */
  isEnabled() {
    return this.enabled;
  }
}
