/**
 * OpenAI API adapter
 */
import { parseSSEBuffer } from './streamUtils.js';

const OpenAIAdapter = {
  /**
   * Format messages for OpenAI API, including handling image data and file data
   * @param {Array} messages - Messages to format
   * @returns {Array} Formatted messages for OpenAI API
   */
  formatMessages(messages) {
    // Handle image data and file data in messages
    const formattedMessages = messages.map(message => {
      let content = message.content;
      
      // If there's file data, prepend it to the content
      if (message.fileData && message.fileData.content) {
        const fileInfo = `[File: ${message.fileData.name} (${message.fileData.type})]\n\n${message.fileData.content}\n\n`;
        content = fileInfo + (content || '');
      }
      
      // If there's no image data, return a clean message with text content (possibly including file content)
      if (!message.imageData) {
        return {
          role: message.role,
          content: content
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
    const { temperature = 0.7, stream = true } = options;
    
    return {
      url: model.url,
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${apiKey}`
      },
      body: {
        model: model.modelId,
        messages: this.formatMessages(messages),
        stream,
        temperature: parseFloat(temperature),
        max_tokens: options.maxTokens || 1024
      }
    };
  },

  /**
   * Process streaming response from OpenAI
   */
  processResponseBuffer(buffer) {
    const result = {
      content: [],
      complete: false,
      error: false,
      errorMessage: null
    };

    const { events, done } = parseSSEBuffer(buffer);
    if (done) result.complete = true;

    for (const evt of events) {
      try {
        const data = JSON.parse(evt);

        if (data.choices && data.choices[0]?.delta?.content) {
          result.content.push(data.choices[0].delta.content);
        }

        if (data.choices && data.choices[0]?.finish_reason) {
          result.complete = true;
        }
      } catch (error) {
        console.error('Error parsing OpenAI response chunk:', error);
        result.error = true;
        result.errorMessage = `Error parsing OpenAI response: ${error.message}`;
      }
    }

    return result;
  }
};

export default OpenAIAdapter;