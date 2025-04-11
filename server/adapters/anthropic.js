/**
 * Anthropic API adapter
 */
import { sendSSE } from '../utils.js';

const AnthropicAdapter = {
  /**
   * Format messages for Anthropic API
   */
  formatMessages(messages) {
    // Extract system message and filter it out from the messages array
    // Anthropic expects system messages as a separate parameter
    const systemMessage = messages.find(msg => msg.role === 'system');
    const filteredMessages = messages.filter(msg => msg.role !== 'system');
    
    return {
      messages: filteredMessages,
      systemPrompt: systemMessage?.content || ''
    };
  },

  /**
   * Create a completion request for Anthropic
   */
  createCompletionRequest(model, messages, apiKey, options = {}) {
    const { temperature = 0.7, stream = true, maxTokens = 1024 } = options;
    
    // Format messages and extract system prompt
    const { messages: formattedMessages, systemPrompt } = this.formatMessages(messages);
    
    // Note: We don't throw an error here for missing API keys
    // Instead we let the server's verifyApiKey function handle this consistently
    // This ensures proper localization of error messages
    
    const requestBody = {
      model: model.modelId,
      messages: formattedMessages,
      stream,
      temperature: parseFloat(temperature),
      max_tokens: maxTokens
    };
    
    // Only add system parameter if we have a system message
    if (systemPrompt) {
      requestBody.system = systemPrompt;
    }

    console.log('Anthropic request body:', requestBody);
    
    return {
      url: model.url,
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': apiKey || '', // Provide empty string to avoid undefined
        'anthropic-version': '2023-06-01'
      },
      body: requestBody
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