// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * OpenTelemetry Gen-AI Semantic Convention Attributes
 * Implements https://opentelemetry.io/docs/specs/semconv/gen-ai/
 */

// Operation name mappings
const OPERATION_MAP = {
  chat: 'chat',
  completion: 'text_completion',
  generate_content: 'generate_content',
  embeddings: 'embeddings'
};

/**
 * Build provider-specific attributes
 * @param {string} provider - `gen_ai.provider.name`, as `resolveProviderName()` returns it
 * @returns {Object} Provider attributes
 */
export function buildProviderAttributes(provider) {
  // Already resolved to the semconv value by `providerMap.js`.
  return {
    'gen_ai.provider.name': provider || 'unknown'
  };
}

/**
 * Build operation attributes
 * @param {string} operation - Operation type (chat, completion, etc.)
 * @returns {Object} Operation attributes
 */
export function buildOperationAttributes(operation) {
  const normalizedOp = operation?.toLowerCase() || 'chat';
  return {
    'gen_ai.operation.name': OPERATION_MAP[normalizedOp] || normalizedOp
  };
}

/**
 * Build request attributes from model and options
 * @param {Object} model - Model configuration
 * @param {Object} options - Request options
 * @returns {Object} Request attributes
 */
export function buildRequestAttributes(model, options = {}) {
  const attributes = {};

  // Required and conditionally required attributes
  if (model?.modelId) {
    attributes['gen_ai.request.model'] = model.modelId;
  }

  // Recommended attributes
  if (options.temperature !== undefined) {
    attributes['gen_ai.request.temperature'] = Number.parseFloat(options.temperature);
  }

  if (options.maxTokens !== undefined) {
    attributes['gen_ai.request.max_tokens'] = Number.parseInt(options.maxTokens, 10);
  }

  if (options.topP !== undefined) {
    attributes['gen_ai.request.top_p'] = Number.parseFloat(options.topP);
  }

  if (options.topK !== undefined) {
    attributes['gen_ai.request.top_k'] = Number.parseFloat(options.topK);
  }

  if (options.frequencyPenalty !== undefined) {
    attributes['gen_ai.request.frequency_penalty'] = Number.parseFloat(options.frequencyPenalty);
  }

  if (options.presencePenalty !== undefined) {
    attributes['gen_ai.request.presence_penalty'] = Number.parseFloat(options.presencePenalty);
  }

  if (options.stopSequences && Array.isArray(options.stopSequences)) {
    attributes['gen_ai.request.stop_sequences'] = options.stopSequences;
  }

  if (options.seed !== undefined) {
    attributes['gen_ai.request.seed'] = Number.parseInt(options.seed, 10);
  }

  if (options.choiceCount !== undefined && options.choiceCount !== 1) {
    attributes['gen_ai.request.choice.count'] = Number.parseInt(options.choiceCount, 10);
  }

  // Output type
  if (options.responseFormat) {
    const formatMap = {
      json: 'json',
      text: 'text',
      markdown: 'text'
    };
    attributes['gen_ai.output.type'] = formatMap[options.responseFormat] || 'text';
  }

  return attributes;
}

/**
 * Build response attributes from API response
 * @param {Object} response - API response object
 * @returns {Object} Response attributes
 */
export function buildResponseAttributes(response = {}) {
  const attributes = {};

  // Response ID
  if (response.id) {
    attributes['gen_ai.response.id'] = response.id;
  }

  // Response model (actual model used)
  if (response.model) {
    attributes['gen_ai.response.model'] = response.model;
  }

  // Finish reasons
  if (response.finishReasons && Array.isArray(response.finishReasons)) {
    attributes['gen_ai.response.finish_reasons'] = response.finishReasons;
  } else if (response.finishReason) {
    attributes['gen_ai.response.finish_reasons'] = [response.finishReason];
  }

  return attributes;
}

/**
 * Build usage/token attributes from API response
 * @param {Object} usage - Usage object from API response
 * @returns {Object} Usage attributes
 */
export function buildUsageAttributes(usage = {}) {
  const attributes = {};

  if (usage.inputTokens !== undefined) {
    attributes['gen_ai.usage.input_tokens'] = Number.parseInt(usage.inputTokens, 10);
  } else if (usage.prompt_tokens !== undefined) {
    attributes['gen_ai.usage.input_tokens'] = Number.parseInt(usage.prompt_tokens, 10);
  }

  if (usage.outputTokens !== undefined) {
    attributes['gen_ai.usage.output_tokens'] = Number.parseInt(usage.outputTokens, 10);
  } else if (usage.completion_tokens !== undefined) {
    attributes['gen_ai.usage.output_tokens'] = Number.parseInt(usage.completion_tokens, 10);
  }

  // Prompt caching (OTel GenAI semantic conventions). Both are subsets of
  // `gen_ai.usage.input_tokens`, which counts the whole input for every
  // provider. Set only when the provider reported them.
  if (usage.cacheReadTokens !== undefined) {
    attributes['gen_ai.usage.cache_read.input_tokens'] = Number.parseInt(usage.cacheReadTokens, 10);
  }
  if (usage.cacheWriteTokens !== undefined) {
    attributes['gen_ai.usage.cache_creation.input_tokens'] = Number.parseInt(
      usage.cacheWriteTokens,
      10
    );
  }
  if (usage.reasoningTokens !== undefined) {
    attributes['gen_ai.usage.reasoning.output_tokens'] = Number.parseInt(usage.reasoningTokens, 10);
  }

  return attributes;
}

/**
 * Build server attributes from model configuration
 * @param {Object} model - Model configuration
 * @returns {Object} Server attributes
 */
export function buildServerAttributes(model = {}) {
  const attributes = {};

  if (model.url) {
    try {
      const url = new URL(model.url);
      attributes['server.address'] = url.hostname;
      if (url.port) {
        attributes['server.port'] = Number.parseInt(url.port, 10);
      }
    } catch {
      // Invalid URL, skip server attributes
    }
  }

  return attributes;
}
