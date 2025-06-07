/**
 * Anthropic API adapter
 */
import { parseSSEBuffer } from './streamUtils.js';

const AnthropicAdapter = {
  /**
   * Format messages for Anthropic API, including handling image data and file data
   */
  formatMessages(messages) {
    // Extract system message and filter it out from the messages array
    // Anthropic expects system messages as a separate parameter
    const systemMessage = messages.find(msg => msg.role === 'system');
    const filteredMessages = messages.filter(msg => msg.role !== 'system');
    
    // Process messages to handle image data and file data
    const processedMessages = filteredMessages.map(msg => {
      let content = msg.content;
      
      // If there's file data, prepend it to the content
      if (msg.fileData && msg.fileData.content) {
        const fileInfo = `[File: ${msg.fileData.name} (${msg.fileData.type})]\n\n${msg.fileData.content}\n\n`;
        content = fileInfo + (content || '');
      }
      
      // If the message doesn't have image data, return a clean message with text content (possibly including file content)
      if (!msg.imageData) {
        return {
          role: msg.role,
          content: content
        };
      }
      
      // For messages with images, convert to Anthropic's format with content array
      const contentArray = [];
      
      // Add text content if it exists (possibly including file content)
      if (content && content.trim()) {
        contentArray.push({
          type: "text",
          text: content
        });
      }
      
      // Add image content
      contentArray.push({
        type: "image",
        source: {
          type: "base64",
          media_type: msg.imageData.fileType || "image/jpeg",
          data: msg.imageData.base64.replace(/^data:image\/[a-z]+;base64,/, '') // Remove data URL prefix if present
        }
      });
      
      // Return the message with content array instead of content string
      return {
        role: msg.role,
        content: contentArray
      };
    });
    
    // Debug logs
    console.log('Original messages:', JSON.stringify(messages.map(m => ({ role: m.role, hasImage: !!m.imageData }))));
    console.log('Processed Anthropic messages:', JSON.stringify(processedMessages.map(m => ({ 
      role: m.role, 
      contentType: Array.isArray(m.content) ? 'array' : 'string',
      contentItems: Array.isArray(m.content) ? m.content.map(c => c.type) : null
    }))));
    
    return {
      messages: processedMessages,
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

    const { events, done } = parseSSEBuffer(buffer);
    if (done) result.complete = true;

    for (const evt of events) {
      try {
        const data = JSON.parse(evt);

        if (data.type === 'content_block_delta' && data.delta && data.delta.text) {
          result.content.push(data.delta.text);
        } else if (data.type === 'message_delta' && data.delta && data.delta.content) {
          result.content.push(data.delta.content);
        }

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