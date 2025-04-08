/**
 * Anthropic API adapter
 */
import { sendSSE } from '../utils.js';

const AnthropicAdapter = {
  /**
   * Format messages for Anthropic API
   */
  formatMessages(messages) {
    // Anthropic format is already compatible
    return messages;
  },

  /**
   * Create a completion request for Anthropic
   */
  createCompletionRequest(model, messages, apiKey, options = {}) {
    const { temperature = 0.7, stream = true } = options;
    
    return {
      url: model.url,
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01'
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
   * Process streaming response from Anthropic
   */
  processResponseBuffer(buffer) {
    const result = {
      content: [],
      complete: false,
      error: false,
      errorMessage: null
    };
    
    const lines = buffer.split('\n\n');
    
    for (const line of lines) {
      // Check for completion signal
      if (line.includes('data: [DONE]')) {
        result.complete = true;
        continue;
      }
      
      if (line.trim() === '') continue;
      
      try {
        // Extract the JSON data part from "data: {json}"
        const dataMatch = line.match(/data: (.+)/);
        if (!dataMatch) continue;
        
        const data = JSON.parse(dataMatch[1]);
        
        // Check if this is a content block with text
        if (data.type === 'content_block_delta' && data.delta && data.delta.text) {
          result.content.push(data.delta.text);
        }
        // Check for message delta (different format in some Claude API versions)
        else if (data.type === 'message_delta' && data.delta && data.delta.content) {
          result.content.push(data.delta.content);
        }
        
        // Check for completion signal
        if (data.type === 'message_stop') {
          result.complete = true;
        }
      } catch (parseError) {
        console.error('Error parsing Claude response chunk:', parseError);
        result.error = true;
        result.errorMessage = `Error parsing Claude response: ${parseError.message}`;
      }
    }
    
    return result;
  }
};

export default AnthropicAdapter;