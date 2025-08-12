import { Provider } from '../core/Provider.js';
import { Message, ToolCall } from '../core/Message.js';
import {
  Response,
  ResponseChoice,
  ResponseChunk,
  ResponseChoiceDelta,
  ResponseDelta,
  Usage
} from '../core/Response.js';
import { ConfigurationError, ProviderError, NetworkError } from '../utils/ErrorHandler.js';
import { Validator } from '../utils/Validator.js';

/**
 * Mistral "La Plateforme" API provider implementation
 */
export class MistralProvider extends Provider {
  constructor(config) {
    super(config);
    this.baseURL = config.baseURL || 'https://api.mistral.ai/v1';
    this.models = this.initializeModels();
  }

  /**
   * Initialize available models
   * @returns {Array<string>} List of model names
   */
  initializeModels() {
    return [
      'mistral-tiny',
      'mistral-small',
      'mistral-small-latest',
      'mistral-medium',
      'mistral-medium-latest',
      'mistral-large',
      'mistral-large-latest',
      'open-mistral-7b',
      'open-mixtral-8x7b',
      'open-mixtral-8x22b'
    ];
  }

  // ============================================================================
  // CAPABILITY METHODS
  // ============================================================================

  supportsTools() {
    return true;
  }

  supportsImages() {
    return true; // Some Mistral models support vision
  }

  supportsStructuredOutput() {
    return true; // JSON schema support
  }

  supportsStreaming() {
    return true;
  }

  getMaxContextLength(model) {
    const contextLengths = {
      'mistral-tiny': 32000,
      'mistral-small': 32000,
      'mistral-small-latest': 32000,
      'mistral-medium': 32000,
      'mistral-medium-latest': 32000,
      'mistral-large': 32000,
      'mistral-large-latest': 32000,
      'open-mistral-7b': 32000,
      'open-mixtral-8x7b': 32000,
      'open-mixtral-8x22b': 64000
    };
    return contextLengths[model] || 32000;
  }

  getMaxOutputTokens(model) {
    return 4096; // Standard max output for Mistral models
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
      this.logger.error('Mistral chat request failed:', error);
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
      this.logger.error('Mistral stream request failed:', error);
      throw error;
    }
  }

  /**
   * Format messages for Mistral API
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
        // Check if contains image data
        const hasImage = message.content.some(part => part.type === 'image');
        if (hasImage) {
          formatted.content = message.content.map(part => {
            if (part.type === 'text') {
              return { type: 'text', text: part.data.text };
            } else if (part.type === 'image') {
              return {
                type: 'image_url',
                image_url: {
                  url:
                    part.data.url ||
                    `data:${part.data.mimeType || 'image/jpeg'};base64,${part.data.base64}`,
                  detail: 'high'
                }
              };
            }
            return part;
          });
        } else {
          // Text-only content array, join as string
          formatted.content = message.content
            .filter(part => part.type === 'text')
            .map(part => part.data.text)
            .join('');
        }
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
   * Parse Mistral response to standard format
   * @param {Object} response - Mistral response
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

    const usage = response.usage
      ? new Usage(
          response.usage.prompt_tokens,
          response.usage.completion_tokens,
          response.usage.total_tokens
        )
      : new Usage();

    return new Response({
      id: response.id,
      model: originalRequest.model,
      provider: this.name,
      choices,
      usage,
      metadata: {
        created: response.created,
        object: response.object
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
  async *parseStreamResponse(response, originalRequest) {
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
              this.logger.warn('Failed to parse Mistral stream chunk:', jsonData, error);
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
   * Format tools for Mistral API
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
   * Parse tool calls from Mistral response
   * @param {Object} message - Mistral message with tool calls
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
   * Format tool execution results for Mistral
   * @param {Array<ToolResult>} results - Tool execution results
   * @returns {Array<Object>} Formatted tool responses
   */
  formatToolResponses(results) {
    return results.map(result => ({
      role: 'tool',
      tool_call_id: result.toolCallId,
      name: result.name,
      content: result.isSuccess
        ? typeof result.result === 'string'
          ? result.result
          : JSON.stringify(result.result)
        : `Error: ${result.error?.message || 'Tool execution failed'}`
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

    const isVisionCapable = modelName.includes('large') || modelName.includes('medium');

    return {
      id: modelName,
      name: modelName,
      provider: this.name,
      capabilities: {
        tools: true,
        images: isVisionCapable,
        structuredOutput: true,
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

    if (!validated.apiKey) {
      throw new ConfigurationError('Mistral API key is required', 'apiKey', this.name);
    }

    return validated;
  }

  // ============================================================================
  // HELPER METHODS
  // ============================================================================

  /**
   * Build HTTP request for Mistral API
   * @param {Object} request - Validated request
   * @returns {Object} HTTP request configuration
   */
  buildHttpRequest(request) {
    const body = {
      model: request.model,
      messages: this.formatMessages(request.messages),
      stream: request.stream || false,
      temperature: parseFloat(request.temperature || 0.7),
      max_tokens: request.maxTokens
    };

    if (request.topP) body.top_p = request.topP;
    if (request.stop) body.stop = request.stop;
    if (request.seed) body.random_seed = request.seed;

    // Handle tools
    if (request.tools && request.tools.length > 0) {
      body.tools = this.formatTools(request.tools);
      if (request.toolChoice) {
        body.tool_choice = request.toolChoice;
      }
    }

    // Handle structured output (JSON schema)
    if (request.responseFormat) {
      if (request.responseFormat.type === 'json_schema') {
        body.response_format = {
          type: 'json_schema',
          json_schema: {
            schema: request.responseFormat.schema,
            name: 'response',
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
   * Parse Mistral message to standard format
   * @param {Object} mistralMessage - Mistral message
   * @returns {Message} Standard message
   */
  parseMessage(mistralMessage) {
    const toolCalls = this.parseToolCalls(mistralMessage);

    // Handle complex content format from Mistral
    let content = mistralMessage.content;
    if (Array.isArray(content)) {
      // Extract text content from array format
      content = content
        .filter(part => part.type === 'text' || typeof part === 'string')
        .map(part => (typeof part === 'string' ? part : part.text))
        .join('');
    }

    return new Message(mistralMessage.role, content || '', {
      toolCalls: toolCalls.length > 0 ? toolCalls : undefined,
      name: mistralMessage.name
    });
  }

  /**
   * Parse Mistral stream chunk
   * @param {Object} chunk - Mistral chunk
   * @param {Object} originalRequest - Original request
   * @returns {ResponseChunk|null} Parsed chunk
   */
  parseStreamChunk(chunk, originalRequest) {
    if (!chunk.choices || chunk.choices.length === 0) return null;

    const choice = chunk.choices[0];
    const delta = choice.delta || {};

    // Handle complex delta content format
    let deltaContent = '';
    if (delta.content) {
      if (Array.isArray(delta.content)) {
        deltaContent = delta.content
          .filter(part => part.type === 'text' || typeof part === 'string')
          .map(part => (typeof part === 'string' ? part : part.text))
          .join('');
      } else if (typeof delta.content === 'object' && delta.content.type === 'text') {
        deltaContent = delta.content.text;
      } else {
        deltaContent = delta.content || '';
      }
    }

    const responseDelta = new ResponseDelta(
      deltaContent,
      delta.tool_calls ? this.parseStreamToolCalls(delta.tool_calls) : null,
      delta.role
    );

    const choiceDelta = new ResponseChoiceDelta(
      choice.index || 0,
      responseDelta,
      this.normalizeFinishReason(choice.finish_reason)
    );

    const usage = chunk.usage
      ? new Usage(
          chunk.usage.prompt_tokens,
          chunk.usage.completion_tokens,
          chunk.usage.total_tokens
        )
      : null;

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
   * @param {Array} toolCalls - Mistral streaming tool calls
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

      return new ToolCall(tc.id || '', tc.function?.name || '', args);
    });
  }

  /**
   * Normalize Mistral finish reason to standard format
   * @param {string} reason - Mistral finish reason
   * @returns {string|null} Normalized finish reason
   */
  normalizeFinishReason(reason) {
    if (!reason) return null;

    const mapping = {
      stop: 'stop',
      length: 'length',
      tool_calls: 'tool_calls',
      content_filter: 'content_filter'
    };

    return mapping[reason] || reason;
  }

  /**
   * Get pricing information for model
   * @param {string} modelName - Model name
   * @returns {Object|null} Pricing info
   */
  getModelPricing(modelName) {
    // Mistral pricing as of 2024 (per 1M tokens)
    const pricing = {
      'mistral-tiny': { input: 0.25, output: 0.25 },
      'mistral-small': { input: 2, output: 6 },
      'mistral-small-latest': { input: 2, output: 6 },
      'mistral-medium': { input: 2.7, output: 8.1 },
      'mistral-medium-latest': { input: 2.7, output: 8.1 },
      'mistral-large': { input: 8, output: 24 },
      'mistral-large-latest': { input: 8, output: 24 },
      'open-mistral-7b': { input: 0.25, output: 0.25 },
      'open-mixtral-8x7b': { input: 0.7, output: 0.7 },
      'open-mixtral-8x22b': { input: 2, output: 6 }
    };

    return pricing[modelName] || null;
  }
}
