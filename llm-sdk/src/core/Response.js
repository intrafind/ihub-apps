import { ToolCall } from './Message.js';

/**
 * Usage information for API calls
 */
export class Usage {
  constructor(promptTokens = 0, completionTokens = 0, totalTokens = null) {
    this.promptTokens = promptTokens;
    this.completionTokens = completionTokens;
    this.totalTokens = totalTokens || promptTokens + completionTokens;
  }

  /**
   * Add usage from another Usage object
   * @param {Usage} other - Other usage to add
   * @returns {Usage} New usage with combined values
   */
  add(other) {
    return new Usage(
      this.promptTokens + (other.promptTokens || 0),
      this.completionTokens + (other.completionTokens || 0)
    );
  }

  /**
   * Convert to JSON
   * @returns {Object} JSON representation
   */
  toJSON() {
    return {
      promptTokens: this.promptTokens,
      completionTokens: this.completionTokens,
      totalTokens: this.totalTokens
    };
  }

  /**
   * Create from JSON
   * @param {Object} data - JSON data
   * @returns {Usage} Usage instance
   */
  static fromJSON(data) {
    return new Usage(
      data.promptTokens || data.prompt_tokens || 0,
      data.completionTokens || data.completion_tokens || 0,
      data.totalTokens || data.total_tokens
    );
  }
}

/**
 * Response choice representing one possible completion
 */
export class ResponseChoice {
  constructor(index, message, finishReason, logprobs = null) {
    this.index = index;
    this.message = message;
    this.finishReason = finishReason;
    this.logprobs = logprobs;
  }

  /**
   * Check if this choice was stopped due to length limit
   * @returns {boolean} Whether stopped due to length
   */
  isLengthLimited() {
    return this.finishReason === 'length';
  }

  /**
   * Check if this choice completed naturally
   * @returns {boolean} Whether completed naturally
   */
  isComplete() {
    return this.finishReason === 'stop';
  }

  /**
   * Check if this choice was stopped for tool calls
   * @returns {boolean} Whether stopped for tool calls
   */
  hasToolCalls() {
    return (
      this.finishReason === 'tool_calls' ||
      (this.message && this.message.hasToolCalls && this.message.hasToolCalls())
    );
  }

  /**
   * Convert to JSON
   * @returns {Object} JSON representation
   */
  toJSON() {
    return {
      index: this.index,
      message: this.message?.toJSON ? this.message.toJSON() : this.message,
      finishReason: this.finishReason,
      logprobs: this.logprobs
    };
  }

  /**
   * Create from JSON
   * @param {Object} data - JSON data
   * @returns {ResponseChoice} ResponseChoice instance
   */
  static fromJSON(data) {
    return new ResponseChoice(
      data.index,
      data.message,
      data.finishReason || data.finish_reason,
      data.logprobs
    );
  }
}

/**
 * Delta for streaming response chunks
 */
export class ResponseDelta {
  constructor(content = '', toolCalls = null, role = null) {
    this.content = content;
    this.toolCalls = toolCalls;
    this.role = role;
  }

  /**
   * Check if delta has content
   * @returns {boolean} Whether delta has content
   */
  hasContent() {
    return !!(this.content && this.content.length > 0);
  }

  /**
   * Check if delta has tool calls
   * @returns {boolean} Whether delta has tool calls
   */
  hasToolCalls() {
    return !!(this.toolCalls && this.toolCalls.length > 0);
  }

  /**
   * Convert to JSON
   * @returns {Object} JSON representation
   */
  toJSON() {
    const json = {};
    if (this.content) json.content = this.content;
    if (this.toolCalls) json.toolCalls = this.toolCalls;
    if (this.role) json.role = this.role;
    return json;
  }
}

/**
 * Choice delta for streaming responses
 */
export class ResponseChoiceDelta {
  constructor(index, delta, finishReason = null) {
    this.index = index;
    this.delta = delta;
    this.finishReason = finishReason;
  }

  /**
   * Convert to JSON
   * @returns {Object} JSON representation
   */
  toJSON() {
    return {
      index: this.index,
      delta: this.delta.toJSON(),
      finishReason: this.finishReason
    };
  }
}

/**
 * Main response object for chat completions
 */
export class Response {
  constructor(options = {}) {
    this.id = options.id || this.generateId();
    this.model = options.model;
    this.provider = options.provider;
    this.choices = options.choices || [];
    this.usage = options.usage || new Usage();
    this.metadata = options.metadata || {};
    this.raw = options.raw; // Original provider response
    this.createdAt = options.createdAt || new Date();
    this.requestId = options.requestId;
  }

  /**
   * Generate unique response ID
   * @returns {string} Unique identifier
   */
  generateId() {
    return `resp_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
  }

  /**
   * Get the main content from the first choice
   * @returns {string} Content string
   */
  get content() {
    if (this.choices.length === 0) return '';
    const message = this.choices[0].message;
    return message?.getTextContent ? message.getTextContent() : message?.content || '';
  }

  /**
   * Get tool calls from the first choice
   * @returns {Array<ToolCall>} Tool calls
   */
  get toolCalls() {
    if (this.choices.length === 0) return [];
    const message = this.choices[0].message;
    return message?.toolCalls || [];
  }

  /**
   * Get finish reason from the first choice
   * @returns {string|null} Finish reason
   */
  get finishReason() {
    if (this.choices.length === 0) return null;
    return this.choices[0].finishReason;
  }

  /**
   * Check if response has tool calls
   * @returns {boolean} Whether response has tool calls
   */
  hasToolCalls() {
    return this.toolCalls.length > 0;
  }

  /**
   * Check if response was truncated due to length
   * @returns {boolean} Whether response was truncated
   */
  isTruncated() {
    return this.choices.some(choice => choice.finishReason === 'length');
  }

  /**
   * Check if response completed naturally
   * @returns {boolean} Whether response completed naturally
   */
  isComplete() {
    return this.choices.every(
      choice => choice.finishReason === 'stop' || choice.finishReason === 'tool_calls'
    );
  }

  /**
   * Get response duration in milliseconds
   * @returns {number|null} Duration in ms
   */
  getDuration() {
    if (this.metadata.startTime && this.metadata.endTime) {
      return this.metadata.endTime - this.metadata.startTime;
    }
    return null;
  }

  /**
   * Get tokens per second if timing data available
   * @returns {number|null} Tokens per second
   */
  getTokensPerSecond() {
    const duration = this.getDuration();
    if (duration && this.usage.completionTokens > 0) {
      return (this.usage.completionTokens / duration) * 1000;
    }
    return null;
  }

  /**
   * Convert to JSON
   * @returns {Object} JSON representation
   */
  toJSON() {
    return {
      id: this.id,
      model: this.model,
      provider: this.provider,
      choices: this.choices.map(choice => choice.toJSON()),
      usage: this.usage.toJSON(),
      metadata: this.metadata,
      createdAt: this.createdAt.toISOString(),
      requestId: this.requestId
    };
  }

  /**
   * Create from JSON
   * @param {Object} data - JSON data
   * @returns {Response} Response instance
   */
  static fromJSON(data) {
    return new Response({
      id: data.id,
      model: data.model,
      provider: data.provider,
      choices: data.choices?.map(choice => ResponseChoice.fromJSON(choice)) || [],
      usage: data.usage ? Usage.fromJSON(data.usage) : new Usage(),
      metadata: data.metadata || {},
      createdAt: data.createdAt ? new Date(data.createdAt) : new Date(),
      requestId: data.requestId
    });
  }
}

/**
 * Streaming response chunk
 */
export class ResponseChunk {
  constructor(options = {}) {
    this.id = options.id;
    this.model = options.model;
    this.provider = options.provider;
    this.choices = options.choices || [];
    this.usage = options.usage;
    this.done = options.done || false;
    this.timestamp = options.timestamp || Date.now();
    this.requestId = options.requestId;
  }

  /**
   * Get content from first choice delta
   * @returns {string} Content string
   */
  get content() {
    if (this.choices.length === 0) return '';
    return this.choices[0].delta?.content || '';
  }

  /**
   * Get tool calls from first choice delta
   * @returns {Array} Tool calls
   */
  get toolCalls() {
    if (this.choices.length === 0) return [];
    return this.choices[0].delta?.toolCalls || [];
  }

  /**
   * Get finish reason from first choice
   * @returns {string|null} Finish reason
   */
  get finishReason() {
    if (this.choices.length === 0) return null;
    return this.choices[0].finishReason;
  }

  /**
   * Check if chunk has content
   * @returns {boolean} Whether chunk has content
   */
  hasContent() {
    return this.content.length > 0;
  }

  /**
   * Check if chunk has tool calls
   * @returns {boolean} Whether chunk has tool calls
   */
  hasToolCalls() {
    return this.toolCalls.length > 0;
  }

  /**
   * Check if this is the final chunk
   * @returns {boolean} Whether this is the final chunk
   */
  isFinal() {
    return this.done || this.choices.some(choice => choice.finishReason);
  }

  /**
   * Convert to JSON
   * @returns {Object} JSON representation
   */
  toJSON() {
    return {
      id: this.id,
      model: this.model,
      provider: this.provider,
      choices: this.choices.map(choice => choice.toJSON()),
      usage: this.usage?.toJSON(),
      done: this.done,
      timestamp: this.timestamp,
      requestId: this.requestId
    };
  }

  /**
   * Create from JSON
   * @param {Object} data - JSON data
   * @returns {ResponseChunk} ResponseChunk instance
   */
  static fromJSON(data) {
    return new ResponseChunk({
      id: data.id,
      model: data.model,
      provider: data.provider,
      choices:
        data.choices?.map(choice => ({
          index: choice.index,
          delta: new ResponseDelta(
            choice.delta?.content,
            choice.delta?.toolCalls,
            choice.delta?.role
          ),
          finishReason: choice.finishReason || choice.finish_reason
        })) || [],
      usage: data.usage ? Usage.fromJSON(data.usage) : null,
      done: data.done || false,
      timestamp: data.timestamp || Date.now(),
      requestId: data.requestId
    });
  }
}

/**
 * Utility to aggregate streaming chunks into final response
 */
export class ResponseAggregator {
  constructor() {
    this.chunks = [];
    this.content = '';
    this.toolCalls = [];
    this.usage = new Usage();
    this.metadata = {};
  }

  /**
   * Add a chunk to the aggregation
   * @param {ResponseChunk} chunk - Chunk to add
   */
  addChunk(chunk) {
    this.chunks.push(chunk);

    // Aggregate content
    if (chunk.hasContent()) {
      this.content += chunk.content;
    }

    // Aggregate tool calls
    if (chunk.hasToolCalls()) {
      this.toolCalls.push(...chunk.toolCalls);
    }

    // Update usage (use latest)
    if (chunk.usage) {
      this.usage = chunk.usage;
    }

    // Update metadata
    this.metadata.chunkCount = this.chunks.length;
    this.metadata.lastChunkTime = chunk.timestamp;
  }

  /**
   * Get the aggregated response
   * @returns {Response} Final aggregated response
   */
  getResponse() {
    if (this.chunks.length === 0) {
      throw new Error('No chunks to aggregate');
    }

    const firstChunk = this.chunks[0];
    const lastChunk = this.chunks[this.chunks.length - 1];

    // Create message from aggregated content
    const message = {
      role: 'assistant',
      content: this.content,
      toolCalls: this.toolCalls.length > 0 ? this.toolCalls : undefined
    };

    const choice = new ResponseChoice(0, message, lastChunk.finishReason);

    return new Response({
      id: firstChunk.id,
      model: firstChunk.model,
      provider: firstChunk.provider,
      choices: [choice],
      usage: this.usage,
      metadata: {
        ...this.metadata,
        streaming: true,
        startTime: firstChunk.timestamp,
        endTime: lastChunk.timestamp
      },
      requestId: firstChunk.requestId
    });
  }
}
