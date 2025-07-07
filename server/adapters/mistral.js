// server/adapters/mistral.js

/**
 * Mistral "La Plateforme" API adapter
 */
import { formatToolsForOpenAI } from './toolFormatter.js';

const MistralAdapter = {
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

      if (!message.imageData) {
        return { ...base, content };
      }

      return {
        ...base,
        content: [
          ...(content ? [{ type: "text", text: content }] : []),
          {
            type: "image_url",
            image_url: {
              url: message.imageData.base64,
              detail: "high"
            }
          }
        ]
      };
    });

    return formattedMessages;
  },

  /**
   * Create a completion request for Mistral
   */
  createCompletionRequest(model, messages, apiKey, options = {}) {
    const { temperature = 0.7, stream = true, tools = null, toolChoice = undefined } = options;

    const body = {
      model: model.modelId,
      messages: this.formatMessages(messages),
      stream,
      temperature: parseFloat(temperature),
      max_tokens: options.maxTokens || 1024
    };

    if (tools && tools.length > 0) body.tools = formatToolsForOpenAI(tools);
    if (toolChoice) body.tool_choice = toolChoice;

    return {
      url: model.url,
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${apiKey}`
      },
      body
    };
  },

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
            } else if (tc.delta && tc.delta.function) {
              normalized.function = { ...tc.delta.function };
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
};

export default MistralAdapter;