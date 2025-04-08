/**
 * OpenAI API adapter
 */
import { sendSSE } from '../utils.js';

const OpenAIAdapter = {
  /**
   * Format messages for OpenAI API
   */
  formatMessages(messages) {
    // OpenAI already uses the format we use internally
    return messages;
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
  processResponseBuffer(buffer, res) {
    const lines = buffer.split('\n');
    
    for (const line of lines) {
      if (line.trim() === '' || line.trim() === 'data: [DONE]') continue;
      
      try {
        // Extract the JSON data part from "data: {json}"
        const dataMatch = line.match(/data: (.+)/);
        if (!dataMatch) continue;
        
        const data = JSON.parse(dataMatch[1]);
        
        if (data.choices && data.choices[0]?.delta?.content) {
          sendSSE(res, 'chunk', { content: data.choices[0].delta.content });
        }
      } catch (error) {
        console.error('Error parsing OpenAI response chunk:', error);
      }
    }
  }
};

export default OpenAIAdapter; 