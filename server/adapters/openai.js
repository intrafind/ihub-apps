/**
 * OpenAI API adapter
 */
import { formatToolsForOpenAI } from './toolFormatter.js';

const OpenAIAdapter = {
  /**
   * Format messages for OpenAI API, including handling image data
   * @param {Array} messages - Messages to format
   * @returns {Array} Formatted messages for OpenAI API
   */
  formatMessages(messages) {
    // Handle image data in messages
    const formattedMessages = messages.map(message => {
      const content = message.content;

      // If there's no image data, return a clean message with text content
      if (!message.imageData) {
        return {
          role: message.role,
          content
        };
      }

      // Format messages with image content for vision models
      return {
        role: message.role,
        content: [
          // If there's text content (possibly including file content), include it
          ...(content ? [{
            type: "text",
            text: content
          }] : []),
          // Add the image content
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
   * Create a completion request for OpenAI
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
   * Process streaming response from OpenAI
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
        if (parsed.choices[0].delta.content) {
          result.content.push(parsed.choices[0].delta.content);
        }
        if (parsed.choices[0].delta.tool_calls) {
          result.tool_calls.push(...parsed.choices[0].delta.tool_calls);
        }
      }

      if (parsed.choices && parsed.choices[0]?.finish_reason) {
        // Possible OpenAI finish reasons include 'stop', 'length', 'tool_calls'
        // and 'content_filter'. We forward the raw value so the service layer
        // can normalize or act on it as needed.
        result.complete = true;
        result.finishReason = parsed.choices[0].finish_reason;
      }
    } catch (error) {
      console.error('Error parsing OpenAI response chunk:', error);
      result.error = true;
      result.errorMessage = `Error parsing OpenAI response: ${error.message}`;
    }

    return result;
  }
};

export default OpenAIAdapter;