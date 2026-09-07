// server/adapters/mistral.js

/**
 * Mistral "La Plateforme" API adapter
 */
import { convertToolsFromGeneric } from './toolCalling/index.js';
import {
  modelConsumesThoughtSignature,
  stripThoughtSignatureExtraContent
} from './toolCalling/thoughtSignatures.js';
import { BaseAdapter } from './BaseAdapter.js';

class MistralAdapterClass extends BaseAdapter {
  /**
   * Format messages for Mistral API, including handling image data
   * @param {Array} messages - Messages to format
   * @returns {Array} Formatted messages for Mistral API
   */
  formatMessages(messages, model) {
    const keepExtraContent = modelConsumesThoughtSignature(model);
    const formattedMessages = messages.map(message => {
      const content = message.content;

      const base = { role: message.role };
      // Gemini's `extra_content` thought signature is a Google vendor extension.
      // Strict OpenAI-compatible providers reject a request that carries it, so
      // drop it unless this model is the one that consumes it — a caller
      // replaying Gemini-originated history against another model must not have
      // that field forwarded upstream.
      if (message.tool_calls) {
        base.tool_calls = keepExtraContent
          ? message.tool_calls
          : stripThoughtSignatureExtraContent(message.tool_calls);
      }
      if (message.tool_call_id) base.tool_call_id = message.tool_call_id;
      if (message.name) base.name = message.name;

      if (!this.hasImageData(message)) {
        return { ...base, content };
      }

      // Mirror OpenAIAdapter.formatMessages — see vllm.js comment for the
      // full story. Same bug, same fix (issue #1467): handle array shape
      // and wrap raw base64 in a proper `data:<mime>;base64,…` URL.
      const contentParts = content ? [{ type: 'text', text: content }] : [];

      if (Array.isArray(message.imageData)) {
        message.imageData
          .filter(img => img && img.base64)
          .forEach(img => {
            contentParts.push({
              type: 'image_url',
              image_url: {
                url: `data:${img.fileType || 'image/jpeg'};base64,${this.cleanBase64Data(img.base64)}`,
                detail: 'high'
              }
            });
          });
      } else {
        contentParts.push({
          type: 'image_url',
          image_url: {
            url: `data:${message.imageData.format || message.imageData.fileType || 'image/jpeg'};base64,${this.cleanBase64Data(message.imageData.base64)}`,
            detail: 'high'
          }
        });
      }

      return { ...base, content: contentParts };
    });

    return formattedMessages;
  }

  /**
   * Create a completion request for Mistral
   */
  async createCompletionRequest(model, messages, apiKey, options = {}) {
    const { temperature, stream, tools, toolChoice, responseFormat, responseSchema, maxTokens } =
      this.extractRequestOptions(options);

    const formattedMessages = this.formatMessages(messages, model);
    this.debugLogMessages(messages, formattedMessages, 'Mistral');

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

    if (tools && tools.length > 0) body.tools = convertToolsFromGeneric(tools, 'mistral');
    if (toolChoice) body.tool_choice = toolChoice;
    if (responseSchema) {
      body.response_format = {
        type: 'json_schema',
        json_schema: {
          schema: responseSchema,
          name: 'response',
          strict: true
        }
      };
    } else if (responseFormat && responseFormat === 'json') {
      body.response_format = { type: 'json_object' };
    }

    // Note: Request body logging disabled to prevent exposing sensitive data in logs
    // logger.info('Mistral request body:', body);

    return {
      url: model.url,
      method: 'POST',
      headers: this.createRequestHeaders(apiKey),
      body
    };
  }
}

const MistralAdapter = new MistralAdapterClass();
export default MistralAdapter;
