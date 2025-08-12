import { ResponseChunk } from '../core/Response.js';
import { ProviderError, NetworkError } from '../utils/ErrorHandler.js';

/**
 * Streaming client for handling LLM streaming responses
 */
export class StreamingClient {
  constructor(logger) {
    this.logger = logger;
  }

  /**
   * Create a streaming response from HTTP response
   * @param {Response} httpResponse - HTTP response object
   * @param {Function} chunkParser - Provider-specific chunk parser function
   * @param {Object} originalRequest - Original request for context
   * @returns {AsyncIterator<ResponseChunk>} Streaming response chunks
   */
  async *createStreamFromResponse(httpResponse, chunkParser, originalRequest) {
    if (!httpResponse.body) {
      throw new NetworkError('No response body for streaming', originalRequest.provider);
    }

    const reader = httpResponse.body.getReader();
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
          const chunk = this.parseLine(line, chunkParser, originalRequest);
          if (chunk) {
            yield chunk;
          }
        }
      }

      // Process any remaining buffer content
      if (buffer.trim()) {
        const chunk = this.parseLine(buffer, chunkParser, originalRequest);
        if (chunk) {
          yield chunk;
        }
      }
    } finally {
      reader.releaseLock();
    }
  }

  /**
   * Parse a single line from the streaming response
   * @param {string} line - Raw line from stream
   * @param {Function} chunkParser - Provider-specific chunk parser
   * @param {Object} originalRequest - Original request
   * @returns {ResponseChunk|null} Parsed chunk or null
   */
  parseLine(line, chunkParser, originalRequest) {
    const trimmedLine = line.trim();

    // Skip empty lines and done markers
    if (trimmedLine === '' || trimmedLine === 'data: [DONE]') {
      return null;
    }

    // Handle Server-Sent Events format
    if (trimmedLine.startsWith('data: ')) {
      const jsonData = trimmedLine.slice(6);

      // Skip [DONE] markers
      if (jsonData === '[DONE]') {
        return null;
      }

      try {
        const parsed = JSON.parse(jsonData);
        return chunkParser(parsed, originalRequest);
      } catch (error) {
        this.logger?.warn?.('Failed to parse streaming chunk:', {
          line: trimmedLine,
          error: error.message,
          provider: originalRequest.provider
        });
        return null;
      }
    }

    // Handle direct JSON lines (some providers don't use SSE format)
    try {
      const parsed = JSON.parse(trimmedLine);
      return chunkParser(parsed, originalRequest);
    } catch (error) {
      // Not JSON, skip this line
      return null;
    }
  }

  /**
   * Create a streaming response with error handling and cancellation
   * @param {Function} streamFactory - Function that returns an AsyncIterator
   * @param {AbortController} controller - Abort controller for cancellation
   * @returns {StreamingResponse} Enhanced streaming response
   */
  createEnhancedStream(streamFactory, controller) {
    return new StreamingResponse(streamFactory, controller, this.logger);
  }
}

/**
 * Enhanced streaming response with cancellation and error handling
 */
export class StreamingResponse {
  constructor(streamFactory, controller, logger) {
    this.streamFactory = streamFactory;
    this.controller = controller;
    this.logger = logger;
    this._iterator = null;
    this._cancelled = false;
    this._chunks = [];
    this._onChunk = null;
    this._onComplete = null;
    this._onError = null;
  }

  /**
   * Set event handlers
   * @param {Object} handlers - Event handlers
   * @param {Function} handlers.onChunk - Called for each chunk
   * @param {Function} handlers.onComplete - Called when stream completes
   * @param {Function} handlers.onError - Called on error
   * @returns {StreamingResponse} Self for chaining
   */
  on(handlers) {
    if (handlers.onChunk) this._onChunk = handlers.onChunk;
    if (handlers.onComplete) this._onComplete = handlers.onComplete;
    if (handlers.onError) this._onError = handlers.onError;
    return this;
  }

  /**
   * Cancel the streaming response
   */
  cancel() {
    this._cancelled = true;
    if (this.controller && !this.controller.signal.aborted) {
      this.controller.abort();
    }
  }

  /**
   * Check if the stream is cancelled
   * @returns {boolean} True if cancelled
   */
  get cancelled() {
    return this._cancelled;
  }

  /**
   * Get all chunks received so far
   * @returns {Array<ResponseChunk>} Array of chunks
   */
  get chunks() {
    return [...this._chunks];
  }

  /**
   * Implement async iterator interface
   * @returns {AsyncIterator<ResponseChunk>} Async iterator
   */
  async *[Symbol.asyncIterator]() {
    try {
      const iterator = await this.streamFactory();
      this._iterator = iterator;

      while (!this._cancelled) {
        const { done, value } = await iterator.next();

        if (done) {
          if (this._onComplete) {
            try {
              await this._onComplete(this._chunks);
            } catch (error) {
              this.logger?.error?.('Error in onComplete handler:', error);
            }
          }
          break;
        }

        if (value) {
          this._chunks.push(value);

          if (this._onChunk) {
            try {
              await this._onChunk(value);
            } catch (error) {
              this.logger?.error?.('Error in onChunk handler:', error);
            }
          }

          yield value;
        }
      }
    } catch (error) {
      if (this._onError) {
        try {
          await this._onError(error);
        } catch (handlerError) {
          this.logger?.error?.('Error in onError handler:', handlerError);
        }
      }
      throw error;
    }
  }

  /**
   * Collect all chunks into a single response
   * @returns {Promise<Object>} Combined response
   */
  async collectAll() {
    const chunks = [];
    let usage = null;
    let metadata = {};

    try {
      for await (const chunk of this) {
        chunks.push(chunk);

        // Keep track of the latest usage and metadata
        if (chunk.usage) usage = chunk.usage;
        if (chunk.metadata) metadata = { ...metadata, ...chunk.metadata };
      }

      // Combine all chunks into a single response
      const combinedContent = chunks
        .map(chunk => chunk.choices?.[0]?.delta?.content || '')
        .join('');

      const combinedToolCalls = [];
      const toolCallMap = new Map();

      // Combine tool calls from all chunks
      chunks.forEach(chunk => {
        const chunkToolCalls = chunk.choices?.[0]?.delta?.toolCalls || [];
        chunkToolCalls.forEach(tc => {
          if (tc.id) {
            if (!toolCallMap.has(tc.id)) {
              toolCallMap.set(tc.id, {
                id: tc.id,
                name: tc.name || '',
                arguments: {}
              });
            }

            const existing = toolCallMap.get(tc.id);
            if (tc.name) existing.name = tc.name;
            if (tc.arguments) {
              existing.arguments = { ...existing.arguments, ...tc.arguments };
            }
          }
        });
      });

      combinedToolCalls.push(...Array.from(toolCallMap.values()));

      const lastChunk = chunks[chunks.length - 1];
      const finishReason = lastChunk?.choices?.[0]?.finishReason || 'stop';

      return {
        id: lastChunk?.id || 'streaming-response',
        model: lastChunk?.model || '',
        provider: lastChunk?.provider || '',
        content: combinedContent,
        toolCalls: combinedToolCalls,
        finishReason,
        usage,
        metadata: {
          ...metadata,
          streaming: true,
          chunkCount: chunks.length
        },
        chunks
      };
    } catch (error) {
      throw new ProviderError(
        `Failed to collect streaming response: ${error.message}`,
        'streaming',
        'STREAM_COLLECTION_ERROR',
        { originalError: error, chunksReceived: chunks.length }
      );
    }
  }

  /**
   * Transform the stream with a custom function
   * @param {Function} transformer - Transform function
   * @returns {StreamingResponse} New transformed stream
   */
  transform(transformer) {
    const transformedFactory = async () => {
      const iterator = await this.streamFactory();
      return this.createTransformIterator(iterator, transformer);
    };

    return new StreamingResponse(transformedFactory, this.controller, this.logger);
  }

  /**
   * Create a transform iterator
   * @param {AsyncIterator} sourceIterator - Source iterator
   * @param {Function} transformer - Transform function
   * @returns {AsyncIterator} Transformed iterator
   */
  async *createTransformIterator(sourceIterator, transformer) {
    try {
      while (true) {
        const { done, value } = await sourceIterator.next();
        if (done) break;

        const transformed = await transformer(value);
        if (transformed !== null && transformed !== undefined) {
          yield transformed;
        }
      }
    } catch (error) {
      throw error;
    }
  }

  /**
   * Take only the first N chunks
   * @param {number} count - Number of chunks to take
   * @returns {StreamingResponse} Limited stream
   */
  take(count) {
    let taken = 0;
    return this.transform(chunk => {
      if (taken >= count) return null;
      taken++;
      return chunk;
    });
  }

  /**
   * Skip the first N chunks
   * @param {number} count - Number of chunks to skip
   * @returns {StreamingResponse} Stream with skipped chunks
   */
  skip(count) {
    let skipped = 0;
    return this.transform(chunk => {
      if (skipped < count) {
        skipped++;
        return null;
      }
      return chunk;
    });
  }
}
