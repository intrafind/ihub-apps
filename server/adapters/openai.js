/**
 * OpenAI API adapter
 */
import { sendSSE } from '../utils.js';

const OpenAIAdapter = {
  /**
   * Format messages for OpenAI API, including handling image data
   * @param {Array} messages - Messages to format
   * @returns {Array} Formatted messages for OpenAI API
   */
  formatMessages(messages) {
    // Handle image data in messages
    const formattedMessages = messages.map(message => {
      // If there's no image data, return a clean message without imageData property
      if (!message.imageData) {
        // Return a new object with only the properties that OpenAI expects
        return {
          role: message.role,
          content: message.content
        };
      }

      // Format messages with image content for vision models
      return {
        role: message.role,
        content: [
          // If there's text content, include it
          ...(message.content ? [{
            type: "text",
            text: message.content
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
    
    const lines = buffer.split('\n');
    
    for (const line of lines) {
      // Check for completion signal
      if (line.trim() === 'data: [DONE]') {
        result.complete = true;
        continue;
      }
      
      if (line.trim() === '') continue;
      
      try {
        // Extract the JSON data part from "data: {json}"
        const dataMatch = line.match(/data: (.+)/);
        if (!dataMatch) continue;
        
        const data = JSON.parse(dataMatch[1]);
        
        if (data.choices && data.choices[0]?.delta?.content) {
          result.content.push(data.choices[0].delta.content);
        }
        
        // Check if this is the last chunk
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