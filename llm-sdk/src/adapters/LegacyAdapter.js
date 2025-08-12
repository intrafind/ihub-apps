import { LLMClient } from '../core/LLMClient.js';
import { Message } from '../core/Message.js';
import { defaultLogger } from '../utils/Logger.js';

/**
 * Legacy adapter that wraps the SDK for backward compatibility
 * with the existing iHub Apps adapter interface
 */
export class LegacyAdapter {
  constructor(config = {}) {
    this.config = config;
    this.logger = config.logger || defaultLogger.child('LegacyAdapter');

    // Initialize SDK client
    this.client = new LLMClient({
      providers: config.providers,
      defaultProvider: config.defaultProvider || 'openai',
      logger: this.logger.child('SDK')
    });
  }

  /**
   * Legacy createCompletionRequest method
   * @param {Object} model - Model configuration
   * @param {Array} messages - Messages array
   * @param {string} apiKey - API key
   * @param {Object} options - Request options
   * @returns {Object} Request configuration
   */
  async createCompletionRequest(model, messages, apiKey, options = {}) {
    await this.client.ready();

    // Convert legacy model format to SDK format
    const provider = model.provider || this.client.defaultProvider;

    // Convert messages to SDK Message objects
    const sdkMessages = messages.map(msg => {
      if (msg.role === 'tool') {
        return Message.toolResponse(msg.tool_call_id, msg.content, msg.name);
      } else if (msg.role === 'assistant' && msg.tool_calls) {
        return Message.assistantWithToolCalls(msg.content || '', msg.tool_calls);
      } else if (msg.imageData) {
        return Message.userWithImage(msg.content || '', {
          base64: msg.imageData.base64,
          mimeType: msg.imageData.fileType || 'image/jpeg'
        });
      } else {
        return new Message(msg.role, msg.content || '');
      }
    });

    // Build SDK request
    const sdkRequest = {
      provider,
      model: model.modelId,
      messages: sdkMessages,
      temperature: options.temperature,
      maxTokens: options.maxTokens,
      stream: options.stream,
      tools: options.tools,
      toolChoice: options.toolChoice,
      responseFormat: options.responseSchema
        ? {
            type: 'json_schema',
            schema: options.responseSchema
          }
        : options.responseFormat === 'json'
          ? { type: 'json_object' }
          : undefined
    };

    // For legacy compatibility, return the old format
    // This is used by the existing StreamingHandler/NonStreamingHandler
    return {
      url: model.url, // Will be ignored by SDK but needed for legacy compatibility
      method: 'POST',
      headers: { Authorization: `Bearer ${apiKey}` },
      body: sdkRequest,
      _sdkRequest: sdkRequest,
      _sdk: this.client
    };
  }

  /**
   * Legacy processResponseBuffer method
   * @param {string} provider - Provider name
   * @param {string} buffer - Response buffer
   * @returns {Object} Processed response in legacy format
   */
  processResponseBuffer(provider, buffer) {
    // This method is used by the existing streaming handler
    // For now, we'll delegate to the provider's parsing logic
    // In a full migration, this would be handled by the SDK's streaming system

    try {
      if (!buffer || buffer === '[DONE]') {
        return {
          content: [],
          tool_calls: [],
          complete: buffer === '[DONE]',
          error: false,
          errorMessage: null,
          finishReason: buffer === '[DONE]' ? 'stop' : null
        };
      }

      // Parse the chunk
      const parsed = JSON.parse(buffer);

      // Convert to legacy format based on provider
      if (provider === 'openai' || provider === 'vllm') {
        return this.processOpenAIChunk(parsed);
      } else if (provider === 'anthropic') {
        return this.processAnthropicChunk(parsed);
      } else if (provider === 'google') {
        return this.processGoogleChunk(parsed);
      } else if (provider === 'mistral') {
        return this.processMistralChunk(parsed);
      }

      // Default processing
      return {
        content: [],
        tool_calls: [],
        complete: false,
        error: false,
        errorMessage: null,
        finishReason: null
      };
    } catch (error) {
      this.logger.error('Error processing response buffer:', error);
      return {
        content: [],
        tool_calls: [],
        complete: false,
        error: true,
        errorMessage: error.message,
        finishReason: null
      };
    }
  }

  /**
   * Process OpenAI chunk in legacy format
   * @param {Object} parsed - Parsed chunk
   * @returns {Object} Legacy format result
   */
  processOpenAIChunk(parsed) {
    const result = {
      content: [],
      tool_calls: [],
      complete: false,
      error: false,
      errorMessage: null,
      finishReason: null
    };

    if (parsed.choices && parsed.choices[0]) {
      const choice = parsed.choices[0];

      // Handle delta content
      if (choice.delta) {
        if (choice.delta.content) {
          result.content.push(choice.delta.content);
        }
        if (choice.delta.tool_calls) {
          result.tool_calls.push(...choice.delta.tool_calls);
        }
      }

      // Handle complete message
      if (choice.message) {
        if (choice.message.content) {
          result.content.push(choice.message.content);
        }
        if (choice.message.tool_calls) {
          result.tool_calls.push(...choice.message.tool_calls);
        }
      }

      if (choice.finish_reason) {
        result.complete = true;
        result.finishReason = choice.finish_reason;
      }
    }

    return result;
  }

  /**
   * Process Anthropic chunk in legacy format
   * @param {Object} parsed - Parsed chunk
   * @returns {Object} Legacy format result
   */
  processAnthropicChunk(parsed) {
    const result = {
      content: [],
      tool_calls: [],
      complete: false,
      error: false,
      errorMessage: null,
      finishReason: null
    };

    // Handle different Anthropic event types
    switch (parsed.type) {
      case 'content_block_delta':
        if (parsed.delta && parsed.delta.text) {
          result.content.push(parsed.delta.text);
        }
        break;

      case 'message_delta':
        if (parsed.delta && parsed.delta.stop_reason) {
          result.complete = true;
          result.finishReason =
            parsed.delta.stop_reason === 'end_turn' ? 'stop' : parsed.delta.stop_reason;
        }
        break;

      case 'message_stop':
        result.complete = true;
        break;

      case 'content_block_start':
        if (parsed.content_block && parsed.content_block.type === 'tool_use') {
          result.tool_calls.push({
            index: parsed.index,
            id: parsed.content_block.id,
            type: 'function',
            function: {
              name: parsed.content_block.name,
              arguments: ''
            }
          });
        }
        break;
    }

    return result;
  }

  /**
   * Process Google chunk in legacy format
   * @param {Object} parsed - Parsed chunk
   * @returns {Object} Legacy format result
   */
  processGoogleChunk(parsed) {
    const result = {
      content: [],
      tool_calls: [],
      complete: false,
      error: false,
      errorMessage: null,
      finishReason: null
    };

    if (parsed.candidates && parsed.candidates[0]) {
      const candidate = parsed.candidates[0];

      if (candidate.content && candidate.content.parts) {
        for (const part of candidate.content.parts) {
          if (part.text) {
            result.content.push(part.text);
          } else if (part.functionCall) {
            result.tool_calls.push({
              id: `call_${Date.now()}`,
              type: 'function',
              function: {
                name: part.functionCall.name,
                arguments: JSON.stringify(part.functionCall.args || {})
              }
            });
          }
        }
      }

      if (candidate.finishReason) {
        result.complete = true;
        result.finishReason = candidate.finishReason.toLowerCase();
      }
    }

    return result;
  }

  /**
   * Process Mistral chunk in legacy format
   * @param {Object} parsed - Parsed chunk
   * @returns {Object} Legacy format result
   */
  processMistralChunk(parsed) {
    const result = {
      content: [],
      tool_calls: [],
      complete: false,
      error: false,
      errorMessage: null,
      finishReason: null
    };

    if (parsed.choices && parsed.choices[0]) {
      const choice = parsed.choices[0];

      // Handle delta content (streaming)
      if (choice.delta) {
        if (choice.delta.content) {
          // Mistral can have complex content format
          if (Array.isArray(choice.delta.content)) {
            for (const part of choice.delta.content) {
              if (typeof part === 'string') {
                result.content.push(part);
              } else if (part && part.type === 'text' && part.text) {
                result.content.push(part.text);
              }
            }
          } else if (
            typeof choice.delta.content === 'object' &&
            choice.delta.content.type === 'text'
          ) {
            result.content.push(choice.delta.content.text);
          } else {
            result.content.push(choice.delta.content || '');
          }
        }
        if (choice.delta.tool_calls) {
          result.tool_calls.push(...choice.delta.tool_calls);
        }
      }

      // Handle complete message (non-streaming)
      if (choice.message) {
        if (choice.message.content) {
          // Similar complex content handling for non-streaming
          if (Array.isArray(choice.message.content)) {
            for (const part of choice.message.content) {
              if (typeof part === 'string') {
                result.content.push(part);
              } else if (part && part.type === 'text' && part.text) {
                result.content.push(part.text);
              }
            }
          } else if (
            typeof choice.message.content === 'object' &&
            choice.message.content.type === 'text'
          ) {
            result.content.push(choice.message.content.text);
          } else {
            result.content.push(choice.message.content || '');
          }
        }
        if (choice.message.tool_calls) {
          result.tool_calls.push(...choice.message.tool_calls);
        }
      }

      if (choice.finish_reason) {
        result.complete = true;
        result.finishReason = choice.finish_reason;
      }
    }

    return result;
  }

  /**
   * Legacy formatMessages method
   * @param {string} provider - Provider name
   * @param {Array} messages - Messages to format
   * @returns {Array} Formatted messages
   */
  async formatMessages(provider, messages) {
    await this.client.ready();

    const providerInstance = this.client.getProvider(provider);
    const sdkMessages = messages.map(msg => {
      if (msg instanceof Message) return msg;

      if (msg.role === 'tool') {
        return Message.toolResponse(msg.tool_call_id, msg.content, msg.name);
      } else if (msg.role === 'assistant' && msg.tool_calls) {
        return Message.assistantWithToolCalls(msg.content || '', msg.tool_calls);
      } else if (msg.imageData) {
        return Message.userWithImage(msg.content || '', {
          base64: msg.imageData.base64,
          mimeType: msg.imageData.fileType || 'image/jpeg'
        });
      } else {
        return new Message(msg.role, msg.content || '');
      }
    });

    return providerInstance.formatMessages(sdkMessages);
  }

  /**
   * Get SDK client for advanced usage
   * @returns {LLMClient} SDK client instance
   */
  getSDKClient() {
    return this.client;
  }
}

/**
 * Create legacy adapter instance
 * @param {Object} config - Configuration
 * @returns {LegacyAdapter} Legacy adapter instance
 */
export function createLegacyAdapter(config) {
  return new LegacyAdapter(config);
}
