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
import { ConfigurationError, ProviderError } from '../utils/ErrorHandler.js';
import { Validator } from '../utils/Validator.js';

/**
 * Anthropic (Claude) provider implementation
 */
export class AnthropicProvider extends Provider {
  constructor(config) {
    super(config);
    this.baseURL = config.baseURL || 'https://api.anthropic.com/v1';
    this.models = this.initializeModels();
    this.apiVersion = config.apiVersion || '2023-06-01';
  }

  /**
   * Initialize available models
   * @returns {Array<string>} List of model names
   */
  initializeModels() {
    return [
      'claude-3-5-sonnet-20241022',
      'claude-3-5-sonnet-20240620',
      'claude-3-5-haiku-20241022',
      'claude-3-opus-20240229',
      'claude-3-sonnet-20240229',
      'claude-3-haiku-20240307'
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
    return true; // Via tool calling
  }

  supportsStreaming() {
    return true;
  }

  getMaxContextLength(model) {
    const contextLengths = {
      'claude-3-5-sonnet-20241022': 200000,
      'claude-3-5-sonnet-20240620': 200000,
      'claude-3-5-haiku-20241022': 200000,
      'claude-3-opus-20240229': 200000,
      'claude-3-sonnet-20240229': 200000,
      'claude-3-haiku-20240307': 200000
    };
    return contextLengths[model] || 100000;
  }

  getMaxOutputTokens(model) {
    // All Claude 3 models support up to 4096 output tokens
    return 4096;
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
      this.logger.error('Anthropic chat request failed:', error);
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
      this.logger.error('Anthropic stream request failed:', error);
      throw error;
    }
  }

  /**
   * Format messages for Anthropic API
   * @param {Array<Message>} messages - Messages to format
   * @returns {Object} Formatted messages and system prompt
   */
  formatMessages(messages) {
    // Separate system message from conversation messages
    const systemMessages = messages.filter(msg => msg.role === 'system');
    const conversationMessages = messages.filter(msg => msg.role !== 'system');

    const systemPrompt = systemMessages.map(msg => msg.content).join('\n\n');

    const formattedMessages = [];

    for (const message of conversationMessages) {
      if (message.role === 'tool') {
        // Convert tool response to user message with tool result
        formattedMessages.push({
          role: 'user',
          content: [
            {
              type: 'tool_result',
              tool_use_id: message.toolCallId,
              content:
                typeof message.content === 'string'
                  ? message.content
                  : JSON.stringify(message.content),
              is_error: message.isError || false
            }
          ]
        });
      } else if (message.role === 'assistant' && message.hasToolCalls()) {
        // Format assistant message with tool calls
        const content = [];

        // Add text content if present
        if (message.content && message.content.trim()) {
          content.push({
            type: 'text',
            text: message.content
          });
        }

        // Add tool use blocks
        for (const toolCall of message.toolCalls) {
          content.push({
            type: 'tool_use',
            id: toolCall.id,
            name: toolCall.name,
            input: toolCall.arguments
          });
        }

        formattedMessages.push({
          role: 'assistant',
          content
        });
      } else if (message.hasImages()) {
        // Handle image content
        const content = [];

        if (Array.isArray(message.content)) {
          for (const part of message.content) {
            if (part.type === 'text') {
              content.push({
                type: 'text',
                text: part.data.text
              });
            } else if (part.type === 'image') {
              const imageData = part.data;
              content.push({
                type: 'image',
                source: {
                  type: 'base64',
                  media_type: imageData.mimeType || 'image/jpeg',
                  data: this.cleanBase64Data(imageData.base64 || imageData.url)
                }
              });
            }
          }
        } else {
          // Add text content
          if (message.content) {
            content.push({
              type: 'text',
              text: message.content
            });
          }

          // This case should not happen with proper Message construction,
          // but handle it for robustness
        }

        formattedMessages.push({
          role: message.role,
          content
        });
      } else {
        // Simple text message
        formattedMessages.push({
          role: message.role,
          content: message.content || ''
        });
      }
    }

    return {
      messages: formattedMessages,
      systemPrompt
    };
  }

  /**
   * Parse Anthropic response to standard format
   * @param {Object} response - Anthropic response
   * @param {Object} originalRequest - Original request
   * @returns {Response} Standardized response
   */
  parseResponse(response, originalRequest) {
    const message = this.parseAnthropicMessage(response);
    const choice = new ResponseChoice(
      0, // Anthropic only returns one choice
      message,
      this.normalizeFinishReason(response.stop_reason)
    );

    const usage = new Usage(response.usage?.input_tokens || 0, response.usage?.output_tokens || 0);

    return new Response({
      id: response.id,
      model: originalRequest.model,
      provider: this.name,
      choices: [choice],
      usage,
      metadata: {
        stopSequence: response.stop_sequence,
        role: response.role
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

    // Tool call aggregation state
    const toolCallsState = new Map();
    let messageId = null;
    let currentContent = '';

    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split('\n');
        buffer = lines.pop() || '';

        for (const line of lines) {
          const trimmedLine = line.trim();
          if (trimmedLine === '' || !trimmedLine.startsWith('data: ')) continue;

          const jsonData = trimmedLine.slice(6);
          if (jsonData === '[DONE]') continue;

          try {
            const parsed = JSON.parse(jsonData);
            const chunk = this.parseStreamChunk(parsed, originalRequest, toolCallsState, {
              messageId,
              currentContent
            });

            if (chunk) {
              // Update state
              if (parsed.message?.id) messageId = parsed.message.id;
              if (chunk.content) currentContent += chunk.content;

              yield chunk;
            }
          } catch (error) {
            this.logger.warn('Failed to parse Anthropic stream chunk:', jsonData, error);
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
   * Format tools for Anthropic API
   * @param {Array<Object>} tools - Tool definitions
   * @returns {Array<Object>} Formatted tools
   */
  formatTools(tools) {
    return tools.map(tool => ({
      name: tool.name,
      description: tool.description,
      input_schema: tool.parameters
    }));
  }

  /**
   * Parse tool calls from Anthropic response
   * @param {Array} content - Anthropic content array
   * @returns {Array<ToolCall>} Parsed tool calls
   */
  parseToolCalls(content) {
    if (!Array.isArray(content)) return [];

    return content
      .filter(item => item.type === 'tool_use')
      .map(item => new ToolCall(item.id, item.name, item.input || {}));
  }

  /**
   * Format tool execution results for Anthropic
   * @param {Array<ToolResult>} results - Tool execution results
   * @returns {Array<Object>} Formatted tool responses
   */
  formatToolResponses(results) {
    return results.map(result => ({
      role: 'user',
      content: [
        {
          type: 'tool_result',
          tool_use_id: result.toolCallId,
          content: result.isSuccess
            ? typeof result.result === 'string'
              ? result.result
              : JSON.stringify(result.result)
            : `Error: ${result.error?.message || 'Tool execution failed'}`,
          is_error: !result.isSuccess
        }
      ]
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

    const isHaiku = modelName.includes('haiku');
    const isSonnet = modelName.includes('sonnet');
    const isOpus = modelName.includes('opus');

    return {
      id: modelName,
      name: modelName,
      provider: this.name,
      capabilities: {
        tools: true,
        images: true,
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

    if (!Validator.validateApiKeyFormat(validated.apiKey, 'anthropic')) {
      throw new ConfigurationError(
        'Invalid Anthropic API key format. Key should start with "sk-ant-"',
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
   * Build HTTP request for Anthropic API
   * @param {Object} request - Validated request
   * @returns {Object} HTTP request configuration
   */
  buildHttpRequest(request) {
    const { messages, systemPrompt } = this.formatMessages(request.messages);

    const body = {
      model: request.model,
      messages,
      stream: request.stream || false,
      temperature: request.temperature || 0.7,
      max_tokens: request.maxTokens || 4096
    };

    // Add system prompt if present
    if (systemPrompt) {
      body.system = systemPrompt;
    }

    // Handle tools
    let finalTools = request.tools ? [...request.tools] : [];

    // Add structured output as a tool if requested
    if (request.responseFormat && request.responseFormat.type === 'json_schema') {
      finalTools.push({
        name: 'json_response',
        description: 'Respond with a JSON object that matches the required schema.',
        parameters: request.responseFormat.schema
      });
      body.tool_choice = { type: 'tool', name: 'json_response' };
    }

    if (finalTools.length > 0) {
      body.tools = this.formatTools(finalTools);

      if (request.toolChoice && !body.tool_choice) {
        if (typeof request.toolChoice === 'string') {
          if (request.toolChoice === 'auto') {
            body.tool_choice = { type: 'auto' };
          } else if (request.toolChoice === 'none') {
            // Don't set tool_choice, Anthropic will not use tools
          }
        } else if (request.toolChoice.type === 'function') {
          body.tool_choice = {
            type: 'tool',
            name: request.toolChoice.function.name
          };
        }
      }
    }

    // Stop sequences
    if (request.stop) {
      body.stop_sequences = Array.isArray(request.stop) ? request.stop : [request.stop];
    }

    // Top-p
    if (request.topP) {
      body.top_p = request.topP;
    }

    return {
      url: `${this.baseURL}/messages`,
      method: 'POST',
      headers: this.createAnthropicHeaders(),
      body
    };
  }

  /**
   * Create Anthropic-specific headers
   * @returns {Object} Headers
   */
  createAnthropicHeaders() {
    return {
      'Content-Type': 'application/json',
      'x-api-key': this.config.apiKey,
      'anthropic-version': this.apiVersion,
      'User-Agent': 'llm-sdk/1.0.0'
    };
  }

  /**
   * Parse Anthropic message to standard format
   * @param {Object} anthropicResponse - Anthropic response
   * @returns {Message} Standard message
   */
  parseAnthropicMessage(anthropicResponse) {
    const content = anthropicResponse.content;
    let textContent = '';
    const toolCalls = [];

    if (Array.isArray(content)) {
      for (const item of content) {
        if (item.type === 'text') {
          textContent += item.text;
        } else if (item.type === 'tool_use') {
          toolCalls.push(new ToolCall(item.id, item.name, item.input || {}));
        }
      }
    }

    return new Message('assistant', textContent, {
      toolCalls: toolCalls.length > 0 ? toolCalls : undefined
    });
  }

  /**
   * Parse Anthropic stream chunk
   * @param {Object} chunk - Anthropic chunk
   * @param {Object} originalRequest - Original request
   * @param {Map} toolCallsState - Tool calls aggregation state
   * @param {Object} messageState - Message state
   * @returns {ResponseChunk|null} Parsed chunk
   */
  parseStreamChunk(chunk, originalRequest, toolCallsState, messageState) {
    let content = '';
    let finishReason = null;
    let toolCalls = [];

    switch (chunk.type) {
      case 'message_start':
        messageState.messageId = chunk.message.id;
        break;

      case 'content_block_delta':
        if (chunk.delta?.text) {
          content = chunk.delta.text;
        } else if (chunk.delta?.type === 'input_json_delta') {
          // Handle partial tool call arguments
          const index = chunk.index;
          if (!toolCallsState.has(index)) {
            toolCallsState.set(index, { arguments: '' });
          }
          toolCallsState.get(index).arguments += chunk.delta.partial_json || '';
        }
        break;

      case 'content_block_start':
        if (chunk.content_block?.type === 'tool_use') {
          const toolBlock = chunk.content_block;
          toolCallsState.set(chunk.index, {
            id: toolBlock.id,
            name: toolBlock.name,
            arguments: ''
          });
        }
        break;

      case 'message_delta':
        if (chunk.delta?.stop_reason) {
          finishReason = this.normalizeFinishReason(chunk.delta.stop_reason);
        }
        break;

      case 'message_stop':
        finishReason = finishReason || 'stop';
        // Convert accumulated tool calls
        for (const [index, toolData] of toolCallsState.entries()) {
          let args = {};
          try {
            args = JSON.parse(toolData.arguments);
          } catch {
            args = { _partial: toolData.arguments };
          }
          toolCalls.push(new ToolCall(toolData.id, toolData.name, args));
        }
        break;

      default:
        // Ignore other event types
        return null;
    }

    if (content || toolCalls.length > 0 || finishReason) {
      const responseDelta = new ResponseDelta(content, toolCalls.length > 0 ? toolCalls : null);
      const choiceDelta = new ResponseChoiceDelta(0, responseDelta, finishReason);

      return new ResponseChunk({
        id: messageState.messageId,
        model: originalRequest.model,
        provider: this.name,
        choices: [choiceDelta],
        done: !!finishReason
      });
    }

    return null;
  }

  /**
   * Normalize Anthropic finish reason to standard format
   * @param {string} reason - Anthropic stop reason
   * @returns {string|null} Normalized finish reason
   */
  normalizeFinishReason(reason) {
    if (!reason) return null;

    const mapping = {
      end_turn: 'stop',
      max_tokens: 'length',
      tool_use: 'tool_calls',
      stop_sequence: 'stop'
    };

    return mapping[reason] || reason;
  }

  /**
   * Clean base64 data by removing data URL prefix
   * @param {string} base64Data - Base64 string potentially with prefix
   * @returns {string} Clean base64 data
   */
  cleanBase64Data(base64Data) {
    if (typeof base64Data !== 'string') return '';
    return base64Data.replace(/^data:[^;]+;base64,/, '');
  }

  /**
   * Get pricing information for model
   * @param {string} modelName - Model name
   * @returns {Object|null} Pricing info
   */
  getModelPricing(modelName) {
    // Pricing as of 2024 (per 1M tokens)
    const pricing = {
      'claude-3-5-sonnet-20241022': { input: 3, output: 15 },
      'claude-3-5-sonnet-20240620': { input: 3, output: 15 },
      'claude-3-5-haiku-20241022': { input: 0.8, output: 4 },
      'claude-3-opus-20240229': { input: 15, output: 75 },
      'claude-3-sonnet-20240229': { input: 3, output: 15 },
      'claude-3-haiku-20240307': { input: 0.25, output: 1.25 }
    };

    return pricing[modelName] || null;
  }
}
