/**
 * OpenTelemetry Gen-AI Metrics Recording
 * Implements https://opentelemetry.io/docs/specs/semconv/gen-ai/gen-ai-metrics/
 */

// Recommended histogram buckets for token usage (in tokens)
const TOKEN_USAGE_BUCKETS = [
  1, 4, 16, 64, 256, 1024, 4096, 16384, 65536, 262144, 1048576, 4194304, 16777216, 67108864
];

// Recommended histogram buckets for operation duration (in seconds)
const OPERATION_DURATION_BUCKETS = [
  0.01, 0.02, 0.04, 0.08, 0.16, 0.32, 0.64, 1.28, 2.56, 5.12, 10.24, 20.48, 40.96, 81.92
];

/**
 * Allow-list of label keys we attach to metrics. Anything outside this set
 * is dropped before the instrument is recorded.
 *
 * Why so strict?  Prometheus creates a brand-new time series for every unique
 * combination of label values. Free-form keys like gen_ai.conversation.id,
 * gen_ai.response.id, gen_ai.usage.input_tokens (which is the value itself!)
 * and conversation.message_count are unbounded, so emitting them as labels
 * creates a series-per-chat or series-per-token-count and explodes storage.
 *
 * The OpenTelemetry gen-ai semantic conventions explicitly mark those high-
 * cardinality attributes as span-only - they belong on the span where you can
 * filter / drill in, not on the histogram aggregation.
 *
 * Keep this list as small as possible; add new keys only when they have a
 * known small set of values (operation, provider, model, error.type, ...).
 */
const ALLOWED_METRIC_LABELS = new Set([
  'gen_ai.operation.name',
  'gen_ai.provider.name',
  'gen_ai.request.model',
  'gen_ai.response.model',
  'gen_ai.token.type',
  'error.type',
  'error.context',
  'app.id',
  'conversation.is_follow_up'
]);

function filterMetricLabels(attrs) {
  if (!attrs) return {};
  const out = {};
  for (const key of Object.keys(attrs)) {
    if (ALLOWED_METRIC_LABELS.has(key)) {
      out[key] = attrs[key];
    }
  }
  return out;
}

let tokenUsageHistogram = null;
let operationDurationHistogram = null;
let appUsageCounter = null;
let promptUsageCounter = null;
let errorCounter = null;
let conversationCounter = null;
let activeUsersGauge = null;
let activeChatsGauge = null;

/**
 * Initialize metrics from a meter source. Accepts anything with a
 * `getMeter(name, version)` method - either the global metrics API
 * (@opentelemetry/api `metrics`) or a MeterProvider instance.
 * @param {Object} meterSource - Meter source with `getMeter(name, version)`
 */
export function initializeMetrics(meterSource) {
  if (!meterSource || typeof meterSource.getMeter !== 'function') return;

  const meter = meterSource.getMeter('ihub-apps-genai', '1.0.0');

  // Create token usage histogram
  tokenUsageHistogram = meter.createHistogram('gen_ai.client.token.usage', {
    description: 'Number of input and output tokens used',
    unit: '{token}',
    advice: {
      explicitBucketBoundaries: TOKEN_USAGE_BUCKETS
    }
  });

  // Create operation duration histogram
  operationDurationHistogram = meter.createHistogram('gen_ai.client.operation.duration', {
    description: 'Duration of GenAI operation',
    unit: 's',
    advice: {
      explicitBucketBoundaries: OPERATION_DURATION_BUCKETS
    }
  });

  // Create app usage counter
  appUsageCounter = meter.createCounter('ihub.app.usage', {
    description: 'Number of times each app is used',
    unit: '{request}'
  });

  // Create prompt usage counter
  promptUsageCounter = meter.createCounter('ihub.prompt.usage', {
    description: 'Number of times each prompt is used',
    unit: '{request}'
  });

  // Create error counter
  errorCounter = meter.createCounter('ihub.errors', {
    description: 'Number of errors by type and context',
    unit: '{error}'
  });

  // Create conversation counter
  conversationCounter = meter.createCounter('ihub.conversations', {
    description: 'Number of conversations and follow-up messages',
    unit: '{message}'
  });

  // Active users (rolling window) - observable gauge populated by ActivityTracker
  activeUsersGauge = meter.createObservableGauge('ihub.active.users', {
    description: 'Number of distinct users active in the rolling window',
    unit: '{user}'
  });

  // Active chats (rolling window) - observable gauge populated by ActivityTracker
  activeChatsGauge = meter.createObservableGauge('ihub.active.chats', {
    description: 'Number of distinct chat sessions active in the rolling window',
    unit: '{chat}'
  });

  console.info('GenAI metrics initialized successfully');
}

/**
 * Register observable callbacks for the active-users / active-chats gauges.
 * The provider supplies functions that return the current count for the
 * configured rolling window. Pass `getAttributes` (preferred) when the
 * exported attributes need to reflect runtime config changes - the function
 * is called every time the meter observes the gauge. `attributes` (static)
 * is kept for backwards compatibility.
 *
 * @param {Object} provider
 * @param {() => number} provider.getActiveUsers
 * @param {() => number} provider.getActiveChats
 * @param {() => Object} [provider.getAttributes] - Dynamic attributes (e.g. windowMinutes)
 * @param {Object} [provider.attributes] - Static attributes (legacy)
 */
export function registerActivityObservers(provider) {
  if (!activeUsersGauge || !activeChatsGauge || !provider) return;

  const resolveAttrs = () =>
    typeof provider.getAttributes === 'function'
      ? provider.getAttributes()
      : provider.attributes || {};

  activeUsersGauge.addCallback(observableResult => {
    try {
      const value = provider.getActiveUsers() || 0;
      observableResult.observe(value, resolveAttrs());
    } catch (error) {
      console.warn('Failed to observe active users:', error.message);
    }
  });

  activeChatsGauge.addCallback(observableResult => {
    try {
      const value = provider.getActiveChats() || 0;
      observableResult.observe(value, resolveAttrs());
    } catch (error) {
      console.warn('Failed to observe active chats:', error.message);
    }
  });
}

/**
 * Record token usage metrics
 * @param {Object} attributes - Span attributes (includes provider, model, etc.)
 * @param {Object} usage - Usage object with token counts
 */
export function recordTokenUsage(attributes, usage) {
  if (!tokenUsageHistogram || !usage) return;

  try {
    // Filter to a low-cardinality allow-list. The caller passes the full span
    // attributes which include unbounded keys (conversation id, response id,
    // even the token counts themselves) - those are great on spans but ruin
    // a Prometheus histogram if used as labels.
    const baseAttrs = filterMetricLabels(attributes);

    // Use nullish coalescing so a legitimate 0 is preserved
    const inputTokens = usage.inputTokens ?? usage.prompt_tokens;
    if (typeof inputTokens === 'number') {
      tokenUsageHistogram.record(inputTokens, {
        ...baseAttrs,
        'gen_ai.token.type': 'input'
      });
    }

    const outputTokens = usage.outputTokens ?? usage.completion_tokens;
    if (typeof outputTokens === 'number') {
      tokenUsageHistogram.record(outputTokens, {
        ...baseAttrs,
        'gen_ai.token.type': 'output'
      });
    }
  } catch (error) {
    console.warn('Failed to record token usage:', error.message);
  }
}

/**
 * Record operation duration metric
 * @param {number} durationSeconds - Duration in seconds
 * @param {Object} attributes - Span attributes (includes provider, model, operation, etc.)
 * @param {Error} [error] - Optional error object
 */
export function recordOperationDuration(durationSeconds, attributes, error = null) {
  if (!operationDurationHistogram) return;

  try {
    // Same allow-list pattern as recordTokenUsage - the caller passes the
    // full span attributes and we narrow to low-cardinality labels.
    const metricAttributes = filterMetricLabels(attributes);

    // Add error type if operation failed
    if (error) {
      metricAttributes['error.type'] = error.name || 'Error';

      // Map HTTP status codes
      if (error.status || error.statusCode) {
        const status = error.status || error.statusCode;
        if (status === 429) {
          metricAttributes['error.type'] = 'rate_limit_exceeded';
        } else if (status === 401 || status === 403) {
          metricAttributes['error.type'] = 'authentication_error';
        } else if (status === 408) {
          metricAttributes['error.type'] = 'timeout';
        } else {
          metricAttributes['error.type'] = `http_${status}`;
        }
      }

      // Map timeout errors
      if (error.code === 'ETIMEDOUT' || error.message?.includes('timeout')) {
        metricAttributes['error.type'] = 'timeout';
      }
    }

    operationDurationHistogram.record(durationSeconds, metricAttributes);
  } catch (err) {
    console.warn('Failed to record operation duration:', err.message);
  }
}

/**
 * Get metrics for manual recording (for backwards compatibility)
 * @returns {Object} Metrics objects
 */
export function getMetrics() {
  return {
    tokenUsageHistogram,
    operationDurationHistogram,
    appUsageCounter,
    promptUsageCounter,
    errorCounter,
    conversationCounter
  };
}

/**
 * Record app usage metric. user.id is intentionally NOT a label - in a
 * deployment with many users it explodes Prometheus cardinality. Per-user
 * lookups belong on spans (`user.id` is set on the span attributes via
 * buildCustomAttributes); the counter only carries app.id and the
 * already-resolved gen-ai dimensions.
 *
 * @param {string} appId - Application ID
 * @param {string} userId - Ignored as a metric label, kept for API compat
 * @param {Object} additionalAttributes - Extra attributes (filtered through allow-list)
 */
export function recordAppUsage(appId, userId = null, additionalAttributes = {}) {
  if (!appUsageCounter) return;

  try {
    const attributes = filterMetricLabels({
      'app.id': appId,
      ...additionalAttributes
    });

    appUsageCounter.add(1, attributes);
  } catch (error) {
    console.warn('Failed to record app usage:', error.message);
  }
  // userId is intentionally unused on the metric; reference for linters
  void userId;
}

/**
 * Record prompt usage metric
 * @param {string} promptId - Prompt ID
 * @param {string} appId - Application ID
 * @param {Object} additionalAttributes - Additional attributes
 */
export function recordPromptUsage(promptId, appId = null, additionalAttributes = {}) {
  if (!promptUsageCounter) return;

  try {
    const attributes = {
      'prompt.id': promptId,
      ...additionalAttributes
    };

    if (appId) {
      attributes['app.id'] = appId;
    }

    promptUsageCounter.add(1, attributes);
  } catch (error) {
    console.warn('Failed to record prompt usage:', error.message);
  }
}

/**
 * Record error metric
 * @param {string} errorType - Error type
 * @param {string} context - Error context (e.g., 'llm_call', 'tool_execution', 'validation')
 * @param {Object} additionalAttributes - Additional attributes
 */
export function recordError(errorType, context, additionalAttributes = {}) {
  if (!errorCounter) return;

  try {
    const attributes = filterMetricLabels({
      'error.type': errorType,
      'error.context': context,
      ...additionalAttributes
    });

    errorCounter.add(1, attributes);
  } catch (error) {
    console.warn('Failed to record error metric:', error.message);
  }
}

/**
 * Record conversation metric. The conversation id is NOT a label - it would
 * create a brand new time series for every chat session and explode
 * Prometheus storage. Aggregations (count, follow-up ratio) work fine
 * without it. The id is still attached to the span where you can drill in.
 *
 * @param {string} conversationId - Ignored as a label, kept for API compat
 * @param {boolean} isFollowUp - Whether this is a follow-up message
 * @param {Object} additionalAttributes - Extra attributes (filtered)
 */
export function recordConversation(conversationId, isFollowUp = false, additionalAttributes = {}) {
  if (!conversationCounter) return;

  try {
    const attributes = filterMetricLabels({
      'conversation.is_follow_up': isFollowUp,
      ...additionalAttributes
    });

    conversationCounter.add(1, attributes);
  } catch (error) {
    console.warn('Failed to record conversation metric:', error.message);
  }
  void conversationId;
}
