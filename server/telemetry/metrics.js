// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * OpenTelemetry Gen-AI Metrics Recording
 * Implements the client inference metrics of the OpenTelemetry GenAI semantic
 * conventions (semantic-conventions-genai v0.1.0):
 * https://github.com/open-telemetry/semantic-conventions-genai/blob/main/docs/gen-ai/client-inference.md
 */

import logger from '../utils/logger.js';
import { errorTypeOf } from './spans.js';
import { SURFACES } from '../services/usage/callRecord.js';
import { CLIENT_CHANNELS } from './channel.js';

// Spec buckets for the per-inference token histograms (in tokens)
const TOKEN_USAGE_BUCKETS = [
  1, 4, 16, 64, 256, 1024, 4096, 16384, 65536, 262144, 1048576, 4194304, 16777216, 67108864
];

// Spec buckets for gen_ai.client.inference.duration and
// gen_ai.client.inference.time_to_first_chunk (in seconds)
const INFERENCE_DURATION_BUCKETS = [0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10, 30, 60];

// Histogram buckets for iHub's own operation durations (in seconds)
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
  'gen_ai.token.modality',
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
  'structured_output.source',
  // where an answer came from (#3668): small closed sets, never tool ids
  'tool.origin',
  'tool.outcome',
  'answer.kinds_bucket',
  'source.provider',
  'source.action',
  // telemetry self-monitoring (#4008): closed sets
  'telemetry.signal',
  'telemetry.provider',
  'telemetry.enabled',
  'service.version',
  // operations and product (#4008 P2): closed sets, mapped to `other` outside them
  'ihub.surface',
  'ihub.client.channel',
  'ihub.turn.outcome',
  'tool.name',
  'ihub.workflow.outcome',
  'ihub.workflow.node.type',
  'server.address',
  'ihub.dependency.kind',
  'ihub.storage.mount',
  'clusterbus.operation',
  'security.event'
]);

/** The label keys metrics may carry (tests and docs read it). */
export const METRIC_LABEL_KEYS = Object.freeze([...ALLOWED_METRIC_LABELS]);

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

let inputTokensHistogram = null;
let outputTokensHistogram = null;
/** `gen_ai.client.inference.usage.*` counters, keyed by the usage field they count. */
let tokenUsageCounters = null;
let inferenceDurationHistogram = null;
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

// Where an answer came from (#3668)
let toolCallsCounter = null;
let originMismatchCounter = null;
let answerBasisCounter = null;
let sourceActionsCounter = null;

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

// Telemetry self-monitoring (#4008)
let telemetryExportFailuresCounter = null;
let telemetryLastSuccessGauge = null;
let buildInfoGauge = null;
let pendingTelemetryStatusProvider = null;

// Operations and product (#4008 P2)
let timeToFirstChunkHistogram = null;
let turnDurationHistogram = null;
let turnsCounter = null;
let toolDurationHistogram = null;
let workflowExecutionsCounter = null;
let workflowDurationHistogram = null;
let workflowNodeDurationHistogram = null;
let hitlWaitHistogram = null;
let llmInflightCounter = null;
let llmQueuedCounter = null;
let outboundDurationHistogram = null;
let outboundTlsErrorsCounter = null;
let dependencyUpGauge = null;
let filesystemUsageGauge = null;
let filesystemLimitGauge = null;
let lockWaitHistogram = null;
let clusterBusTimeoutsCounter = null;
let securityEventsCounter = null;
let pendingFilesystemProvider = null;

/**
 * Initialize metrics from a meter source. Accepts anything with a
 * `getMeter(name, version)` method - either the global metrics API
 * (@opentelemetry/api `metrics`) or a MeterProvider instance.
 * @param {Object} meterSource - Meter source with `getMeter(name, version)`
 */
export function initializeMetrics(meterSource) {
  if (!meterSource || typeof meterSource.getMeter !== 'function') return;

  const meter = meterSource.getMeter('ihub-apps-genai', '1.0.0');

  // Per-inference token distribution: one record per inference, failed ones included
  inputTokensHistogram = meter.createHistogram('gen_ai.client.inference.operation.input_tokens', {
    description: 'The number of input (prompt) tokens used per inference operation',
    unit: '{token}',
    advice: { explicitBucketBoundaries: TOKEN_USAGE_BUCKETS }
  });
  outputTokensHistogram = meter.createHistogram('gen_ai.client.inference.operation.output_tokens', {
    description: 'The number of output (completion) tokens used per inference operation',
    unit: '{token}',
    advice: { explicitBucketBoundaries: TOKEN_USAGE_BUCKETS }
  });

  // Token consumption: the counters to sum for totals and cost
  tokenUsageCounters = {};
  for (const [field, name, description] of TOKEN_USAGE_COUNTERS) {
    tokenUsageCounters[field] = meter.createCounter(name, { description, unit: '{token}' });
  }

  inferenceDurationHistogram = meter.createHistogram('gen_ai.client.inference.duration', {
    description: 'GenAI client inference operation duration',
    unit: 's',
    advice: { explicitBucketBoundaries: INFERENCE_DURATION_BUCKETS }
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

  toolCallsCounter = meter.createCounter('ihub.tool.calls', {
    description: 'Search and fetch calls by where they looked and what they came to',
    unit: '{call}'
  });

  originMismatchCounter = meter.createCounter('ihub.answer.origin.mismatch', {
    description: 'Answers whose sources name an origin that the answer basis leaves out',
    unit: '{answer}'
  });

  answerBasisCounter = meter.createCounter('ihub.answer.basis', {
    description: 'Answers by how many kinds of source their basis names',
    unit: '{answer}'
  });

  sourceActionsCounter = meter.createCounter('ihub.source.actions', {
    description: 'Opens of a source document or its details through its integration',
    unit: '{action}'
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

  telemetryExportFailuresCounter = meter.createCounter('ihub.telemetry.export.failures', {
    description:
      'Telemetry exports that failed, by signal and reason (per process: sum across workers)',
    unit: '{export}'
  });
  telemetryLastSuccessGauge = meter.createObservableGauge('ihub.telemetry.export.last_success', {
    description:
      'Time of the last successful telemetry export per signal, seconds since the epoch (per process: max across workers)',
    unit: 's'
  });
  buildInfoGauge = meter.createObservableGauge('ihub.build.info', {
    description: 'Always 1; the labels say which version runs and how telemetry is set up',
    unit: '1'
  });

  initializeOperationsInstruments(meter);

  attachIndexCacheObservers();
  attachTelemetryStatusObservers();
  attachFilesystemObservers();

  logger.info('Telemetry metrics initialized', {
    component: 'Telemetry',
    allowedLabels: [...ALLOWED_METRIC_LABELS]
  });
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
      logger.warn('Failed to observe active users', {
        component: 'Telemetry',
        error: error.message
      });
    }
  });

  activeChatsGauge.addCallback(observableResult => {
    try {
      const value = provider.getActiveChats() || 0;
      observableResult.observe(value, resolveAttrs());
    } catch (error) {
      logger.warn('Failed to observe active chats', {
        component: 'Telemetry',
        error: error.message
      });
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
      logger.warn('Failed to observe active projects', {
        component: 'Telemetry',
        error: error.message
      });
    }
  });
  projectsActiveCharsGauge.addCallback(result => {
    try {
      for (const w of provider.getWorkingSet()) {
        result.observe(w.chars, { 'window.minutes': w.minutes });
      }
    } catch (error) {
      logger.warn('Failed to observe active project characters', {
        component: 'Telemetry',
        error: error.message
      });
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
 * `[usage field, counter name, description, per-modality]` of the
 * `gen_ai.client.inference.usage.*` counters. The cache and reasoning counters
 * count subsets of the input and output counters.
 */
const TOKEN_USAGE_COUNTERS = [
  [
    'inputTokens',
    'gen_ai.client.inference.usage.input_tokens',
    'The number of input (prompt) tokens used, including cached tokens',
    true
  ],
  [
    'outputTokens',
    'gen_ai.client.inference.usage.output_tokens',
    'The number of output (completion) tokens used, including reasoning tokens',
    true
  ],
  [
    'cacheReadTokens',
    'gen_ai.client.inference.usage.cache_read.input_tokens',
    'The number of input tokens served from a provider-managed cache',
    true
  ],
  [
    'cacheWriteTokens',
    'gen_ai.client.inference.usage.cache_write.input_tokens',
    'The number of input tokens written to a provider-managed cache',
    true
  ],
  [
    'reasoningTokens',
    'gen_ai.client.inference.usage.reasoning.output_tokens',
    'The number of output tokens used for reasoning',
    false
  ]
];

/** @returns {number|undefined} A finite, non-negative token count, else undefined. */
function tokenCount(value) {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : undefined;
}

/**
 * Record the tokens of one inference operation.
 *
 * - `gen_ai.client.inference.operation.input_tokens` / `.output_tokens`: one
 *   record each per inference, failed ones included; `0` when the provider
 *   reported no usage. A failure carries `error.type`.
 * - `gen_ai.client.inference.usage.*` counters: only known, strictly positive
 *   counts. The providers do not report the modality of their tokens, so it is
 *   `unknown` (the reasoning counter has no modality).
 *
 * @param {Object} attributes - The call's metric labels; never `span.attributes`
 * @param {Object} [usage] - inputTokens, outputTokens, cacheReadTokens, cacheWriteTokens,
 *   reasoningTokens (or the OpenAI `prompt_tokens` / `completion_tokens`)
 * @param {unknown} [error] - The failure, mapped to `error.type` by `errorTypeOf`
 */
export function recordInferenceTokens(attributes, usage, error = null) {
  if (!inputTokensHistogram) return;

  try {
    // Filter to the low-cardinality allow-list: an unbounded key (a
    // conversation id, a token count) belongs on the span, never on a series.
    const baseAttrs = filterMetricLabels(attributes);
    const errorType = errorTypeOf(error);
    if (errorType) baseAttrs['error.type'] = errorType;

    const counts = {
      ...usage,
      inputTokens: tokenCount(usage?.inputTokens ?? usage?.prompt_tokens),
      outputTokens: tokenCount(usage?.outputTokens ?? usage?.completion_tokens)
    };

    inputTokensHistogram.record(counts.inputTokens ?? 0, baseAttrs);
    outputTokensHistogram.record(counts.outputTokens ?? 0, baseAttrs);

    for (const [field, , , perModality] of TOKEN_USAGE_COUNTERS) {
      const value = tokenCount(counts[field]);
      if (!value) continue;
      tokenUsageCounters[field].add(
        value,
        perModality ? { ...baseAttrs, 'gen_ai.token.modality': 'unknown' } : baseAttrs
      );
    }
  } catch (err) {
    logger.warn('Failed to record token usage', { component: 'Telemetry', error: err.message });
  }
}

/**
 * Record `gen_ai.client.inference.duration`.
 * @param {number} durationSeconds - Duration in seconds
 * @param {Object} attributes - The call's metric labels (operation, provider, model, app);
 *   never `span.attributes`, which a sampled-out span does not have
 * @param {unknown} [error] - The failure, mapped to `error.type` by `errorTypeOf`
 */
export function recordInferenceDuration(durationSeconds, attributes, error = null) {
  if (!inferenceDurationHistogram) return;

  try {
    // Same allow-list as recordInferenceTokens: only low-cardinality labels.
    const metricAttributes = filterMetricLabels(attributes);

    // A failed call carries its `error.type` (a closed code, never the message).
    const errorType = errorTypeOf(error);
    if (errorType) metricAttributes['error.type'] = errorType;

    inferenceDurationHistogram.record(durationSeconds, metricAttributes);
  } catch (err) {
    logger.warn('Failed to record inference duration', {
      component: 'Telemetry',
      error: err.message
    });
  }
}

/**
 * Record app usage metric. user.id is intentionally NOT a label - in a
 * deployment with many users it explodes Prometheus cardinality. Per-user
 * lookups belong in usage records, and a span names a user only through
 * `telemetry/identity.js` (pseudonymised by default); the counter only carries app.id and the
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
    logger.warn('Failed to record app usage', { component: 'Telemetry', error: error.message });
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
    logger.warn('Failed to record error metric', { component: 'Telemetry', error: error.message });
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
    logger.warn('Failed to record conversation metric', {
      component: 'Telemetry',
      error: error.message
    });
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
    authEventCounter.add(
      1,
      filterMetricLabels({
        'auth.provider': inSet(provider, AUTH_PROVIDERS),
        'auth.event': inSet(event, AUTH_EVENTS)
      })
    );
  } catch (error) {
    logger.warn('Failed to record auth event', { component: 'Telemetry', error: error.message });
  }
}

/** The auth providers and events `ihub.auth.events` knows; anything else is `other`. */
const AUTH_PROVIDERS = new Set([
  'local',
  'ldap',
  'oidc',
  'ntlm',
  'proxy',
  'teams',
  'jwt',
  'oauth',
  'anonymous',
  'unknown'
]);
const AUTH_EVENTS = new Set([
  'login_success',
  'login_failure',
  'logout',
  'token_validated',
  'token_invalid',
  'token_expired',
  'embed_login_success'
]);

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
    logger.warn('Failed to record rate limit hit', {
      component: 'Telemetry',
      error: error.message
    });
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
    logger.warn('Failed to record stream outcome', {
      component: 'Telemetry',
      error: error.message
    });
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
    logger.warn('Failed to record structured output validation', {
      component: 'Telemetry',
      error: error.message
    });
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
    logger.warn('Failed to record upload', { component: 'Telemetry', error: error.message });
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
      logger.warn('Failed to record config reload', { component: 'Telemetry', error: err.message });
    }
  }
  if (configReloadDurationHistogram && typeof durationSeconds === 'number') {
    try {
      configReloadDurationHistogram.record(durationSeconds, labels);
    } catch (err) {
      logger.warn('Failed to record config reload duration', {
        component: 'Telemetry',
        error: err.message
      });
    }
  }
}

/**
 * Record a magic-prompt invocation. Token totals already flow through the
 * gen_ai.client.inference.usage.* counters via the LLM instrumentation; this
 * counter is just for "how often is magic prompt being used per app."
 * @param {string} appId
 * @param {Object} extra
 */
export function recordMagicPromptUsage(appId, extra = {}) {
  if (!magicPromptUsageCounter) return;
  try {
    magicPromptUsageCounter.add(1, filterMetricLabels({ 'app.id': appId, ...extra }));
  } catch (error) {
    logger.warn('Failed to record magic prompt usage', {
      component: 'Telemetry',
      error: error.message
    });
  }
}

/**
 * Record a user feedback event.
 * @param {string} appId
 * @param {number} rating - numeric 1-5
 */
export function recordFeedbackEvent(appId, rating, { modelId = null } = {}) {
  if (!feedbackCounter) return;
  try {
    let label = 'unknown';
    let numeric = null;
    if (typeof rating === 'number' && Number.isFinite(rating)) {
      numeric = Math.max(1, Math.min(5, Math.ceil(rating)));
      label = String(numeric);
    }
    // The model id comes from the client: the caller passes it only when it
    // is a configured model, anything else is `other`.
    const labels = filterMetricLabels({
      'app.id': appId,
      'feedback.rating': label,
      'gen_ai.request.model': modelId ? configLabel(modelId) : 'other',
      'ihub.surface': 'chat'
    });
    feedbackCounter.add(1, labels);
    if (numeric !== null && feedbackRatingHistogram) {
      feedbackRatingHistogram.record(numeric, filterMetricLabels({ 'app.id': appId }));
    }
  } catch (error) {
    logger.warn('Failed to record feedback event', {
      component: 'Telemetry',
      error: error.message
    });
  }
}

// ---- Where an answer came from (#3668) -------------------------------------
// Every label is a member of a closed set; a value outside it is recorded as
// the neutral one, so the series count stays bounded whatever a caller passes.

const TOOL_ORIGINS = new Set([
  'project',
  'web',
  'ifinder',
  'iassistant',
  'documents',
  'integration',
  'none'
]);
const TOOL_OUTCOMES = new Set(['results', 'empty', 'error', 'unknown']);
const SOURCE_ACTIONS = new Set(['content', 'details']);
const MAX_PROVIDER_LABEL = 64;

/**
 * Record one search or fetch call: where it looked (the server's own
 * `activityOrigin`; `none` for a call it could not place, which on a built-in
 * tool is a classifier gap) and what it came to.
 * @param {string|undefined} origin - an activity origin
 * @param {'results'|'empty'|'error'|'unknown'} outcome
 */
export function recordToolCall(origin, outcome) {
  if (!toolCallsCounter) return;
  try {
    toolCallsCounter.add(
      1,
      filterMetricLabels({
        'tool.origin': TOOL_ORIGINS.has(origin) ? origin : 'none',
        'tool.outcome': TOOL_OUTCOMES.has(outcome) ? outcome : 'unknown'
      })
    );
  } catch (error) {
    logger.warn('Failed to record tool call', { component: 'Telemetry', error: error.message });
  }
}

/** Record an answer whose sources name an origin its basis leaves out (the footer and the timeline disagree). */
export function recordAnswerOriginMismatch() {
  if (!originMismatchCounter) return;
  try {
    originMismatchCounter.add(1);
  } catch (error) {
    logger.warn('Failed to record origin mismatch', {
      component: 'Telemetry',
      error: error.message
    });
  }
}

/** The bucket of an answer by its number of source kinds: `0` (none), `1`, `2`, `3+`. */
function kindsBucketOf(kinds) {
  if (!Number.isInteger(kinds) || kinds <= 0) return '0';
  if (kinds >= 3) return '3+';
  return String(kinds);
}

/**
 * Record an answer by how many kinds of source its basis names.
 * @param {number} kinds - non-model source kinds in the basis. `0` means no named
 *   source kind: the model's own knowledge, or a passthrough answer that used none.
 */
export function recordAnswerBasis(kinds) {
  if (!answerBasisCounter) return;
  try {
    answerBasisCounter.add(1, filterMetricLabels({ 'answer.kinds_bucket': kindsBucketOf(kinds) }));
  } catch (error) {
    logger.warn('Failed to record answer basis', { component: 'Telemetry', error: error.message });
  }
}

/**
 * Record that a user opened a source's content or details through its integration.
 * The server sees the document request, not which button caused it, so a
 * preview and a download are both `content`.
 * @param {string} provider - a category, never an instance id: the integration's catalog
 *   definition, the id of a built-in provider, or `unknown` (see `documentProviderCategory`).
 *   The length bound below is a last defence, not what keeps the set small.
 * @param {'content'|'details'} action
 */
export function recordSourceAction(provider, action) {
  if (!sourceActionsCounter) return;
  try {
    sourceActionsCounter.add(
      1,
      filterMetricLabels({
        'source.provider':
          typeof provider === 'string' && provider
            ? provider.slice(0, MAX_PROVIDER_LABEL)
            : 'unknown',
        'source.action': SOURCE_ACTIONS.has(action) ? action : 'content'
      })
    );
  } catch (error) {
    logger.warn('Failed to record source action', { component: 'Telemetry', error: error.message });
  }
}

/**
 * Count a failed telemetry export.
 *
 * @param {string} signal - `traces`, `metrics` or `logs`
 * @param {string} reason - From `EXPORT_FAILURE_REASONS` (`exportStatus.js`)
 */
export function recordTelemetryExportFailure(signal, reason) {
  if (!telemetryExportFailuresCounter) return;
  try {
    telemetryExportFailuresCounter.add(1, {
      'telemetry.signal': TELEMETRY_SIGNALS.has(signal) ? signal : 'unknown',
      'error.type': typeof reason === 'string' ? reason.slice(0, 32) : 'unknown'
    });
  } catch (error) {
    logger.warn('Failed to record telemetry export failure', {
      component: 'Telemetry',
      error: error.message
    });
  }
}

const TELEMETRY_SIGNALS = new Set(['traces', 'metrics', 'logs']);

/**
 * Register the sources of `ihub.telemetry.export.last_success` and
 * `ihub.build.info`. Works before or after `initializeMetrics`.
 *
 * @param {Object} provider
 * @param {() => Array<[string, number]>} provider.lastSuccess - `[signal, epochSeconds]` pairs
 * @param {() => {version: string, provider: string}} provider.buildInfo
 */
export function registerTelemetryStatusObservers(provider) {
  pendingTelemetryStatusProvider = provider;
  attachTelemetryStatusObservers();
}

function attachTelemetryStatusObservers() {
  const provider = pendingTelemetryStatusProvider;
  if (!provider || !telemetryLastSuccessGauge || !buildInfoGauge) return;
  telemetryLastSuccessGauge.addCallback(result => {
    try {
      for (const [signal, seconds] of provider.lastSuccess()) {
        result.observe(seconds, { 'telemetry.signal': signal });
      }
    } catch (error) {
      logger.warn('Failed to observe telemetry export status', {
        component: 'Telemetry',
        error: error.message
      });
    }
  });
  buildInfoGauge.addCallback(result => {
    try {
      const info = provider.buildInfo();
      result.observe(1, {
        'service.version': info.version,
        'telemetry.provider': info.provider,
        'telemetry.enabled': 'true'
      });
    } catch (error) {
      logger.warn('Failed to observe build info', { component: 'Telemetry', error: error.message });
    }
  });
}

// ---- Operations and product (#4008 P2) -------------------------------------

/** A whole turn, seconds: a short answer to several tool rounds. */
const TURN_DURATION_BUCKETS = [0.25, 0.5, 1, 2.5, 5, 10, 20, 40, 80, 160, 320, 640];

/** Waits for a human, seconds: a minute to a week. */
const HITL_WAIT_BUCKETS = [60, 300, 900, 3600, 14400, 43200, 86400, 259200, 604800];

const SURFACE_SET = new Set(SURFACES);
const CHANNEL_SET = new Set(CLIENT_CHANNELS);

/** How a turn ended, as the user saw it. */
export const TURN_OUTCOMES = Object.freeze([
  'ok',
  'error',
  'quota',
  'rate_limited',
  'aborted',
  'empty',
  'tool_degraded'
]);
const TURN_OUTCOME_SET = new Set(TURN_OUTCOMES);

const WORKFLOW_OUTCOMES = new Set(['completed', 'failed', 'cancelled', 'paused']);
const NODE_OUTCOMES = new Set(['ok', 'error']);

/** The kinds of outbound dependency. */
export const DEPENDENCY_KINDS = Object.freeze([
  'llm',
  'ifinder',
  'iassistant',
  'mcp',
  'idp',
  'search',
  'web',
  'integration',
  'smtp',
  'ocr',
  'transcription',
  'storage',
  'other'
]);
const DEPENDENCY_SET = new Set(DEPENDENCY_KINDS);

/** The volumes the filesystem gauges report (`services/systemResources.js`). */
export const STORAGE_MOUNTS = Object.freeze(['contents', 'data', 'uploads', 'logs', 'temp']);
const MOUNT_SET = new Set(STORAGE_MOUNTS);

/** Security events counted by `ihub.security.events` (the audit log has the detail). */
export const SECURITY_EVENTS = Object.freeze([
  'login_failure',
  'admin_config_change',
  'content_capture_change',
  'permission_change',
  'user_change',
  'api_key_change',
  'oauth_client_change',
  'oauth_grant',
  'oauth_revoke',
  'tool_approval_denied',
  'bulk_export',
  'share_created'
]);
const SECURITY_SET = new Set(SECURITY_EVENTS);

/** A value from `set`, else `fallback`. */
function inSet(value, set, fallback = 'other') {
  return typeof value === 'string' && set.has(value) ? value : fallback;
}

/** A label value from config (an app id, a tool id, a node type): cut to 64 characters. */
function configLabel(value, fallback = 'unknown') {
  return typeof value === 'string' && value !== '' ? value.slice(0, 64) : fallback;
}

/** Dependency kind → `{ up, at }` of its last outbound request. */
const dependencyStates = new Map();

function initializeOperationsInstruments(meter) {
  timeToFirstChunkHistogram = meter.createHistogram('gen_ai.client.inference.time_to_first_chunk', {
    description:
      'Time from the start of a logical inference operation to the first chunk in its streaming response',
    unit: 's',
    advice: { explicitBucketBoundaries: INFERENCE_DURATION_BUCKETS }
  });
  turnDurationHistogram = meter.createHistogram('ihub.turn.duration', {
    description: 'Duration of a whole turn: every model call and tool round until the answer',
    unit: 's',
    advice: { explicitBucketBoundaries: TURN_DURATION_BUCKETS }
  });
  turnsCounter = meter.createCounter('ihub.turns', {
    description: 'Turns by how they ended for the user (ihub.turn.outcome)',
    unit: '{turn}'
  });
  toolDurationHistogram = meter.createHistogram('ihub.tool.duration', {
    description: 'Duration of a tool call in the agent loop',
    unit: 's',
    advice: { explicitBucketBoundaries: OPERATION_DURATION_BUCKETS }
  });
  workflowExecutionsCounter = meter.createCounter('ihub.workflow.executions', {
    description: 'Workflow execution segments by how they ended (paused = waits for a human)',
    unit: '{execution}'
  });
  workflowDurationHistogram = meter.createHistogram('ihub.workflow.duration', {
    description: 'Duration of a workflow execution segment',
    unit: 's',
    advice: { explicitBucketBoundaries: TURN_DURATION_BUCKETS }
  });
  workflowNodeDurationHistogram = meter.createHistogram('ihub.workflow.node.duration', {
    description: 'Duration of one workflow node attempt',
    unit: 's',
    advice: { explicitBucketBoundaries: OPERATION_DURATION_BUCKETS }
  });
  hitlWaitHistogram = meter.createHistogram('ihub.hitl.wait.duration', {
    description: 'Time a workflow waited for a human decision before it resumed',
    unit: 's',
    advice: { explicitBucketBoundaries: HITL_WAIT_BUCKETS }
  });
  llmInflightCounter = meter.createUpDownCounter('ihub.llm.requests.inflight', {
    description: 'Model calls in progress (per process: sum across workers)',
    unit: '{request}'
  });
  llmQueuedCounter = meter.createUpDownCounter('ihub.llm.requests.queued', {
    description:
      'Model calls waiting for a concurrency slot of their model (per process: sum across workers)',
    unit: '{request}'
  });
  outboundDurationHistogram = meter.createHistogram('ihub.outbound.request.duration', {
    description: 'Outbound HTTP requests through httpFetch, until the response headers',
    unit: 's',
    advice: { explicitBucketBoundaries: OPERATION_DURATION_BUCKETS }
  });
  outboundTlsErrorsCounter = meter.createCounter('ihub.outbound.tls.errors', {
    description: 'Outbound requests that failed on the TLS handshake (certificate, protocol)',
    unit: '{request}'
  });
  dependencyUpGauge = meter.createObservableGauge('ihub.dependency.up', {
    description:
      '1 when the last outbound request to a dependency kind got a response below 500, 0 when it failed (per process: min across workers)',
    unit: '1'
  });
  dependencyUpGauge.addCallback(result => {
    for (const [kind, state] of dependencyStates) {
      result.observe(state.up ? 1 : 0, { 'ihub.dependency.kind': kind });
    }
  });
  filesystemUsageGauge = meter.createObservableGauge('ihub.storage.filesystem.usage', {
    description: 'Bytes used on the volume of a storage location (same on every worker: max)',
    unit: 'By'
  });
  filesystemLimitGauge = meter.createObservableGauge('ihub.storage.filesystem.limit', {
    description: 'Size of the volume of a storage location (same on every worker: max)',
    unit: 'By'
  });
  lockWaitHistogram = meter.createHistogram('ihub.lock.wait.duration', {
    description: 'Time spent waiting for a file lock before a write',
    unit: 's',
    advice: { explicitBucketBoundaries: SHORT_DURATION_BUCKETS }
  });
  clusterBusTimeoutsCounter = meter.createCounter('ihub.clusterbus.timeouts', {
    description: 'Cross-worker requests that got no answer in time',
    unit: '{request}'
  });
  securityEventsCounter = meter.createCounter('ihub.security.events', {
    description: 'Security-relevant events by kind; who and what is in the audit log',
    unit: '{event}'
  });
}

function safely(name, fn) {
  try {
    fn();
  } catch (error) {
    logger.warn(`Failed to record ${name}`, { component: 'Telemetry', error: error.message });
  }
}

/**
 * Record the time to the first output chunk of a streamed model call.
 *
 * @param {number} seconds
 * @param {Object} labels - The call's metric labels (operation, provider, model, surface)
 */
export function recordTimeToFirstChunk(seconds, labels) {
  if (!timeToFirstChunkHistogram || !Number.isFinite(seconds) || seconds < 0) return;
  safely('time to first chunk', () =>
    timeToFirstChunkHistogram.record(seconds, filterMetricLabels(labels))
  );
}

/**
 * Record a finished turn: `ihub.turn.duration` and `ihub.turns`.
 *
 * @param {Object} turn
 * @param {number} turn.seconds
 * @param {string} turn.outcome - One of {@link TURN_OUTCOMES}
 * @param {string} [turn.surface] - One of `SURFACES`
 * @param {string} [turn.channel] - One of `CLIENT_CHANNELS`
 * @param {string} [turn.appId]
 */
export function recordTurn({ seconds, outcome, surface, channel, appId }) {
  if (!turnsCounter) return;
  const labels = {
    'ihub.surface': inSet(surface, SURFACE_SET, 'system'),
    'ihub.client.channel': inSet(channel, CHANNEL_SET, 'system'),
    'ihub.turn.outcome': inSet(outcome, TURN_OUTCOME_SET, 'error'),
    ...(appId ? { 'app.id': configLabel(appId) } : {})
  };
  safely('turn', () => {
    turnsCounter.add(1, labels);
    if (Number.isFinite(seconds) && seconds >= 0) turnDurationHistogram.record(seconds, labels);
  });
}

/**
 * Record one tool call's duration.
 *
 * @param {Object} call
 * @param {number} call.seconds
 * @param {string} call.toolName - Bounded: a configured tool id, `mcp`, `a2a` or `unknown`
 * @param {string} [call.origin] - `web`, `project`, …
 * @param {string} [call.outcome] - `results`, `empty`, `error`, `unknown`
 */
export function recordToolDuration({ seconds, toolName, origin, outcome }) {
  if (!toolDurationHistogram || !Number.isFinite(seconds)) return;
  safely('tool duration', () =>
    toolDurationHistogram.record(seconds, {
      'tool.name': configLabel(toolName),
      'tool.origin': inSet(origin, TOOL_ORIGINS, 'none'),
      'tool.outcome': inSet(outcome, TOOL_OUTCOMES, 'unknown')
    })
  );
}

/**
 * Record a workflow execution segment that ended (or paused).
 *
 * @param {string} outcome - `completed`, `failed`, `cancelled`, `paused`
 * @param {number} seconds
 */
export function recordWorkflowExecution(outcome, seconds) {
  if (!workflowExecutionsCounter) return;
  const labels = { 'ihub.workflow.outcome': inSet(outcome, WORKFLOW_OUTCOMES) };
  safely('workflow execution', () => {
    workflowExecutionsCounter.add(1, labels);
    if (Number.isFinite(seconds) && seconds >= 0) workflowDurationHistogram.record(seconds, labels);
  });
}

/**
 * Record one workflow node attempt.
 *
 * @param {string} nodeType - From the node registry
 * @param {number} seconds
 * @param {boolean} ok
 */
export function recordWorkflowNode(nodeType, seconds, ok) {
  if (!workflowNodeDurationHistogram || !Number.isFinite(seconds)) return;
  safely('workflow node', () =>
    workflowNodeDurationHistogram.record(seconds, {
      'ihub.workflow.node.type': configLabel(nodeType),
      'ihub.workflow.outcome': inSet(ok ? 'ok' : 'error', NODE_OUTCOMES)
    })
  );
}

/**
 * Record how long a workflow waited for a human decision.
 *
 * @param {number} seconds
 */
export function recordHitlWait(seconds) {
  if (!hitlWaitHistogram || !Number.isFinite(seconds) || seconds < 0) return;
  safely('human-in-the-loop wait', () => hitlWaitHistogram.record(seconds));
}

/**
 * A model call started (+1) or ended (-1).
 *
 * @param {number} delta
 * @param {string} provider - `gen_ai.provider.name`
 */
export function recordLlmInflight(delta, provider) {
  if (!llmInflightCounter) return;
  safely('in-flight model calls', () =>
    llmInflightCounter.add(delta, { 'gen_ai.provider.name': configLabel(provider) })
  );
}

/**
 * A model call started (+1) or stopped (-1) waiting for a concurrency slot.
 *
 * @param {number} delta
 * @param {string} modelId - The throttled model's id (from config)
 */
export function recordLlmQueued(delta, modelId) {
  if (!llmQueuedCounter) return;
  safely('queued model calls', () =>
    llmQueuedCounter.add(delta, { 'gen_ai.request.model': configLabel(modelId) })
  );
}

/**
 * Record one outbound HTTP request: duration with `error.type`, TLS failures,
 * and the dependency's up state.
 *
 * @param {Object} request
 * @param {string} [request.kind] - One of {@link DEPENDENCY_KINDS}
 * @param {number} request.seconds
 * @param {number} [request.status] - HTTP status, when a response came
 * @param {string} [request.errorType] - Closed network error class, when it failed
 * @param {boolean} [request.tls] - The failure was a TLS one
 */
export function recordOutboundRequest({ kind, seconds, status, errorType, tls = false }) {
  const dependency = inSet(kind, DEPENDENCY_SET);
  const up = !errorType && Number.isInteger(status) && status < 500;
  dependencyStates.set(dependency, { up, at: Date.now() });
  if (!outboundDurationHistogram) return;
  safely('outbound request', () => {
    const failure =
      errorType || (Number.isInteger(status) && status >= 400 ? `http_${status}` : undefined);
    outboundDurationHistogram.record(seconds, {
      'ihub.dependency.kind': dependency,
      ...(failure ? { 'error.type': failure.slice(0, 32) } : {})
    });
    if (tls) {
      outboundTlsErrorsCounter.add(1, {
        'ihub.dependency.kind': dependency,
        'error.type': (errorType || 'tls').slice(0, 32)
      });
    }
  });
}

/**
 * Register the source of the filesystem gauges: a synchronous function that
 * returns the last measured volumes (`[{ mount, used, total }]`).
 *
 * @param {() => Array<{mount: string, used: number, total: number}>} provider
 */
export function registerFilesystemObservers(provider) {
  pendingFilesystemProvider = provider;
  attachFilesystemObservers();
}

function attachFilesystemObservers() {
  const provider = pendingFilesystemProvider;
  if (!provider || !filesystemUsageGauge || !filesystemLimitGauge) return;
  const observe = (gauge, field) =>
    gauge.addCallback(result => {
      try {
        for (const volume of provider() || []) {
          if (!MOUNT_SET.has(volume.mount) || !Number.isFinite(volume[field])) continue;
          result.observe(volume[field], { 'ihub.storage.mount': volume.mount });
        }
      } catch (error) {
        logger.warn('Failed to observe filesystem usage', {
          component: 'Telemetry',
          error: error.message
        });
      }
    });
  observe(filesystemUsageGauge, 'used');
  observe(filesystemLimitGauge, 'total');
}

/**
 * Record the wait for a file lock.
 *
 * @param {number} seconds
 */
export function recordLockWait(seconds) {
  if (!lockWaitHistogram || !Number.isFinite(seconds) || seconds < 0) return;
  safely('lock wait', () => lockWaitHistogram.record(seconds));
}

/**
 * Record a cross-worker request that got no answer in time.
 *
 * @param {'request'|'gather'} operation
 */
export function recordClusterBusTimeout(operation) {
  if (!clusterBusTimeoutsCounter) return;
  safely('cluster bus timeout', () =>
    clusterBusTimeoutsCounter.add(1, {
      'clusterbus.operation': operation === 'gather' ? 'gather' : 'request'
    })
  );
}

/**
 * Count a security event. Who and what goes to the audit log, never here.
 *
 * @param {string} event - One of {@link SECURITY_EVENTS}
 */
export function recordSecurityEvent(event) {
  if (!securityEventsCounter || !SECURITY_SET.has(event)) return;
  safely('security event', () => securityEventsCounter.add(1, { 'security.event': event }));
}

/** Forget the dependency states (tests only). */
export function resetDependencyStatesForTests() {
  dependencyStates.clear();
}
