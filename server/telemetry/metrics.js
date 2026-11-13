// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

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
  'feedback.rating',
  'structured_output.outcome',
  'structured_output.source'
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

// Index builds and extractions run from milliseconds to tens of seconds (a 10 MB text
// takes about a second to index, a large PDF several to extract).
const WORK_DURATION_BUCKETS = [0.005, 0.025, 0.1, 0.25, 0.5, 1, 2.5, 5, 10, 30, 60, 120];

// Histogram bucket boundaries for short-lived sub-second operations (config reload,
// auth events, etc.) - similar to standard HTTP request duration buckets.
const SHORT_DURATION_BUCKETS = [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10];

let tokenUsageHistogram = null;
let operationDurationHistogram = null;
let appUsageCounter = null;
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
let configReloadCounter = null;
let configReloadDurationHistogram = null;
let magicPromptUsageCounter = null;
let feedbackCounter = null;
let feedbackRatingHistogram = null;
let structuredOutputCounter = null;

// Project working set, knowledge index cache and extraction (#3652)
let projectsActiveGauge = null;
let projectsActiveCharsGauge = null;
let indexCacheHitsCounter = null;
let indexCacheMissesCounter = null;
let indexCacheEvictionsCounter = null;
let indexCacheEntriesGauge = null;
let indexCacheCharsGauge = null;
let indexBuildDurationHistogram = null;
let extractionDurationHistogram = null;
let extractionQueueHistogram = null;
let pendingIndexCacheProvider = null;

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

  structuredOutputCounter = meter.createCounter('ihub.structured_output.validation', {
    description: 'Server-side structured-output validations by outcome',
    unit: '{validation}'
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

  // ---- Project working set, index cache, extraction (#3652) ----

  projectsActiveGauge = meter.createObservableGauge('ihub.projects.active', {
    description:
      'Distinct projects used by a chat turn or a knowledge tool in the window (union across workers)',
    unit: '{project}'
  });

  projectsActiveCharsGauge = meter.createObservableGauge('ihub.projects.active.chars', {
    description:
      'Text characters of the active projects: the index memory the working set needs (about 4.5 bytes each)',
    unit: '{character}'
  });

  indexCacheHitsCounter = meter.createCounter('ihub.knowledge.index.cache.hits', {
    description: 'Knowledge search-index cache hits (per process)',
    unit: '{lookup}'
  });

  indexCacheMissesCounter = meter.createCounter('ihub.knowledge.index.cache.misses', {
    description: 'Knowledge search-index cache misses, each one an index build (per process)',
    unit: '{lookup}'
  });

  indexCacheEvictionsCounter = meter.createCounter('ihub.knowledge.index.cache.evictions', {
    description: 'Knowledge search indexes dropped to stay within the cache limits (per process)',
    unit: '{index}'
  });

  indexCacheEntriesGauge = meter.createObservableGauge('ihub.knowledge.index.cache.entries', {
    description: 'Knowledge search indexes currently cached (per process)',
    unit: '{index}'
  });

  indexCacheCharsGauge = meter.createObservableGauge('ihub.knowledge.index.cache.chars', {
    description: 'Characters the cached knowledge search indexes stand for (per process)',
    unit: '{character}'
  });

  indexBuildDurationHistogram = meter.createHistogram('ihub.knowledge.index.build.duration', {
    description: 'Time to build a knowledge search index (blocks the event loop)',
    unit: 's',
    advice: { explicitBucketBoundaries: WORK_DURATION_BUCKETS }
  });

  extractionDurationHistogram = meter.createHistogram('ihub.extraction.duration', {
    description: 'Time to extract the text of a file, by format',
    unit: 's',
    advice: { explicitBucketBoundaries: WORK_DURATION_BUCKETS }
  });

  extractionQueueHistogram = meter.createHistogram('ihub.extraction.queue.duration', {
    description: 'Time a file waited for a free extraction thread',
    unit: 's',
    advice: { explicitBucketBoundaries: WORK_DURATION_BUCKETS }
  });

  attachIndexCacheObservers();

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
 * Register the observable callbacks for the project working-set gauges.
 *
 * @param {Object} provider
 * @param {() => Array<{minutes: number, projects: number, chars: number}>} provider.getWorkingSet
 */
export function registerProjectObservers(provider) {
  if (!projectsActiveGauge || !projectsActiveCharsGauge || !provider) return;
  projectsActiveGauge.addCallback(result => {
    try {
      for (const w of provider.getWorkingSet()) {
        result.observe(w.projects, { 'window.minutes': w.minutes });
      }
    } catch (error) {
      console.warn('Failed to observe active projects:', error.message);
    }
  });
  projectsActiveCharsGauge.addCallback(result => {
    try {
      for (const w of provider.getWorkingSet()) {
        result.observe(w.chars, { 'window.minutes': w.minutes });
      }
    } catch (error) {
      console.warn('Failed to observe active project characters:', error.message);
    }
  });
}

/**
 * Register the observable callbacks for the index-cache size gauges.
 *
 * @param {Object} provider
 * @param {() => {entries: number, chars: number}} provider.getStats
 */
export function registerIndexCacheObservers(provider) {
  if (!provider) return;
  // The cache module is loaded before telemetry is initialised: keep the
  // provider and attach it as soon as the gauges exist.
  pendingIndexCacheProvider = provider;
  attachIndexCacheObservers();
}

function attachIndexCacheObservers() {
  const provider = pendingIndexCacheProvider;
  if (!provider || !indexCacheEntriesGauge || !indexCacheCharsGauge) return;
  pendingIndexCacheProvider = null;
  indexCacheEntriesGauge.addCallback(result => result.observe(provider.getStats().entries));
  indexCacheCharsGauge.addCallback(result => result.observe(provider.getStats().chars));
}

/**
 * Count an index-cache lookup or eviction.
 * @param {'hit'|'miss'|'eviction'} outcome
 * @param {number} [count=1]
 */
export function recordIndexCacheEvent(outcome, count = 1) {
  const counters = {
    hit: indexCacheHitsCounter,
    miss: indexCacheMissesCounter,
    eviction: indexCacheEvictionsCounter
  };
  const counter = counters[outcome];
  if (counter && count > 0) counter.add(count);
}

/** @param {number} durationSeconds */
export function recordIndexBuildDuration(durationSeconds) {
  if (indexBuildDurationHistogram && Number.isFinite(durationSeconds)) {
    indexBuildDurationHistogram.record(durationSeconds);
  }
}

/**
 * @param {string} format - Short, bounded format name (`pdf`, `docx`, `text`, ...)
 * @param {number} durationSeconds
 */
export function recordExtractionDuration(format, durationSeconds) {
  if (extractionDurationHistogram && Number.isFinite(durationSeconds)) {
    extractionDurationHistogram.record(durationSeconds, { format });
  }
}

/**
 * Record the time a file waited for a free extraction thread (#3649).
 * @param {number} waitSeconds
 */
export function recordExtractionQueueWait(waitSeconds) {
  if (extractionQueueHistogram && Number.isFinite(waitSeconds)) {
    extractionQueueHistogram.record(waitSeconds);
  }
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
 * Record the outcome of a server-side structured-output validation.
 * @param {string} outcome - 'valid' | 'valid_after_retry' | 'invalid' | 'skipped'
 * @param {Object} extra - additional dimensions filtered through the allow-list
 *   (`structured_output.source`: 'app' | 'request', `app.id`, `gen_ai.request.model`)
 */
export function recordStructuredOutputValidation(outcome, extra = {}) {
  if (!structuredOutputCounter) return;
  try {
    structuredOutputCounter.add(
      1,
      filterMetricLabels({ 'structured_output.outcome': outcome, ...extra })
    );
  } catch (error) {
    console.warn('Failed to record structured output validation:', error.message);
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
 * @param {number} rating - numeric 1-5
 */
export function recordFeedbackEvent(appId, rating) {
  if (!feedbackCounter) return;
  try {
    let label = 'unknown';
    let numeric = null;
    if (typeof rating === 'number' && Number.isFinite(rating)) {
      numeric = Math.max(1, Math.min(5, Math.ceil(rating)));
      label = String(numeric);
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
