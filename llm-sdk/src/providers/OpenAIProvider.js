import { Provider } from '../core/Provider.js';
import { Message, ToolCall } from '../core/Message.js';
import { Response, ResponseChoice, ResponseChunk, ResponseChoiceDelta, ResponseDelta, Usage } from '../core/Response.js';
import { ConfigurationError, ProviderError, NetworkError } from '../utils/ErrorHandler.js';
import { Validator } from '../utils/Validator.js';

/**
 * OpenAI provider implementation
 */
export class OpenAIProvider extends Provider {
  constructor(config) {
    super(config);
    this.baseURL = config.baseURL || 'https://api.openai.com/v1';
    this.models = this.initializeModels();
  }

  /**
   * Initialize available models
   * @returns {Array<string>} List of model names
   */
  initializeModels() {
    return [
      'gpt-4',
      'gpt-4-turbo',
      'gpt-4-turbo-preview',
      'gpt-4-0125-preview',
      'gpt-4-1106-preview',
      'gpt-4-vision-preview',
      'gpt-3.5-turbo',
      'gpt-3.5-turbo-16k',
      'gpt-3.5-turbo-1106',
      'gpt-3.5-turbo-0125'
    ];
  }

  // ============================================================================
  // CAPABILITY METHODS
  // ============================================================================

  supportsTools() {
    return true;
  }

  supportsImages() {
    return true;
  }

  supportsStructuredOutput() {
    return true;
  }

  supportsStreaming() {
    return true;
  }

  getMaxContextLength(model) {
    const contextLengths = {
      'gpt-4': 8192,
      'gpt-4-turbo': 128000,
      'gpt-4-turbo-preview': 128000,
      'gpt-4-0125-preview': 128000,
      'gpt-4-1106-preview': 128000,
      'gpt-4-vision-preview': 128000,
      'gpt-3.5-turbo': 16384,
      'gpt-3.5-turbo-16k': 16384,
      'gpt-3.5-turbo-1106': 16384,
      'gpt-3.5-turbo-0125': 16384
    };
    return contextLengths[model] || 4096;
  }

  getMaxOutputTokens(model) {
    const outputLimits = {
      'gpt-4': 4096,
      'gpt-4-turbo': 4096,
      'gpt-4-turbo-preview': 4096,
      'gpt-4-0125-preview': 4096,
      'gpt-4-1106-preview': 4096,
      'gpt-4-vision-preview': 4096,
      'gpt-3.5-turbo': 4096,
      'gpt-3.5-turbo-16k': 4096,
      'gpt-3.5-turbo-1106': 4096,
      'gpt-3.5-turbo-0125': 4096
    };
    return outputLimits[model] || 2048;
  }

  // ============================================================================
  // CORE IMPLEMENTATION METHODS
  // ============================================================================

  /**
   * Send chat completion request
   * @param {Object} request - Chat request
   * @returns {Promise<Response>} Response object
   */
  async chat(request) {
    const validatedRequest = this.validateRequest(request);
    const httpRequest = this.buildHttpRequest(validatedRequest);

    try {
      const response = await this.makeRequest(httpRequest.url, {
        method: httpRequest.method,
        headers: httpRequest.headers,
        body: JSON.stringify(httpRequest.body)
      });

      const responseData = await response.json();
      return this.parseResponse(responseData, validatedRequest);
    } catch (error) {
      this.logger.error('OpenAI chat request failed:', error);
      throw error;
    }
  }

  /**
   * Send streaming chat completion request
   * @param {Object} request - Chat request
   * @returns {Promise<AsyncIterator<ResponseChunk>>} Streaming response
   */
  async stream(request) {
    const validatedRequest = this.validateRequest({ ...request, stream: true });
    const httpRequest = this.buildHttpRequest(validatedRequest);

    try {
      const response = await this.makeRequest(httpRequest.url, {
        method: httpRequest.method,
        headers: httpRequest.headers,
        body: JSON.stringify(httpRequest.body)
      });

      return this.parseStreamResponse(response, validatedRequest);
    } catch (error) {
      this.logger.error('OpenAI stream request failed:', error);
      throw error;
    }
  }

  /**
   * Format messages for OpenAI API
   * @param {Array<Message>} messages - Messages to format
   * @returns {Array<Object>} Formatted messages
   */
  formatMessages(messages) {
    return messages.map(message => {
      const formatted = { role: message.role };

      // Handle different content types
      if (typeof message.content === 'string') {
        formatted.content = message.content;
      } else if (Array.isArray(message.content)) {
        formatted.content = message.content.map(part => {
          if (part.type === 'text') {
            return { type: 'text', text: part.data.text };
          } else if (part.type === 'image') {
            return {
              type: 'image_url',
              image_url: {
                url: part.data.url || `data:${part.data.mimeType || 'image/jpeg'};base64,${part.data.base64}`,
                detail: 'high'
              }
            };
          }
          return part;
        });
      }

      // Add tool-specific fields
      if (message.toolCalls && message.toolCalls.length > 0) {
        formatted.tool_calls = message.toolCalls.map(tc => ({
          id: tc.id,
          type: 'function',
          function: {
            name: tc.name,
            arguments: JSON.stringify(tc.arguments)
          }
        }));
      }

      if (message.toolCallId) {
        formatted.tool_call_id = message.toolCallId;
      }

      if (message.name) {
        formatted.name = message.name;
      }

      return formatted;
    });
  }

  /**
   * Parse OpenAI response to standard format
   * @param {Object} response - OpenAI response
   * @param {Object} originalRequest - Original request
   * @returns {Response} Standardized response
   */
  parseResponse(response, originalRequest) {
    const choices = response.choices.map((choice, index) => {
      const message = this.parseMessage(choice.message);
      return new ResponseChoice(
        index,
        message,
        this.normalizeFinishReason(choice.finish_reason),
        choice.logprobs
      );
    });

    const usage = response.usage ? new Usage(
      response.usage.prompt_tokens,
      response.usage.completion_tokens,
      response.usage.total_tokens
    ) : new Usage();

    return new Response({
      id: response.id,
      model: originalRequest.model,
      provider: this.name,
      choices,
      usage,
      metadata: {
        created: response.created,
        systemFingerprint: response.system_fingerprint
      },
      raw: response
    });
  }

  /**
   * Parse streaming response
   * @param {Response} response - HTTP response
   * @param {Object} originalRequest - Original request
   * @returns {AsyncIterator<ResponseChunk>} Streaming chunks
   */
  async* parseStreamResponse(response, originalRequest) {
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';

    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split('\n');
        buffer = lines.pop() || '';

        for (const line of lines) {
          const trimmedLine = line.trim();
          if (trimmedLine === '' || trimmedLine === 'data: [DONE]') continue;
          if (trimmedLine.startsWith('data: ')) {
            const jsonData = trimmedLine.slice(6);
            try {
              const parsed = JSON.parse(jsonData);
              const chunk = this.parseStreamChunk(parsed, originalRequest);
              if (chunk) {
                yield chunk;
              }
            } catch (error) {
              this.logger.warn('Failed to parse stream chunk:', jsonData, error);
            }
          }
        }
      }
    } finally {
      reader.releaseLock();
    }
  }

  // ============================================================================
  // TOOL METHODS
  // ============================================================================

  /**
   * Format tools for OpenAI API
   * @param {Array<Object>} tools - Tool definitions
   * @returns {Array<Object>} Formatted tools
   */
  formatTools(tools) {
    return tools.map(tool => ({
      type: 'function',
      function: {
        name: tool.name,
        description: tool.description,
        parameters: tool.parameters
      }
    }));
  }

  /**
   * Parse tool calls from OpenAI response
   * @param {Object} message - OpenAI message with tool calls
   * @returns {Array<ToolCall>} Parsed tool calls
   */
  parseToolCalls(message) {
    if (!message.tool_calls) return [];
    
    return message.tool_calls.map(tc => {
      let args = {};
      try {
        args = JSON.parse(tc.function.arguments);
      } catch (error) {
        this.logger.warn('Failed to parse tool call arguments:', tc.function.arguments);
        args = {};
      }
      
      return new ToolCall(tc.id, tc.function.name, args);
    });
  }

  /**
   * Format tool execution results for OpenAI
   * @param {Array<ToolResult>} results - Tool execution results
   * @returns {Array<Object>} Formatted tool responses
   */
  formatToolResponses(results) {
    return results.map(result => ({
      role: 'tool',
      tool_call_id: result.toolCallId,
      name: result.name,
      content: result.isSuccess ? 
        (typeof result.result === 'string' ? result.result : JSON.stringify(result.result)) :
        `Error: ${result.error?.message || 'Tool execution failed'}`
    }));
  }

  // ============================================================================
  // MODEL INFORMATION METHODS
  // ============================================================================

  getAvailableModels() {
    return [...this.models];
  }

  getModelInfo(modelName) {
    if (!this.models.includes(modelName)) return null;
    
    const isVisionModel = modelName.includes('vision') || modelName.includes('gpt-4');
    const isTurbo = modelName.includes('turbo') || modelName.includes('1106') || modelName.includes('0125');
    
    return {
      id: modelName,
      name: modelName,
      provider: this.name,
      capabilities: {
        tools: true,
        images: isVisionModel,
        structuredOutput: isTurbo,
        streaming: true,
        systemMessages: true
      },
      limits: {
        maxTokens: this.getMaxOutputTokens(modelName),
        contextLength: this.getMaxContextLength(modelName)
      },
      pricing: this.getModelPricing(modelName)
    };
  }

  // ============================================================================
  // VALIDATION METHODS
  // ============================================================================

  validateConfig(config) {
    const validated = super.validateConfig(config);
    
    if (!Validator.validateApiKeyFormat(validated.apiKey, 'openai')) {
      throw new ConfigurationError(
        'Invalid OpenAI API key format. Key should start with "sk-"',
        'apiKey',
        this.name
      );
    }
    
    return validated;
  }

  // ============================================================================
  // HELPER METHODS
  // ============================================================================

  /**
   * Build HTTP request for OpenAI API
   * @param {Object} request - Validated request
   * @returns {Object} HTTP request configuration
   */
  buildHttpRequest(request) {
    const body = {
      model: request.model,
      messages: this.formatMessages(request.messages),
      stream: request.stream || false,
      temperature: request.temperature || 0.7
    };

    if (request.maxTokens) body.max_tokens = request.maxTokens;
    if (request.topP) body.top_p = request.topP;
    if (request.presencePenalty) body.presence_penalty = request.presencePenalty;
    if (request.frequencyPenalty) body.frequency_penalty = request.frequencyPenalty;
    if (request.stop) body.stop = request.stop;
    if (request.seed) body.seed = request.seed;

    // Handle tools
    if (request.tools && request.tools.length > 0) {
      body.tools = this.formatTools(request.tools);
      if (request.toolChoice) {
        if (typeof request.toolChoice === 'string') {
          body.tool_choice = request.toolChoice;
        } else if (request.toolChoice.type === 'function') {
          body.tool_choice = {
            type: 'function',
            function: { name: request.toolChoice.function.name }
          };
        }
      }
    }

    // Handle structured output
    if (request.responseFormat) {
      if (request.responseFormat.type === 'json_schema') {
        // Deep clone and enforce additionalProperties: false
        const schema = this.enforceSchemaConstraints(request.responseFormat.schema);
        body.response_format = {
          type: 'json_schema',
          json_schema: {
            name: 'response',
            schema,
            strict: true
          }
        };
      } else if (request.responseFormat.type === 'json_object') {
        body.response_format = { type: 'json_object' };
      }
    }

    return {
      url: `${this.baseURL}/chat/completions`,
      method: 'POST',
      headers: this.createHeaders(),
      body
    };
  }

  /**
   * Enforce schema constraints for structured output
   * @param {Object} schema - JSON schema
   * @returns {Object} Constrained schema
   */
  enforceSchemaConstraints(schema) {
    const cloned = JSON.parse(JSON.stringify(schema));
    
    const enforceConstraints = (node) => {
      if (node && typeof node === 'object') {
        if (node.type === 'object') {
          node.additionalProperties = false;
        }
        
        if (node.properties) {
          Object.values(node.properties).forEach(enforceConstraints);
        }
        
        if (node.items) {
          const items = Array.isArray(node.items) ? node.items : [node.items];
          items.forEach(enforceConstraints);
        }
      }
    };
    
    enforceConstraints(cloned);
    return cloned;
  }

  /**
   * Parse OpenAI message to standard format
   * @param {Object} openaiMessage - OpenAI message
   * @returns {Message} Standard message
   */
  parseMessage(openaiMessage) {
    const toolCalls = this.parseToolCalls(openaiMessage);
    
    return new Message(
      openaiMessage.role,
      openaiMessage.content || '',
      {
        toolCalls: toolCalls.length > 0 ? toolCalls : undefined,
        name: openaiMessage.name
      }
    );
  }

  /**
   * Parse OpenAI stream chunk
   * @param {Object} chunk - OpenAI chunk
   * @param {Object} originalRequest - Original request
   * @returns {ResponseChunk|null} Parsed chunk
   */
  parseStreamChunk(chunk, originalRequest) {
    if (!chunk.choices || chunk.choices.length === 0) return null;

    const choice = chunk.choices[0];
    const delta = choice.delta || {};
    
    const responseDelta = new ResponseDelta(
      delta.content || '',
      delta.tool_calls ? this.parseStreamToolCalls(delta.tool_calls) : null,
      delta.role
    );

    const choiceDelta = new ResponseChoiceDelta(
      choice.index || 0,
      responseDelta,
      this.normalizeFinishReason(choice.finish_reason)
    );

    const usage = chunk.usage ? new Usage(
      chunk.usage.prompt_tokens,
      chunk.usage.completion_tokens,
      chunk.usage.total_tokens
    ) : null;

    return new ResponseChunk({
      id: chunk.id,
      model: originalRequest.model,
      provider: this.name,
      choices: [choiceDelta],
      usage,
      done: !!choice.finish_reason
    });
  }

  /**
   * Parse streaming tool calls
   * @param {Array} toolCalls - OpenAI streaming tool calls
   * @returns {Array<ToolCall>} Parsed tool calls
   */
  parseStreamToolCalls(toolCalls) {
    return toolCalls.map(tc => {
      let args = {};
      if (tc.function && tc.function.arguments) {
        try {
          args = JSON.parse(tc.function.arguments);
        } catch {
          args = { _partial: tc.function.arguments };
        }
      }
      
      return new ToolCall(
        tc.id || '',
        tc.function?.name || '',
        args
      );
    });
  }

  /**
   * Normalize OpenAI finish reason to standard format
   * @param {string} reason - OpenAI finish reason
   * @returns {string|null} Normalized finish reason
   */
  normalizeFinishReason(reason) {
    if (!reason) return null;
    
    const mapping = {
      'stop': 'stop',
      'length': 'length',
      'tool_calls': 'tool_calls',
      'content_filter': 'content_filter'
    };
    
    return mapping[reason] || reason;
  }

  /**
   * Get pricing information for model
   * @param {string} modelName - Model name
   * @returns {Object|null} Pricing info
   */
  getModelPricing(modelName) {
    // Pricing as of 2024 (per 1M tokens)
    const pricing = {
      'gpt-4': { input: 30, output: 60 },
      'gpt-4-turbo': { input: 10, output: 30 },
      'gpt-4-turbo-preview': { input: 10, output: 30 },
      'gpt-4-0125-preview': { input: 10, output: 30 },
      'gpt-4-1106-preview': { input: 10, output: 30 },
      'gpt-4-vision-preview': { input: 10, output: 30 },
      'gpt-3.5-turbo': { input: 0.5, output: 1.5 },
      'gpt-3.5-turbo-16k': { input: 3, output: 4 },
      'gpt-3.5-turbo-1106': { input: 1, output: 2 },
      'gpt-3.5-turbo-0125': { input: 0.5, output: 1.5 }
    };
    
    return pricing[modelName] || null;
  }
}