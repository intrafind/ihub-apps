/**
 * vLLM API adapter
 *
 * vLLM exposes an OpenAI-compatible API. Modern vLLM (v0.12.0+) accepts the
 * standard `response_format: { type: "json_schema", json_schema: { ... } }`
 * shape and enforces the schema server-side via its structured-outputs
 * backend (xgrammar / guidance / outlines, selected automatically). Older
 * versions accepted the now-removed `guided_json` extra parameter; we don't
 * target those.
 */
import { convertToolsFromGeneric } from './toolCalling/index.js';
import { BaseAdapter } from './BaseAdapter.js';
import { formatOpenAICompatibleMessages } from './openaiCompatibleMessages.js';
import logger from '../utils/logger.js';

class VLLMAdapterClass extends BaseAdapter {
  /**
   * Format messages for vLLM API (same as OpenAI, including audio support —
   * gated behind `hasAudioData`, itself gated by a model's `supportsAudio`
   * flag, so this is a no-op unless a vLLM model config explicitly opts in)
   */
  formatMessages(messages) {
    return formatOpenAICompatibleMessages(messages, this);
  }

  /**
   * Create a completion request for vLLM
   */
  async createCompletionRequest(model, messages, apiKey, options = {}) {
    const { temperature, stream, tools, toolChoice, responseFormat, responseSchema, maxTokens } =
      this.extractRequestOptions(options);

    const formattedMessages = this.formatMessages(messages);
    this.debugLogMessages(messages, formattedMessages, 'vLLM');

    const body = {
      model: model.modelId,
      messages: formattedMessages,
      stream,
      temperature: parseFloat(temperature),
      max_tokens: maxTokens
    };

    // Request usage data in streaming responses when model supports it
    if (stream && model.supportsUsageTracking !== false) {
      body.stream_options = { include_usage: true };
    }

    // Thinking/reasoning support. vLLM emits reasoning in a separate field when
    // the server is started with a `--reasoning-parser`. Per-request enable/
    // disable is model-specific via `chat_template_kwargs` (Qwen3:
    // `enable_thinking`, Granite: `thinking`), so models that use a different
    // key can declare `thinking.chatTemplateKwargs` explicitly. Some models
    // (e.g. gpt-oss) also honor `reasoning_effort`.
    if (model.thinking?.enabled) {
      const thinkingEnabled = options.thinkingEnabled ?? true;
      let chatTemplateKwargs;
      if (model.thinking.chatTemplateKwargs !== undefined) {
        chatTemplateKwargs = { ...model.thinking.chatTemplateKwargs };
        // When the override is a single boolean toggle (e.g. Qwen3
        // `{ enable_thinking: true }` or Granite `{ thinking: true }`), apply the
        // per-request thinking toggle so app/user settings can still turn
        // reasoning off — the configured value acts as the default. Multi-key or
        // non-boolean overrides are treated as explicit operator config and passed
        // through unchanged.
        const keys = Object.keys(chatTemplateKwargs);
        if (keys.length === 1 && typeof chatTemplateKwargs[keys[0]] === 'boolean') {
          chatTemplateKwargs[keys[0]] = thinkingEnabled;
        }
      } else {
        chatTemplateKwargs = { enable_thinking: thinkingEnabled };
      }
      if (Object.keys(chatTemplateKwargs).length > 0) {
        body.chat_template_kwargs = chatTemplateKwargs;
      }
      const level = options.thinkingLevel ?? model.thinking.level;
      if (thinkingEnabled && level) {
        body.reasoning_effort = this.resolveReasoningEffort(options, model);
      }
    }

    // Use vLLM-specific tool conversion with schema sanitization
    if (tools && tools.length > 0) {
      body.tools = convertToolsFromGeneric(tools, 'local');
      if (toolChoice) {
        body.tool_choice = toolChoice;
      }
      logger.info('Converted tools with schema sanitization', {
        component: 'VLLMAdapter',
        toolCount: tools.length
      });
    } else if (toolChoice) {
      body.tool_choice = toolChoice;
    }

    // Structured output: when a JSON schema is provided, ask vLLM to enforce
    // it server-side via the standard OpenAI `json_schema` response_format.
    // Without this, the model free-styles JSON and on long outputs (e.g. many
    // verbatim quotes) routinely produces unterminated strings that blow past
    // maxTokens. vLLM's xgrammar/guidance/outlines backend constrains the
    // generation grammar, which both fixes the truncation and trims wasted
    // tokens. Mirrors the OpenAI adapter, including the `additionalProperties:
    // false` enforcement that some schema backends require.
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
      logger.info('Using response schema for structured output', {
        component: 'VLLMAdapter'
      });
    } else if (responseFormat === 'json') {
      body.response_format = { type: 'json_object' };
    }

    // Note: Request body logging disabled to prevent exposing sensitive data in logs
    // logger.info('vLLM request body:', body);

    return {
      url: model.url,
      method: 'POST',
      headers: this.createRequestHeaders(apiKey),
      body
    };
  }
}

const VLLMAdapter = new VLLMAdapterClass();
export default VLLMAdapter;
