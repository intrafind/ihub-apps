/**
 * Anthropic API adapter
 */
import { formatToolsForAnthropic } from './toolFormatter.js';

const AnthropicAdapter = {
  /**
   * Format messages for Anthropic API, including handling image data
   */
  formatMessages(messages) {
    // Extract system message and filter it out from the messages array
    // Anthropic expects system messages as a separate parameter
    const systemMessage = messages.find(msg => msg.role === 'system');
    const filteredMessages = messages.filter(msg => msg.role !== 'system');
    
    // Process messages to handle image data
    const processedMessages = filteredMessages.map(msg => {
      const content = msg.content;
      
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
    const { temperature = 0.7, stream = true, maxTokens = 1024, tools = null } = options;
    
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

    if (tools && tools.length > 0) {
      requestBody.tools = formatToolsForAnthropic(tools);
    }
    
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
  processResponseBuffer(data) {
    const result = {
      content: [],
      complete: false,
      error: false,
      errorMessage: null,
      finishReason: null
    };

    if (!data) return result;
    try {
      const parsed = JSON.parse(data);

      // Handle full response object (non-streaming)
      if (parsed.content && Array.isArray(parsed.content) && parsed.content[0]?.text) {
        result.content.push(parsed.content[0].text);
        result.complete = true;
        if (parsed.stop_reason) {
          result.finishReason = parsed.stop_reason === 'end_turn' ? 'stop' : parsed.stop_reason;
        }
      }
      // Handle streaming response chunks
      else if (parsed.type === 'content_block_delta' && parsed.delta && parsed.delta.text) {
        result.content.push(parsed.delta.text);
      } else if (parsed.type === 'message_delta' && parsed.delta && parsed.delta.content) {
        result.content.push(parsed.delta.content);
      }

      if (parsed.type === 'message_stop') {
        result.complete = true;
        result.finishReason = 'stop';
      }
    } catch (parseError) {
      console.error('Error parsing Claude response chunk:', parseError);
      result.error = true;
      result.errorMessage = `Error parsing Claude response: ${parseError.message}`;
    }

    return result;
  }
};

export default AnthropicAdapter;