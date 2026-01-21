// server/adapters/mistral.js

/**
 * Mistral "La Plateforme" API adapter
 */
import { convertToolsFromGeneric } from './toolCalling/index.js';
import { BaseAdapter } from './BaseAdapter.js';

class MistralAdapterClass extends BaseAdapter {
  /**
   * Get provider name for telemetry
   * @returns {string} Provider name
   */
  getProviderName() {
    return 'mistral';
  }

  /**
   * Format messages for Mistral API, including handling image data
   * @param {Array} messages - Messages to format
   * @returns {Array} Formatted messages for Mistral API
   */
  formatMessages(messages) {
    const formattedMessages = messages.map(message => {
      const content = message.content;

      const base = { role: message.role };
      if (message.tool_calls) base.tool_calls = message.tool_calls;
      if (message.tool_call_id) base.tool_call_id = message.tool_call_id;
      if (message.name) base.name = message.name;

      if (!this.hasImageData(message)) {
        return { ...base, content };
      }

      return {
        ...base,
        content: [
          ...(content ? [{ type: 'text', text: content }] : []),
          {
            type: 'image_url',
            image_url: {
              url: message.imageData.base64,
              detail: 'high'
            }
          }
        ]
      };
    });

    return formattedMessages;
  }

  /**
   * Create a completion request for Mistral
   */
  createCompletionRequest(model, messages, apiKey, options = {}) {
    const { temperature, stream, tools, toolChoice, responseFormat, responseSchema, maxTokens } =
      this.extractRequestOptions(options);

    const formattedMessages = this.formatMessages(messages);
    this.debugLogMessages(messages, formattedMessages, 'Mistral');

    const body = {
      model: model.modelId,
      messages: formattedMessages,
      stream,
      temperature: parseFloat(temperature),
      max_tokens: maxTokens
    };

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
    // console.log('Mistral request body:', body);

    return {
      url: model.url,
      method: 'POST',
      headers: this.createRequestHeaders(apiKey),
      body
    };
  }

  /**
   * Process streaming response from Mistral
   */
  processResponseBuffer(data) {
    const result = {
      content: [],
      tool_calls: [],
      complete: false,
      error: false,
      errorMessage: null,
      finishReason: null
    };

    if (!data) return result;
    if (data === '[DONE]') {
      result.complete = true;
      return result;
    }

    try {
      const parsed = JSON.parse(data);

      // Handle full response object (non-streaming)
      if (parsed.choices && parsed.choices[0]?.message) {
        if (parsed.choices[0].message.content) {
          const msgContent = parsed.choices[0].message.content;
          if (Array.isArray(msgContent)) {
            for (const part of msgContent) {
              if (typeof part === 'string') {
                result.content.push(part);
              } else if (part && part.type === 'text' && part.text) {
                result.content.push(part.text);
              }
            }
          } else if (typeof msgContent === 'object' && msgContent !== null) {
            if (msgContent.type === 'text' && msgContent.text) {
              result.content.push(msgContent.text);
            }
          } else {
            result.content.push(msgContent);
          }
        }
        if (parsed.choices[0].message.tool_calls) {
          result.tool_calls.push(...parsed.choices[0].message.tool_calls);
        }
        result.complete = true;
        if (parsed.choices[0].finish_reason) {
          result.finishReason = parsed.choices[0].finish_reason;
        }
      }
      // Handle streaming response chunks
      else if (parsed.choices && parsed.choices[0]?.delta) {
        const delta = parsed.choices[0].delta;
        if (delta.content) {
          const deltaContent = delta.content;
          if (Array.isArray(deltaContent)) {
            for (const part of deltaContent) {
              if (typeof part === 'string') {
                result.content.push(part);
              } else if (part && part.type === 'text' && part.text) {
                result.content.push(part.text);
              }
            }
          } else if (typeof deltaContent === 'object' && deltaContent !== null) {
            if (deltaContent.type === 'text' && deltaContent.text) {
              result.content.push(deltaContent.text);
            }
          } else {
            result.content.push(deltaContent);
          }
        }
        if (delta.tool_calls) {
          for (const tc of delta.tool_calls) {
            const normalized = { index: tc.index };
            if (tc.id) normalized.id = tc.id;
            if (tc.function) {
              normalized.function = { ...tc.function };
            }
            result.tool_calls.push(normalized);
          }
        }
      }

      if (parsed.choices && parsed.choices[0]?.finish_reason) {
        // Possible Mistral finish reasons include 'stop', 'length', 'tool_calls'
        // and 'content_filter'. We forward the raw value so the service layer
        // can normalize or act on it as needed.
        result.complete = true;
        result.finishReason = parsed.choices[0].finish_reason;
      }
    } catch (error) {
      console.error('Error parsing Mistral response chunk:', error);
      result.error = true;
      result.errorMessage = `Error parsing Mistral response: ${error.message}`;
    }

    return result;
  }
}

const MistralAdapter = new MistralAdapterClass();
export default MistralAdapter;
