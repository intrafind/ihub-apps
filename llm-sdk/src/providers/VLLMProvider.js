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
 * vLLM API provider implementation
 * vLLM provides an OpenAI-compatible API but with more restrictive JSON schema support
 */
export class VLLMProvider extends Provider {
  constructor(config) {
    super(config);
    this.baseURL = config.baseURL || config.url; // Support both baseURL and url
    this.models = this.initializeModels();
  }

  /**
   * Initialize available models
   * @returns {Array<string>} List of model names
   */
  initializeModels() {
    // VLLM models are highly configurable - these are common examples
    return [
      'local-llama-2-7b',
      'local-llama-2-13b',
      'local-codellama-34b',
      'local-mistral-7b',
      'local-mixtral-8x7b',
      'vicuna-7b-v1.5',
      'vicuna-13b-v1.5',
      'custom-model' // Generic fallback for custom models
    ];
  }

  // ============================================================================
  // CAPABILITY METHODS
  // ============================================================================

  supportsTools() {
    return true; // VLLM supports tool calling through OpenAI compatibility
  }

  supportsImages() {
    return true; // Some VLLM models support vision
  }

  supportsStructuredOutput() {
    return false; // VLLM has limited structured output support compared to OpenAI
  }

  supportsStreaming() {
    return true;
  }

  getMaxContextLength(model) {
    // Default context lengths - VLLM can be configured differently
    const contextLengths = {
      'local-llama-2-7b': 4096,
      'local-llama-2-13b': 4096,
      'local-codellama-34b': 16384,
      'local-mistral-7b': 32000,
      'local-mixtral-8x7b': 32000,
      'vicuna-7b-v1.5': 2048,
      'vicuna-13b-v1.5': 2048,
      'custom-model': 4096
    };
    return contextLengths[model] || 4096;
  }

  getMaxOutputTokens(model) {
    return 2048; // Conservative default for VLLM models
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

      // Handle VLLM error responses
      if (responseData.error) {
        throw new ProviderError(
          responseData.error.message || 'VLLM API error',
          this.name,
          responseData.error.code,
          responseData.error
        );
      }

      return this.parseResponse(responseData, validatedRequest);
    } catch (error) {
      this.logger.error('VLLM chat request failed:', error);
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
      this.logger.error('VLLM stream request failed:', error);
      throw error;
    }
  }

  /**
   * Format messages for VLLM API (OpenAI-compatible)
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
                url:
                  part.data.url ||
                  `data:${part.data.mimeType || 'image/jpeg'};base64,${part.data.base64}`,
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

      // Handle empty content for tool calls (VLLM compatibility)
      if (formatted.tool_calls && (formatted.content === undefined || formatted.content === '')) {
        formatted.content = null;
      }

      return formatted;
    });
  }

  /**
   * Parse VLLM response to standard format
   * @param {Object} response - VLLM response
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

              // Handle VLLM error in stream
              if (parsed.error) {
                throw new ProviderError(
                  parsed.error.message || 'VLLM streaming error',
                  this.name,
                  parsed.error.code,
                  parsed.error
                );
              }

              const chunk = this.parseStreamChunk(parsed, originalRequest);
              if (chunk) {
                yield chunk;
              }
            } catch (error) {
              if (error instanceof ProviderError) throw error;
              this.logger.warn('Failed to parse VLLM stream chunk:', jsonData, error);
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
   * Format tools for VLLM API with schema sanitization
   * @param {Array<Object>} tools - Tool definitions
   * @returns {Array<Object>} Formatted tools with sanitized schemas
   */
  formatTools(tools) {
    return tools.map(tool => ({
      type: 'function',
      function: {
        name: tool.name,
        description: tool.description,
        parameters: this.sanitizeSchema(tool.parameters)
      }
    }));
  }

  /**
   * Sanitize JSON schema for VLLM compatibility
   * VLLM has more restrictive schema support than OpenAI
   * @param {Object} schema - Original JSON schema
   * @returns {Object} Sanitized schema
   */
  sanitizeSchema(schema) {
    const sanitized = JSON.parse(JSON.stringify(schema));

    const sanitizeNode = node => {
      if (node && typeof node === 'object') {
        // Remove unsupported schema features
        delete node.additionalProperties;
        delete node.patternProperties;
        delete node.dependencies;
        delete node.allOf;
        delete node.anyOf;
        delete node.oneOf;
        delete node.not;
        delete node.$ref;
        delete node.format; // Some formats may not be supported

        // Recursively sanitize nested objects
        if (node.properties) {
          Object.values(node.properties).forEach(sanitizeNode);
        }

        if (node.items) {
          const items = Array.isArray(node.items) ? node.items : [node.items];
          items.forEach(sanitizeNode);
        }
      }
    };

    sanitizeNode(sanitized);
    return sanitized;
  }

  /**
   * Parse tool calls from VLLM response
   * @param {Object} message - VLLM message with tool calls
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
   * Format tool execution results for VLLM
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
    if (!this.models.includes(modelName) && modelName !== 'custom-model') {
      // For custom models not in our list, provide basic info
      if (this.baseURL && !this.models.includes(modelName)) {
        return this.getCustomModelInfo(modelName);
      }
      return null;
    }

    const isVisionCapable = modelName.includes('vision') || modelName.includes('llava');
    const isCodeModel = modelName.includes('code') || modelName.includes('codellama');

    return {
      id: modelName,
      name: modelName,
      provider: this.name,
      capabilities: {
        tools: true,
        images: isVisionCapable,
        structuredOutput: false, // Limited in VLLM
        streaming: true,
        systemMessages: true,
        codeGeneration: isCodeModel
      },
      limits: {
        maxTokens: this.getMaxOutputTokens(modelName),
        contextLength: this.getMaxContextLength(modelName)
      },
      pricing: null // Custom/local models typically don't have pricing
    };
  }

  /**
   * Get info for custom VLLM models
   * @param {string} modelName - Custom model name
   * @returns {Object} Model info
   */
  getCustomModelInfo(modelName) {
    return {
      id: modelName,
      name: modelName,
      provider: this.name,
      capabilities: {
        tools: true,
        images: false, // Conservative default
        structuredOutput: false,
        streaming: true,
        systemMessages: true
      },
      limits: {
        maxTokens: 2048,
        contextLength: 4096
      },
      pricing: null
    };
  }

  // ============================================================================
  // VALIDATION METHODS
  // ============================================================================

  validateConfig(config) {
    const validated = super.validateConfig(config);

    if (!validated.baseURL && !validated.url) {
      throw new ConfigurationError(
        'VLLM requires either baseURL or url configuration',
        'baseURL',
        this.name
      );
    }

    // VLLM often doesn't require API keys for local deployments
    if (!validated.apiKey) {
      this.logger.info('No API key provided for VLLM - assuming local deployment');
      validated.apiKey = 'no-key-required'; // Placeholder
    }

    return validated;
  }

  // ============================================================================
  // HELPER METHODS
  // ============================================================================

  /**
   * Build HTTP request for VLLM API
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
    if (request.presencePenalty) body.presence_penalty = request.presencePenalty;
    if (request.frequencyPenalty) body.frequency_penalty = request.frequencyPenalty;
    if (request.stop) body.stop = request.stop;
    if (request.seed) body.seed = request.seed;

    // Handle tools with VLLM-specific processing
    if (request.tools && request.tools.length > 0) {
      body.tools = this.formatTools(request.tools);

      // VLLM tool choice handling
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

    // Limited response format support for VLLM
    if (request.responseFormat?.type === 'json_object') {
      body.response_format = { type: 'json_object' };
      // Note: VLLM may not support structured output schemas
    }

    // Ensure we have a valid endpoint URL
    const baseUrl = this.baseURL.endsWith('/') ? this.baseURL.slice(0, -1) : this.baseURL;
    const endpoint = baseUrl.includes('/chat/completions')
      ? baseUrl
      : `${baseUrl}/v1/chat/completions`;

    return {
      url: endpoint,
      method: 'POST',
      headers: this.createHeaders(),
      body
    };
  }

  /**
   * Create headers for VLLM requests
   * @returns {Object} Request headers
   */
  createHeaders() {
    const headers = {
      'Content-Type': 'application/json'
    };

    // Only add authorization if we have a real API key
    if (this.config.apiKey && this.config.apiKey !== 'no-key-required') {
      headers.Authorization = `Bearer ${this.config.apiKey}`;
    }

    return headers;
  }

  /**
   * Parse VLLM message to standard format
   * @param {Object} vllmMessage - VLLM message
   * @returns {Message} Standard message
   */
  parseMessage(vllmMessage) {
    const toolCalls = this.parseToolCalls(vllmMessage);

    return new Message(vllmMessage.role, vllmMessage.content || '', {
      toolCalls: toolCalls.length > 0 ? toolCalls : undefined,
      name: vllmMessage.name
    });
  }

  /**
   * Parse VLLM stream chunk
   * @param {Object} chunk - VLLM chunk
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
   * @param {Array} toolCalls - VLLM streaming tool calls
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
   * Normalize VLLM finish reason to standard format
   * @param {string} reason - VLLM finish reason
   * @returns {string|null} Normalized finish reason
   */
  normalizeFinishReason(reason) {
    if (!reason) return null;

    // VLLM follows OpenAI format mostly
    const mapping = {
      stop: 'stop',
      length: 'length',
      tool_calls: 'tool_calls',
      content_filter: 'content_filter'
    };

    return mapping[reason] || reason;
  }
}
