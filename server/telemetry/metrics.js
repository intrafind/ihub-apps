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
  // gen-ai semantic conventions
  'gen_ai.operation.name',
  'gen_ai.provider.name',
  'gen_ai.request.model',
  'gen_ai.response.model',
  'gen_ai.token.type',
  // common
  'error.type',
  'error.context',
  // iHub product dimensions
  'app.id',
  'conversation.is_follow_up',
  'auth.provider',
  'auth.event',
  'ratelimit.scope',
  'ratelimit.route',
  'stream.outcome',
  'upload.outcome',
  'upload.kind',
  'source.type',
  'config.file',
  'feedback.rating'
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

// Histogram bucket boundaries for byte-sized observations (uploads, etc.)
const BYTE_SIZE_BUCKETS = [
  1024, 4096, 16384, 65536, 262144, 1048576, 4194304, 16777216, 67108864, 268435456
];

// Histogram bucket boundaries for short-lived sub-second operations (config reload,
// auth events, etc.) - similar to standard HTTP request duration buckets.
const SHORT_DURATION_BUCKETS = [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10];

let tokenUsageHistogram = null;
let operationDurationHistogram = null;
let appUsageCounter = null;
let promptUsageCounter = null;
let errorCounter = null;
let conversationCounter = null;
let activeUsersGauge = null;
let activeChatsGauge = null;

// New instruments for items 1-10
let authEventCounter = null;
let rateLimitHitsCounter = null;
let streamOutcomeCounter = null;
let uploadCounter = null;
let uploadSizeHistogram = null;
let sourceDurationHistogram = null;
let sourceErrorCounter = null;
let configReloadCounter = null;
let configReloadDurationHistogram = null;
let magicPromptUsageCounter = null;
let feedbackCounter = null;
let feedbackRatingHistogram = null;

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

  // ---- Platform instruments ----

  authEventCounter = meter.createCounter('ihub.auth.events', {
    description: 'Authentication events by provider and outcome',
    unit: '{event}'
  });

  rateLimitHitsCounter = meter.createCounter('ihub.ratelimit.hits', {
    description: 'Number of times a request was rate-limited / throttled',
    unit: '{hit}'
  });

  streamOutcomeCounter = meter.createCounter('ihub.stream.outcome', {
    description: 'Streaming chat outcomes (completed, aborted, ...)',
    unit: '{stream}'
  });

  uploadCounter = meter.createCounter('ihub.upload.requests', {
    description: 'File upload requests by kind and outcome',
    unit: '{upload}'
  });

  uploadSizeHistogram = meter.createHistogram('ihub.upload.size', {
    description: 'Size of uploaded files in bytes',
    unit: 'By',
    advice: { explicitBucketBoundaries: BYTE_SIZE_BUCKETS }
  });

  sourceDurationHistogram = meter.createHistogram('ihub.source.duration', {
    description: 'Duration of source / RAG content loads',
    unit: 's',
    advice: { explicitBucketBoundaries: OPERATION_DURATION_BUCKETS }
  });

  sourceErrorCounter = meter.createCounter('ihub.source.errors', {
    description: 'Source / RAG load errors by source type and error class',
    unit: '{error}'
  });

  configReloadCounter = meter.createCounter('ihub.config.reload', {
    description: 'Configuration cache reload events',
    unit: '{reload}'
  });

  configReloadDurationHistogram = meter.createHistogram('ihub.config.reload.duration', {
    description: 'Duration of a configuration cache reload',
    unit: 's',
    advice: { explicitBucketBoundaries: SHORT_DURATION_BUCKETS }
  });

  magicPromptUsageCounter = meter.createCounter('ihub.magicprompt.usage', {
    description: 'Number of magic-prompt invocations',
    unit: '{request}'
  });

  feedbackCounter = meter.createCounter('ihub.feedback', {
    description: 'User feedback events bucketed by rating',
    unit: '{event}'
  });

  feedbackRatingHistogram = meter.createHistogram('ihub.feedback.rating', {
    description: 'Distribution of user feedback ratings (1-5)',
    unit: '{rating}',
    advice: { explicitBucketBoundaries: [1, 2, 3, 4, 5] }
  });

  console.info(
    `GenAI metrics initialized - allowed labels: ${[...ALLOWED_METRIC_LABELS].join(', ')}`
  );
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

// ---- Platform instrument helpers ----

/**
 * Record an authentication event.
 * @param {string} provider - 'oidc' | 'local' | 'jwt' | 'proxy' | 'ldap' | 'ntlm' | ...
 * @param {string} event - 'login_success' | 'login_failure' | 'token_validated' |
 *                         'token_invalid' | 'token_expired' | 'logout'
 */
export function recordAuthEvent(provider, event) {
  if (!authEventCounter) return;
  try {
    authEventCounter.add(1, filterMetricLabels({ 'auth.provider': provider, 'auth.event': event }));
  } catch (error) {
    console.warn('Failed to record auth event:', error.message);
  }
}

/**
 * Record a rate-limit / throttler hit.
 * @param {string} scope - 'http' | 'llm' | 'tool'
 * @param {string} route - express path or model id (low cardinality only)
 */
export function recordRateLimitHit(scope, route) {
  if (!rateLimitHitsCounter) return;
  try {
    rateLimitHitsCounter.add(
      1,
      filterMetricLabels({ 'ratelimit.scope': scope, 'ratelimit.route': route })
    );
  } catch (error) {
    console.warn('Failed to record rate limit hit:', error.message);
  }
}

/**
 * Record a streaming-chat outcome.
 * @param {string} outcome - 'completed' | 'aborted' | 'timeout' | 'error'
 * @param {Object} extra - additional dimensions filtered through the allow-list
 */
export function recordStreamOutcome(outcome, extra = {}) {
  if (!streamOutcomeCounter) return;
  try {
    streamOutcomeCounter.add(1, filterMetricLabels({ 'stream.outcome': outcome, ...extra }));
  } catch (error) {
    console.warn('Failed to record stream outcome:', error.message);
  }
}

/**
 * Record a file upload event and (optionally) its size.
 * @param {string} kind - 'chat' | 'admin_asset' | 'admin_backup' | 'ocr' | ...
 * @param {string} outcome - 'accepted' | 'rejected_size' | 'rejected_mime' | 'rejected_other'
 * @param {number} [sizeBytes] - File size in bytes; recorded into the size histogram if numeric
 */
export function recordUpload(kind, outcome, sizeBytes) {
  if (!uploadCounter) return;
  try {
    const labels = filterMetricLabels({ 'upload.kind': kind, 'upload.outcome': outcome });
    uploadCounter.add(1, labels);
    if (typeof sizeBytes === 'number' && sizeBytes >= 0 && uploadSizeHistogram) {
      uploadSizeHistogram.record(sizeBytes, labels);
    }
  } catch (error) {
    console.warn('Failed to record upload:', error.message);
  }
}

/**
 * Record the duration of a source / RAG content load.
 * @param {string} sourceType - 'filesystem' | 'url' | 'page' | 'ifinder' | ...
 * @param {number} durationSeconds
 * @param {Error} [error]
 */
export function recordSourceLoad(sourceType, durationSeconds, error = null) {
  if (sourceDurationHistogram) {
    try {
      sourceDurationHistogram.record(
        durationSeconds,
        filterMetricLabels({ 'source.type': sourceType })
      );
    } catch (err) {
      console.warn('Failed to record source duration:', err.message);
    }
  }
  if (error && sourceErrorCounter) {
    try {
      sourceErrorCounter.add(
        1,
        filterMetricLabels({ 'source.type': sourceType, 'error.type': error.name || 'Error' })
      );
    } catch (err) {
      console.warn('Failed to record source error:', err.message);
    }
  }
}

/**
 * Record a configuration cache reload.
 * @param {string} configFile - logical file id (e.g. 'config/platform.json')
 * @param {number} durationSeconds - how long the reload took
 * @param {Error} [error]
 */
export function recordConfigReload(configFile, durationSeconds, error = null) {
  const labels = filterMetricLabels({
    'config.file': configFile,
    'error.type': error ? error.name || 'Error' : undefined
  });
  if (configReloadCounter) {
    try {
      configReloadCounter.add(1, labels);
    } catch (err) {
      console.warn('Failed to record config reload:', err.message);
    }
  }
  if (configReloadDurationHistogram && typeof durationSeconds === 'number') {
    try {
      configReloadDurationHistogram.record(durationSeconds, labels);
    } catch (err) {
      console.warn('Failed to record config reload duration:', err.message);
    }
  }
}

/**
 * Record a magic-prompt invocation. Token totals already flow through the
 * gen_ai.client.token.usage histogram via the LLM instrumentation; this
 * counter is just for "how often is magic prompt being used per app."
 * @param {string} appId
 * @param {Object} extra
 */
export function recordMagicPromptUsage(appId, extra = {}) {
  if (!magicPromptUsageCounter) return;
  try {
    magicPromptUsageCounter.add(1, filterMetricLabels({ 'app.id': appId, ...extra }));
  } catch (error) {
    console.warn('Failed to record magic prompt usage:', error.message);
  }
}

/**
 * Record a user feedback event.
 * @param {string} appId
 * @param {number|string} rating - numeric 1-5 or legacy 'positive' / 'negative'
 */
export function recordFeedbackEvent(appId, rating) {
  if (!feedbackCounter) return;
  try {
    let label = 'unknown';
    let numeric = null;
    if (typeof rating === 'number' && Number.isFinite(rating)) {
      numeric = Math.max(1, Math.min(5, Math.ceil(rating)));
      label = String(numeric);
    } else if (rating === 'positive') {
      numeric = 5;
      label = 'positive';
    } else if (rating === 'negative') {
      numeric = 1;
      label = 'negative';
    }
    const labels = filterMetricLabels({ 'app.id': appId, 'feedback.rating': label });
    feedbackCounter.add(1, labels);
    if (numeric !== null && feedbackRatingHistogram) {
      feedbackRatingHistogram.record(numeric, filterMetricLabels({ 'app.id': appId }));
    }
  } catch (error) {
    console.warn('Failed to record feedback event:', error.message);
  }
}
