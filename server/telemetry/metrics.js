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

let tokenUsageHistogram = null;
let operationDurationHistogram = null;
let appUsageCounter = null;
let promptUsageCounter = null;
let errorCounter = null;
let conversationCounter = null;

/**
 * Initialize metrics with meter provider
 * @param {Object} meterProvider - OpenTelemetry meter provider
 */
export function initializeMetrics(meterProvider) {
  if (!meterProvider) return;

  const meter = meterProvider.getMeter('ihub-apps-genai', '1.0.0');

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

  console.info('GenAI metrics initialized successfully');
}

/**
 * Record token usage metrics
 * @param {Object} attributes - Span attributes (includes provider, model, etc.)
 * @param {Object} usage - Usage object with token counts
 */
export function recordTokenUsage(attributes, usage) {
  if (!tokenUsageHistogram || !usage) return;

  try {
    // Record input tokens
    if (usage.inputTokens !== undefined || usage.prompt_tokens !== undefined) {
      const inputTokens = usage.inputTokens || usage.prompt_tokens;
      tokenUsageHistogram.record(inputTokens, {
        ...attributes,
        'gen_ai.token.type': 'input'
      });
    }

    // Record output tokens
    if (usage.outputTokens !== undefined || usage.completion_tokens !== undefined) {
      const outputTokens = usage.outputTokens || usage.completion_tokens;
      tokenUsageHistogram.record(outputTokens, {
        ...attributes,
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
    const metricAttributes = { ...attributes };

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
 * Record app usage metric
 * @param {string} appId - Application ID
 * @param {string} userId - User ID (optional)
 * @param {Object} additionalAttributes - Additional attributes
 */
export function recordAppUsage(appId, userId = null, additionalAttributes = {}) {
  if (!appUsageCounter) return;

  try {
    const attributes = {
      'app.id': appId,
      ...additionalAttributes
    };

    if (userId) {
      attributes['user.id'] = userId;
    }

    appUsageCounter.add(1, attributes);
  } catch (error) {
    console.warn('Failed to record app usage:', error.message);
  }
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
    const attributes = {
      'error.type': errorType,
      'error.context': context,
      ...additionalAttributes
    };

    errorCounter.add(1, attributes);
  } catch (error) {
    console.warn('Failed to record error metric:', error.message);
  }
}

/**
 * Record conversation metric
 * @param {string} conversationId - Conversation/chat ID
 * @param {boolean} isFollowUp - Whether this is a follow-up message
 * @param {Object} additionalAttributes - Additional attributes
 */
export function recordConversation(conversationId, isFollowUp = false, additionalAttributes = {}) {
  if (!conversationCounter) return;

  try {
    const attributes = {
      'conversation.id': conversationId,
      'conversation.is_follow_up': isFollowUp,
      ...additionalAttributes
    };

    conversationCounter.add(1, attributes);
  } catch (error) {
    console.warn('Failed to record conversation metric:', error.message);
  }
}
