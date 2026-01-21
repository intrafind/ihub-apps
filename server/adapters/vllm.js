/**
 * vLLM API adapter
 * vLLM provides an OpenAI-compatible API but with more restrictive JSON schema support
 */
import { convertToolsFromGeneric } from './toolCalling/index.js';
import { BaseAdapter } from './BaseAdapter.js';

class VLLMAdapterClass extends BaseAdapter {
  /**
   * Format messages for vLLM API (same as OpenAI)
   */
  formatMessages(messages) {
    const formattedMessages = messages.map(message => {
      const content = message.content;

      // Base message with role and optional tool fields
      const base = { role: message.role };
      if (message.tool_calls) base.tool_calls = message.tool_calls;
      if (message.tool_call_id) base.tool_call_id = message.tool_call_id;
      if (message.name) base.name = message.name;

      // Handle image data in messages
      if (!this.hasImageData(message)) {
        const finalContent =
          base.tool_calls && (content === undefined || content === '') ? null : content;
        return { ...base, content: finalContent };
      }

      // Format messages with image content for vision models
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
   * Create a completion request for vLLM
   */
  createCompletionRequest(model, messages, apiKey, options = {}) {
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

    // Use vLLM-specific tool conversion with schema sanitization and tool choice handling
    if (tools && tools.length > 0) {
      const result = convertToolsFromGeneric(tools, 'local', toolChoice);
      body.tools = result.tools;
      body.tool_choice = result.toolChoice;
      console.log(
        `[vLLM Adapter] Converted ${tools.length} tools with schema sanitization and adjusted tool choice`
      );
    } else if (toolChoice) {
      body.tool_choice = toolChoice;
    }

    // vLLM has limited response format support
    if (responseFormat === 'json') {
      body.response_format = { type: 'json_object' };
    }
    // Note: vLLM may not support structured output schemas

    // Note: Request body logging disabled to prevent exposing sensitive data in logs
    // console.log('vLLM request body:', body);

    return {
      url: model.url,
      method: 'POST',
      headers: this.createRequestHeaders(apiKey),
      body
    };
  }

  /**
   * Process streaming response from vLLM (same as OpenAI)
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

      // Handle error responses
      if (parsed.error) {
        result.error = true;
        result.errorMessage = parsed.error.message || 'vLLM error';
        result.complete = true;
        return result;
      }

      // Handle full response object (non-streaming)
      if (parsed.choices && parsed.choices[0]?.message) {
        if (parsed.choices[0].message.content) {
          result.content.push(parsed.choices[0].message.content);
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
          result.content.push(delta.content);
        }
        if (delta.tool_calls) {
          for (const tc of delta.tool_calls) {
            const normalized = { index: tc.index };
            if (tc.id) normalized.id = tc.id;
            if (tc.function) {
              normalized.function = { ...tc.function };
            }
            if (tc.type) {
              normalized.type = tc.type;
            } else {
              normalized.type = 'function';
            }
            result.tool_calls.push(normalized);
          }
        }
      }

      if (parsed.choices && parsed.choices[0]?.finish_reason) {
        result.complete = true;
        result.finishReason = parsed.choices[0].finish_reason;
      }
    } catch (error) {
      console.error('Error parsing vLLM response chunk:', error);
      result.error = true;
      result.errorMessage = `Error parsing vLLM response: ${error.message}`;
    }

    return result;
  }
}

const VLLMAdapter = new VLLMAdapterClass();
export default VLLMAdapter;
