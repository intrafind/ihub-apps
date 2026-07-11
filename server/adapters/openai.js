/**
 * OpenAI API adapter
 */
import { convertToolsFromGeneric } from './toolCalling/index.js';
import { BaseAdapter } from './BaseAdapter.js';
import { formatOpenAICompatibleMessages } from './openaiCompatibleMessages.js';
import logger from '../utils/logger.js';
import modelDiscoveryService from '../services/ModelDiscoveryService.js';

class OpenAIAdapterClass extends BaseAdapter {
  /**
   * Format messages for OpenAI API, including handling image and audio data
   * @param {Array} messages - Messages to format
   * @param {Object} model - Target model config
   * @returns {Array} Formatted messages for OpenAI API
   */
  formatMessages(messages, model) {
    return formatOpenAICompatibleMessages(messages, model, this);
  }

  /**
   * Create a completion request for OpenAI
   */
  async createCompletionRequest(model, messages, apiKey, options = {}, { signal } = {}) {
    const { temperature, stream, tools, toolChoice, responseFormat, responseSchema, maxTokens } =
      this.extractRequestOptions(options);

    const formattedMessages = this.formatMessages(messages, model);
    this.debugLogMessages(messages, formattedMessages, 'OpenAI');

    // Use model discovery to get the effective model ID if enabled (under the
    // caller's deadline / abort signal, so a hung discovery cannot outlive it).
    const effectiveModelId = await modelDiscoveryService.getEffectiveModelId(model, apiKey, {
      signal
    });

    const body = {
      model: effectiveModelId,
      messages: formattedMessages,
      stream,
      temperature: Number.parseFloat(temperature),
      max_tokens: maxTokens
    };

    // Request usage data in streaming responses when model supports it
    if (stream && model.supportsUsageTracking !== false) {
      body.stream_options = { include_usage: true };
    }

    // Reasoning/thinking support. Gated on model.thinking.enabled so plain chat
    // models are unaffected. OpenAI reasoning models — and OpenAI-compatible
    // endpoints reached via this adapter (vLLM/DeepSeek/OpenRouter) — accept the
    // `reasoning_effort` parameter on /chat/completions. We deliberately keep
    // this conservative: max_tokens and temperature are left untouched so the
    // many OpenAI-compatible endpoints that don't impose reasoning-model
    // constraints keep working.
    if (model.thinking?.enabled && (options.thinkingEnabled ?? true)) {
      body.reasoning_effort = this.resolveReasoningEffort(options, model);
    }

    if (tools && tools.length > 0) body.tools = convertToolsFromGeneric(tools, 'openai');
    if (toolChoice) body.tool_choice = toolChoice;
    // Prompt caching is automatic; the key routes requests sharing a prefix
    // to the same cache (see adapters/promptCaching.js).
    if (options.promptCache?.key) body.prompt_cache_key = options.promptCache.key;
    if (responseSchema) {
      const schemaClone = this.enforceSchemaNoExtras(responseSchema);

      body.response_format = {
        type: 'json_schema',
        json_schema: {
          schema: schemaClone,
          name: 'response',
          strict: true
        }
      };
      logger.debug('Using response schema for structured output', {
        component: 'OpenAIAdapter'
      });
    } else if (responseFormat === 'json') {
      body.response_format = { type: 'json_object' };
    }

    // Note: Request body logging disabled to prevent exposing sensitive data in logs
    // logger.info('OpenAI request body:', JSON.stringify(body, null, 2));

    return {
      url: model.url,
      method: 'POST',
      headers: this.createRequestHeaders(apiKey),
      body
    };
  }
}

const OpenAIAdapter = new OpenAIAdapterClass();
export default OpenAIAdapter;
