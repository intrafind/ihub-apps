import { getGenAIInstrumentation } from '../telemetry.js';
import { recordAppUsage, recordError, recordConversation } from './metrics.js';
import activityTracker from './ActivityTracker.js';

/**
 * Map provider IDs as known internally to gen-ai semantic-conventions provider names.
 */
const PROVIDER_NAME_MAP = {
  openai: 'openai',
  'openai-responses': 'openai',
  anthropic: 'anthropic',
  google: 'google',
  mistral: 'mistral_ai',
  local: 'openai', // vLLM uses OpenAI-compatible API
  vllm: 'openai',
  'iassistant-conversation': 'iassistant'
};

/**
 * Map operation names to gen-ai operation values.
 */
const OPERATION_MAP = {
  google: 'generate_content',
  default: 'chat'
};

function resolveOperation(provider) {
  return OPERATION_MAP[provider] || OPERATION_MAP.default;
}

function resolveProviderName(provider) {
  return PROVIDER_NAME_MAP[provider] || provider || 'unknown';
}

/**
 * Wraps an LLM HTTP call with OpenTelemetry instrumentation. Creates a span,
 * emits prompt / completion events when configured, records token usage and
 * operation duration metrics, and tracks app/conversation/user activity for
 * iHub-specific metrics.
 *
 * Always calls the wrapped function; if telemetry is disabled the wrapper is
 * a thin pass-through that still updates iHub counters.
 *
 * @param {Object} ctx
 * @param {Object} ctx.model - Model configuration (must include modelId, provider)
 * @param {Array}  [ctx.messages] - Prompt messages for event emission
 * @param {Object} [ctx.options] - Request options (temperature, maxTokens, ...)
 * @param {Object} [ctx.customContext] - { appId, userId, chatId, isFollowUp, messageCount, ... }
 * @param {Function} fn - Async function performing the actual LLM call. Receives the active span.
 * @returns {Promise<*>} - Result of `fn`
 */
export async function instrumentLLMCall(ctx, fn) {
  const { model, messages, options = {}, customContext = {} } = ctx;
  const provider = model?.provider;
  const providerName = resolveProviderName(provider);
  const operation = resolveOperation(provider);

  // Track activity regardless of telemetry state - the activity tracker is
  // independent of OpenTelemetry so the periodic log still works.
  activityTracker.recordActivity({
    userId: customContext.userId,
    chatId: customContext.chatId
  });

  // Update iHub counters when available
  if (customContext.appId) {
    recordAppUsage(customContext.appId, customContext.userId, {
      'model.id': model?.id,
      'model.provider': provider
    });
  }
  if (customContext.chatId !== undefined && customContext.isFollowUp !== undefined) {
    recordConversation(customContext.chatId, customContext.isFollowUp, {
      'app.id': customContext.appId,
      'model.id': model?.id,
      'message.count': customContext.messageCount
    });
  }

  const instrumentation = getGenAIInstrumentation();
  if (!instrumentation || !instrumentation.isEnabled()) {
    try {
      return await fn(null);
    } catch (err) {
      if (customContext.appId) {
        recordError(err.name || 'Error', 'llm_call', {
          'app.id': customContext.appId,
          'model.id': model?.id,
          provider: provider
        });
      }
      throw err;
    }
  }

  const span = instrumentation.createLLMSpan(operation, model, providerName, customContext);
  const startTime = Date.now();
  try {
    instrumentation.recordRequest(span, model, messages || [], options);
    const result = await fn(span);
    const duration = (Date.now() - startTime) / 1000;
    instrumentation.recordResponse(span, result || {}, result?.usage);
    instrumentation.endSpan(span, null, duration);
    return result;
  } catch (err) {
    const duration = (Date.now() - startTime) / 1000;
    instrumentation.endSpan(span, err, duration);
    if (customContext.appId) {
      recordError(err.name || 'Error', 'llm_call', {
        'app.id': customContext.appId,
        'model.id': model?.id,
        provider: provider
      });
    }
    throw err;
  }
}
