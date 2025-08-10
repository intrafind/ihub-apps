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

/**
 * Google Gemini provider implementation
 */
export class GoogleProvider extends Provider {
  constructor(config) {
    super(config);
    this.baseURL = config.baseURL || 'https://generativelanguage.googleapis.com/v1beta';
    this.models = this.initializeModels();
  }

  /**
   * Initialize available models
   * @returns {Array<string>} List of model names
   */
  initializeModels() {
    return [
      'gemini-1.5-pro',
      'gemini-1.5-flash',
      'gemini-1.0-pro',
      'gemini-pro',
      'gemini-pro-vision'
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
    return false; // Google doesn't have native structured output yet
  }

  supportsStreaming() {
    return true;
  }

  getMaxContextLength(model) {
    const contextLengths = {
      'gemini-1.5-pro': 2000000,
      'gemini-1.5-flash': 1000000,
      'gemini-1.0-pro': 32768,
      'gemini-pro': 32768,
      'gemini-pro-vision': 16384
    };
    return contextLengths[model] || 32768;
  }

  getMaxOutputTokens(model) {
    return 8192;
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
      this.logger.error('Google chat request failed:', error);
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
    const httpRequest = this.buildHttpRequest(validatedRequest, true);

    try {
      const response = await this.makeRequest(httpRequest.url, {
        method: httpRequest.method,
        headers: httpRequest.headers,
        body: JSON.stringify(httpRequest.body)
      });

      return this.parseStreamResponse(response, validatedRequest);
    } catch (error) {
      this.logger.error('Google stream request failed:', error);
      throw error;
    }
  }

  /**
   * Format messages for Google API
   * @param {Array<Message>} messages - Messages to format
   * @returns {Object} Formatted messages and system instruction
   */
  formatMessages(messages) {
    // Separate system messages
    const systemMessages = messages.filter(msg => msg.role === 'system');
    const conversationMessages = messages.filter(msg => msg.role !== 'system');

    const systemInstruction = systemMessages
      .map(msg => ({ text: msg.content }))
      .reduce((acc, curr) => acc.concat(curr), []);

    const contents = [];

    for (const message of conversationMessages) {
      const role = this.mapRole(message.role);
      const parts = [];

      if (message.role === 'tool') {
        // Tool response
        parts.push({
          functionResponse: {
            name: message.name,
            response: {
              name: message.name,
              content:
                typeof message.content === 'string'
                  ? message.content
                  : JSON.stringify(message.content)
            }
          }
        });
      } else if (message.hasImages()) {
        // Handle multimodal content
        if (Array.isArray(message.content)) {
          for (const part of message.content) {
            if (part.type === 'text') {
              parts.push({ text: part.data.text });
            } else if (part.type === 'image') {
              const imageData = part.data;
              if (imageData.url) {
                parts.push({
                  fileData: {
                    mimeType: 'image/jpeg',
                    fileUri: imageData.url
                  }
                });
              } else if (imageData.base64) {
                parts.push({
                  inlineData: {
                    mimeType: imageData.mimeType || 'image/jpeg',
                    data: this.cleanBase64Data(imageData.base64)
                  }
                });
              }
            }
          }
        }
      } else {
        // Text content
        if (message.content) {
          parts.push({ text: message.content });
        }

        // Tool calls
        if (message.hasToolCalls()) {
          for (const toolCall of message.toolCalls) {
            parts.push({
              functionCall: {
                name: toolCall.name,
                args: toolCall.arguments
              }
            });
          }
        }
      }

      if (parts.length > 0) {
        contents.push({ role, parts });
      }
    }

    return { contents, systemInstruction };
  }

  /**
   * Parse Google response to standard format
   * @param {Object} response - Google response
   * @param {Object} originalRequest - Original request
   * @returns {Response} Standardized response
   */
  parseResponse(response, originalRequest) {
    if (!response.candidates || response.candidates.length === 0) {
      throw new ProviderError('No candidates in Google response', null, this.name);
    }

    const choices = response.candidates.map((candidate, index) => {
      const message = this.parseGoogleMessage(candidate);
      const finishReason = this.normalizeFinishReason(candidate.finishReason);

      return new ResponseChoice(index, message, finishReason);
    });

    const usage = this.parseUsage(response.usageMetadata);

    return new Response({
      id: this.generateResponseId(),
      model: originalRequest.model,
      provider: this.name,
      choices,
      usage,
      metadata: {
        safetyRatings: response.candidates[0]?.safetyRatings
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
          if (trimmedLine === '' || !trimmedLine.startsWith('data: ')) continue;

          const jsonData = trimmedLine.slice(6);
          if (jsonData === '[DONE]') continue;

          try {
            const parsed = JSON.parse(jsonData);
            const chunk = this.parseStreamChunk(parsed, originalRequest);
            if (chunk) {
              yield chunk;
            }
          } catch (error) {
            this.logger.warn('Failed to parse Google stream chunk:', jsonData, error);
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
   * Format tools for Google API
   * @param {Array<Object>} tools - Tool definitions
   * @returns {Array<Object>} Formatted tools
   */
  formatTools(tools) {
    return [
      {
        functionDeclarations: tools.map(tool => ({
          name: tool.name,
          description: tool.description,
          parameters: tool.parameters
        }))
      }
    ];
  }

  /**
   * Parse tool calls from Google response
   * @param {Array} parts - Google message parts
   * @returns {Array<ToolCall>} Parsed tool calls
   */
  parseToolCalls(parts) {
    if (!Array.isArray(parts)) return [];

    return parts
      .filter(part => part.functionCall)
      .map(
        (part, index) =>
          new ToolCall(
            `call_${Date.now()}_${index}`, // Google doesn't provide IDs
            part.functionCall.name,
            part.functionCall.args || {}
          )
      );
  }

  /**
   * Format tool execution results for Google
   * @param {Array<ToolResult>} results - Tool execution results
   * @returns {Array<Object>} Formatted tool responses
   */
  formatToolResponses(results) {
    return results.map(result => ({
      role: 'function',
      parts: [
        {
          functionResponse: {
            name: result.name,
            response: {
              name: result.name,
              content: result.isSuccess
                ? typeof result.result === 'string'
                  ? result.result
                  : JSON.stringify(result.result)
                : `Error: ${result.error?.message || 'Tool execution failed'}`
            }
          }
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

    const isVision = modelName.includes('vision');
    const isPro = modelName.includes('pro');

    return {
      id: modelName,
      name: modelName,
      provider: this.name,
      capabilities: {
        tools: true,
        images: true,
        structuredOutput: false,
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
  // HELPER METHODS
  // ============================================================================

  /**
   * Build HTTP request for Google API
   * @param {Object} request - Validated request
   * @param {boolean} streaming - Whether to use streaming endpoint
   * @returns {Object} HTTP request configuration
   */
  buildHttpRequest(request, streaming = false) {
    const { contents, systemInstruction } = this.formatMessages(request.messages);

    const body = {
      contents,
      generationConfig: {
        temperature: request.temperature || 0.7,
        maxOutputTokens: request.maxTokens || 2048
      }
    };

    // Add system instruction if present
    if (systemInstruction.length > 0) {
      body.systemInstruction = { parts: systemInstruction };
    }

    // Add tools
    if (request.tools && request.tools.length > 0) {
      body.tools = this.formatTools(request.tools);
    }

    // Add generation config options
    if (request.topP) body.generationConfig.topP = request.topP;
    if (request.stop)
      body.generationConfig.stopSequences = Array.isArray(request.stop)
        ? request.stop
        : [request.stop];

    // Safety settings (optional - can be configured)
    body.safetySettings = [
      {
        category: 'HARM_CATEGORY_HARASSMENT',
        threshold: 'BLOCK_MEDIUM_AND_ABOVE'
      },
      {
        category: 'HARM_CATEGORY_HATE_SPEECH',
        threshold: 'BLOCK_MEDIUM_AND_ABOVE'
      },
      {
        category: 'HARM_CATEGORY_SEXUALLY_EXPLICIT',
        threshold: 'BLOCK_MEDIUM_AND_ABOVE'
      },
      {
        category: 'HARM_CATEGORY_DANGEROUS_CONTENT',
        threshold: 'BLOCK_MEDIUM_AND_ABOVE'
      }
    ];

    const endpoint = streaming ? 'streamGenerateContent' : 'generateContent';
    const url = `${this.baseURL}/models/${request.model}:${endpoint}?key=${this.config.apiKey}`;

    return {
      url,
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'User-Agent': 'llm-sdk/1.0.0'
      },
      body
    };
  }

  /**
   * Map SDK role to Google role
   * @param {string} role - SDK role
   * @returns {string} Google role
   */
  mapRole(role) {
    const mapping = {
      user: 'user',
      assistant: 'model',
      tool: 'function'
    };
    return mapping[role] || 'user';
  }

  /**
   * Parse Google message to standard format
   * @param {Object} candidate - Google candidate
   * @returns {Message} Standard message
   */
  parseGoogleMessage(candidate) {
    if (!candidate.content || !candidate.content.parts) {
      return new Message('assistant', '');
    }

    let textContent = '';
    const toolCalls = [];

    for (const part of candidate.content.parts) {
      if (part.text) {
        textContent += part.text;
      } else if (part.functionCall) {
        toolCalls.push(
          new ToolCall(
            `call_${Date.now()}_${toolCalls.length}`,
            part.functionCall.name,
            part.functionCall.args || {}
          )
        );
      }
    }

    return new Message('assistant', textContent, {
      toolCalls: toolCalls.length > 0 ? toolCalls : undefined
    });
  }

  /**
   * Parse Google stream chunk
   * @param {Object} chunk - Google chunk
   * @param {Object} originalRequest - Original request
   * @returns {ResponseChunk|null} Parsed chunk
   */
  parseStreamChunk(chunk, originalRequest) {
    if (!chunk.candidates || chunk.candidates.length === 0) return null;

    const candidate = chunk.candidates[0];
    if (!candidate.content || !candidate.content.parts) return null;

    let content = '';
    const toolCalls = [];

    for (const part of candidate.content.parts) {
      if (part.text) {
        content += part.text;
      } else if (part.functionCall) {
        toolCalls.push(
          new ToolCall(
            `call_${Date.now()}_${toolCalls.length}`,
            part.functionCall.name,
            part.functionCall.args || {}
          )
        );
      }
    }

    const responseDelta = new ResponseDelta(content, toolCalls.length > 0 ? toolCalls : null);

    const choiceDelta = new ResponseChoiceDelta(
      0,
      responseDelta,
      this.normalizeFinishReason(candidate.finishReason)
    );

    const usage = this.parseUsage(chunk.usageMetadata);

    return new ResponseChunk({
      id: this.generateResponseId(),
      model: originalRequest.model,
      provider: this.name,
      choices: [choiceDelta],
      usage,
      done: !!candidate.finishReason
    });
  }

  /**
   * Parse usage metadata
   * @param {Object} usageMetadata - Google usage metadata
   * @returns {Usage} Usage object
   */
  parseUsage(usageMetadata) {
    if (!usageMetadata) return new Usage();

    return new Usage(
      usageMetadata.promptTokenCount || 0,
      usageMetadata.candidatesTokenCount || 0,
      usageMetadata.totalTokenCount
    );
  }

  /**
   * Normalize Google finish reason
   * @param {string} reason - Google finish reason
   * @returns {string|null} Normalized finish reason
   */
  normalizeFinishReason(reason) {
    if (!reason) return null;

    const mapping = {
      STOP: 'stop',
      MAX_TOKENS: 'length',
      SAFETY: 'content_filter',
      RECITATION: 'content_filter',
      OTHER: 'stop'
    };

    return mapping[reason] || reason.toLowerCase();
  }

  /**
   * Generate response ID
   * @returns {string} Response ID
   */
  generateResponseId() {
    return `google_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
  }

  /**
   * Clean base64 data
   * @param {string} base64Data - Base64 data
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
      'gemini-1.5-pro': { input: 1.25, output: 5 },
      'gemini-1.5-flash': { input: 0.075, output: 0.3 },
      'gemini-1.0-pro': { input: 0.5, output: 1.5 },
      'gemini-pro': { input: 0.5, output: 1.5 },
      'gemini-pro-vision': { input: 0.25, output: 0.5 }
    };

    return pricing[modelName] || null;
  }
}
