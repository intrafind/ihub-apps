/**
 * Unit tests for StreamingClient
 */

import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import { StreamingClient, StreamingResponse } from '../../../src/streaming/StreamingClient.js';
import { ResponseChunk, ResponseChoiceDelta, ResponseDelta } from '../../../src/core/Response.js';

describe('StreamingClient', () => {
  let streamingClient;
  let mockLogger;

  beforeEach(() => {
    mockLogger = {
      warn: vi.fn(),
      error: vi.fn(),
      debug: vi.fn()
    };
    streamingClient = new StreamingClient(mockLogger);
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  describe('line parsing', () => {
    const mockChunkParser = vi.fn();
    const mockRequest = { provider: 'test' };

    beforeEach(() => {
      mockChunkParser.mockClear();
    });

    it('should skip empty lines', () => {
      const result = streamingClient.parseLine('', mockChunkParser, mockRequest);
      expect(result).toBeNull();
      expect(mockChunkParser).not.toHaveBeenCalled();
    });

    it('should skip [DONE] markers', () => {
      const result = streamingClient.parseLine('data: [DONE]', mockChunkParser, mockRequest);
      expect(result).toBeNull();
      expect(mockChunkParser).not.toHaveBeenCalled();
    });

    it('should parse valid SSE data lines', () => {
      const mockChunk = new ResponseChunk({ id: 'test', model: 'test', provider: 'test' });
      const jsonData = { id: 'test', choices: [] };
      mockChunkParser.mockReturnValue(mockChunk);

      const result = streamingClient.parseLine(
        `data: ${JSON.stringify(jsonData)}`,
        mockChunkParser,
        mockRequest
      );

      expect(result).toBe(mockChunk);
      expect(mockChunkParser).toHaveBeenCalledWith(jsonData, mockRequest);
    });

    it('should parse direct JSON lines', () => {
      const mockChunk = new ResponseChunk({ id: 'test', model: 'test', provider: 'test' });
      const jsonData = { id: 'test', choices: [] };
      mockChunkParser.mockReturnValue(mockChunk);

      const result = streamingClient.parseLine(
        JSON.stringify(jsonData),
        mockChunkParser,
        mockRequest
      );

      expect(result).toBe(mockChunk);
      expect(mockChunkParser).toHaveBeenCalledWith(jsonData, mockRequest);
    });

    it('should handle invalid JSON gracefully', () => {
      const result = streamingClient.parseLine('data: invalid json', mockChunkParser, mockRequest);

      expect(result).toBeNull();
      expect(mockLogger.warn).toHaveBeenCalledWith(
        'Failed to parse streaming chunk:',
        expect.objectContaining({
          line: 'data: invalid json',
          provider: 'test'
        })
      );
    });

    it('should handle parser errors gracefully', () => {
      mockChunkParser.mockImplementation(() => {
        throw new Error('Parser error');
      });

      const result = streamingClient.parseLine(
        'data: {"valid": "json"}',
        mockChunkParser,
        mockRequest
      );

      expect(result).toBeNull();
      expect(mockLogger.warn).toHaveBeenCalled();
    });
  });

  describe('stream creation from response', () => {
    let mockResponse;
    let mockReader;

    beforeEach(() => {
      mockReader = {
        read: vi.fn(),
        releaseLock: vi.fn()
      };

      mockResponse = {
        body: {
          getReader: vi.fn().mockReturnValue(mockReader)
        }
      };
    });

    it('should create stream from HTTP response', async () => {
      const chunks = [
        'data: {"id":"1","choices":[{"delta":{"content":"Hello"}}]}\n',
        'data: {"id":"2","choices":[{"delta":{"content":" World"}}]}\n',
        'data: [DONE]\n'
      ];

      let chunkIndex = 0;
      mockReader.read.mockImplementation(() => {
        if (chunkIndex < chunks.length) {
          const chunk = chunks[chunkIndex++];
          const encoder = new TextEncoder();
          return Promise.resolve({
            done: false,
            value: encoder.encode(chunk)
          });
        }
        return Promise.resolve({ done: true });
      });

      const mockChunkParser = vi
        .fn()
        .mockReturnValueOnce(
          new ResponseChunk({
            id: '1',
            model: 'test',
            provider: 'test',
            choices: [new ResponseChoiceDelta(0, new ResponseDelta('Hello'))]
          })
        )
        .mockReturnValueOnce(
          new ResponseChunk({
            id: '2',
            model: 'test',
            provider: 'test',
            choices: [new ResponseChoiceDelta(0, new ResponseDelta(' World'))]
          })
        );

      const stream = streamingClient.createStreamFromResponse(mockResponse, mockChunkParser, {
        provider: 'test'
      });

      const results = [];
      for await (const chunk of stream) {
        results.push(chunk);
      }

      expect(results).toHaveLength(2);
      expect(results[0].choices[0].delta.content).toBe('Hello');
      expect(results[1].choices[0].delta.content).toBe(' World');
      expect(mockReader.releaseLock).toHaveBeenCalled();
    });

    it('should handle missing response body', async () => {
      const noBodyResponse = { body: null };

      await expect(async () => {
        for await (const chunk of streamingClient.createStreamFromResponse(
          noBodyResponse,
          vi.fn(),
          { provider: 'test' }
        )) {
          // Should not reach here
        }
      }).rejects.toThrow('No response body for streaming');
    });

    it('should release reader lock on error', async () => {
      mockReader.read.mockRejectedValue(new Error('Read error'));

      const stream = streamingClient.createStreamFromResponse(mockResponse, vi.fn(), {
        provider: 'test'
      });

      await expect(async () => {
        for await (const chunk of stream) {
          // Should not reach here
        }
      }).rejects.toThrow('Read error');

      expect(mockReader.releaseLock).toHaveBeenCalled();
    });
  });

  describe('enhanced stream creation', () => {
    it('should create enhanced stream with controller', () => {
      const controller = new AbortController();
      const streamFactory = vi.fn().mockResolvedValue(
        (async function* () {
          yield new ResponseChunk({ id: 'test', model: 'test', provider: 'test' });
        })()
      );

      const enhancedStream = streamingClient.createEnhancedStream(streamFactory, controller);

      expect(enhancedStream).toBeInstanceOf(StreamingResponse);
      expect(enhancedStream.controller).toBe(controller);
    });
  });
});

describe('StreamingResponse', () => {
  let streamingResponse;
  let mockController;
  let mockLogger;

  beforeEach(() => {
    mockController = new AbortController();
    mockLogger = {
      error: vi.fn(),
      debug: vi.fn()
    };
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  describe('event handling', () => {
    it('should set event handlers', () => {
      const streamFactory = vi.fn();
      streamingResponse = new StreamingResponse(streamFactory, mockController, mockLogger);

      const handlers = {
        onChunk: vi.fn(),
        onComplete: vi.fn(),
        onError: vi.fn()
      };

      const result = streamingResponse.on(handlers);

      expect(result).toBe(streamingResponse); // Should return self for chaining
      expect(streamingResponse._onChunk).toBe(handlers.onChunk);
      expect(streamingResponse._onComplete).toBe(handlers.onComplete);
      expect(streamingResponse._onError).toBe(handlers.onError);
    });
  });

  describe('cancellation', () => {
    it('should cancel stream and abort controller', () => {
      const streamFactory = vi.fn();
      streamingResponse = new StreamingResponse(streamFactory, mockController, mockLogger);

      expect(streamingResponse.cancelled).toBe(false);
      expect(mockController.signal.aborted).toBe(false);

      streamingResponse.cancel();

      expect(streamingResponse.cancelled).toBe(true);
      expect(mockController.signal.aborted).toBe(true);
    });

    it('should not abort already aborted controller', () => {
      mockController.abort();
      const streamFactory = vi.fn();
      streamingResponse = new StreamingResponse(streamFactory, mockController, mockLogger);

      // Should not throw
      streamingResponse.cancel();
      expect(streamingResponse.cancelled).toBe(true);
    });
  });

  describe('async iteration', () => {
    it('should iterate through stream chunks', async () => {
      const chunks = [
        new ResponseChunk({
          id: '1',
          model: 'test',
          provider: 'test',
          choices: [new ResponseChoiceDelta(0, new ResponseDelta('Hello'))]
        }),
        new ResponseChunk({
          id: '2',
          model: 'test',
          provider: 'test',
          choices: [new ResponseChoiceDelta(0, new ResponseDelta(' World'))]
        })
      ];

      const streamFactory = vi.fn().mockResolvedValue(
        (async function* () {
          for (const chunk of chunks) {
            yield chunk;
          }
        })()
      );

      streamingResponse = new StreamingResponse(streamFactory, mockController, mockLogger);

      const results = [];
      for await (const chunk of streamingResponse) {
        results.push(chunk);
      }

      expect(results).toHaveLength(2);
      expect(results[0].choices[0].delta.content).toBe('Hello');
      expect(results[1].choices[0].delta.content).toBe(' World');
      expect(streamingResponse.chunks).toHaveLength(2);
    });

    it('should call event handlers during iteration', async () => {
      const chunk = new ResponseChunk({
        id: '1',
        model: 'test',
        provider: 'test',
        choices: [new ResponseChoiceDelta(0, new ResponseDelta('Test'))]
      });

      const streamFactory = vi.fn().mockResolvedValue(
        (async function* () {
          yield chunk;
        })()
      );

      const handlers = {
        onChunk: vi.fn(),
        onComplete: vi.fn(),
        onError: vi.fn()
      };

      streamingResponse = new StreamingResponse(streamFactory, mockController, mockLogger).on(
        handlers
      );

      for await (const receivedChunk of streamingResponse) {
        expect(receivedChunk).toBe(chunk);
      }

      expect(handlers.onChunk).toHaveBeenCalledWith(chunk);
      expect(handlers.onComplete).toHaveBeenCalledWith([chunk]);
      expect(handlers.onError).not.toHaveBeenCalled();
    });

    it('should handle iteration errors', async () => {
      const streamFactory = vi.fn().mockResolvedValue(
        (async function* () {
          throw new Error('Stream error');
        })()
      );

      const handlers = {
        onError: vi.fn()
      };

      streamingResponse = new StreamingResponse(streamFactory, mockController, mockLogger).on(
        handlers
      );

      await expect(async () => {
        for await (const chunk of streamingResponse) {
          // Should not reach here
        }
      }).rejects.toThrow('Stream error');

      expect(handlers.onError).toHaveBeenCalledWith(expect.any(Error));
    });

    it('should stop iteration when cancelled', async () => {
      const streamFactory = vi.fn().mockResolvedValue(
        (async function* () {
          yield new ResponseChunk({ id: '1', model: 'test', provider: 'test' });
          // Simulate cancellation during stream
          yield new ResponseChunk({ id: '2', model: 'test', provider: 'test' });
        })()
      );

      streamingResponse = new StreamingResponse(streamFactory, mockController, mockLogger);

      const results = [];
      let iterationCount = 0;

      for await (const chunk of streamingResponse) {
        results.push(chunk);
        iterationCount++;

        if (iterationCount === 1) {
          streamingResponse.cancel();
        }
      }

      // Should have processed the first chunk before cancellation
      expect(results).toHaveLength(1);
      expect(streamingResponse.cancelled).toBe(true);
    });
  });

  describe('collectAll', () => {
    it('should collect all chunks into combined response', async () => {
      const chunks = [
        new ResponseChunk({
          id: '1',
          model: 'test-model',
          provider: 'test',
          choices: [new ResponseChoiceDelta(0, new ResponseDelta('Hello'))],
          metadata: { created: Date.now() }
        }),
        new ResponseChunk({
          id: '2',
          model: 'test-model',
          provider: 'test',
          choices: [new ResponseChoiceDelta(0, new ResponseDelta(' World'))],
          done: true
        })
      ];

      const streamFactory = vi.fn().mockResolvedValue(
        (async function* () {
          for (const chunk of chunks) {
            yield chunk;
          }
        })()
      );

      streamingResponse = new StreamingResponse(streamFactory, mockController, mockLogger);

      const result = await streamingResponse.collectAll();

      expect(result.content).toBe('Hello World');
      expect(result.model).toBe('test-model');
      expect(result.provider).toBe('test');
      expect(result.finishReason).toBe('stop');
      expect(result.metadata.streaming).toBe(true);
      expect(result.metadata.chunkCount).toBe(2);
      expect(result.chunks).toHaveLength(2);
    });

    it('should handle collection errors', async () => {
      const streamFactory = vi.fn().mockResolvedValue(
        (async function* () {
          throw new Error('Collection error');
        })()
      );

      streamingResponse = new StreamingResponse(streamFactory, mockController, mockLogger);

      await expect(streamingResponse.collectAll()).rejects.toThrow(
        'Failed to collect streaming response'
      );
    });
  });

  describe('transformation', () => {
    it('should transform stream with custom function', async () => {
      const originalChunks = [
        new ResponseChunk({ id: '1', model: 'test', provider: 'test' }),
        new ResponseChunk({ id: '2', model: 'test', provider: 'test' })
      ];

      const streamFactory = vi.fn().mockResolvedValue(
        (async function* () {
          for (const chunk of originalChunks) {
            yield chunk;
          }
        })()
      );

      streamingResponse = new StreamingResponse(streamFactory, mockController, mockLogger);

      const transformer = vi.fn().mockImplementation(chunk => {
        return { ...chunk, transformed: true };
      });

      const transformedStream = streamingResponse.transform(transformer);

      const results = [];
      for await (const chunk of transformedStream) {
        results.push(chunk);
      }

      expect(results).toHaveLength(2);
      expect(results[0].transformed).toBe(true);
      expect(results[1].transformed).toBe(true);
      expect(transformer).toHaveBeenCalledTimes(2);
    });

    it('should filter out null/undefined transformed values', async () => {
      const originalChunks = [
        new ResponseChunk({ id: '1', model: 'test', provider: 'test' }),
        new ResponseChunk({ id: '2', model: 'test', provider: 'test' }),
        new ResponseChunk({ id: '3', model: 'test', provider: 'test' })
      ];

      const streamFactory = vi.fn().mockResolvedValue(
        (async function* () {
          for (const chunk of originalChunks) {
            yield chunk;
          }
        })()
      );

      streamingResponse = new StreamingResponse(streamFactory, mockController, mockLogger);

      const transformer = vi
        .fn()
        .mockReturnValueOnce({ id: '1', kept: true })
        .mockReturnValueOnce(null)
        .mockReturnValueOnce({ id: '3', kept: true });

      const transformedStream = streamingResponse.transform(transformer);

      const results = [];
      for await (const chunk of transformedStream) {
        results.push(chunk);
      }

      expect(results).toHaveLength(2);
      expect(results[0].id).toBe('1');
      expect(results[1].id).toBe('3');
    });
  });

  describe('utility methods', () => {
    it('should take only specified number of chunks', async () => {
      const originalChunks = Array.from(
        { length: 5 },
        (_, i) => new ResponseChunk({ id: String(i + 1), model: 'test', provider: 'test' })
      );

      const streamFactory = vi.fn().mockResolvedValue(
        (async function* () {
          for (const chunk of originalChunks) {
            yield chunk;
          }
        })()
      );

      streamingResponse = new StreamingResponse(streamFactory, mockController, mockLogger);
      const limitedStream = streamingResponse.take(3);

      const results = [];
      for await (const chunk of limitedStream) {
        results.push(chunk);
      }

      expect(results).toHaveLength(3);
      expect(results.map(r => r.id)).toEqual(['1', '2', '3']);
    });

    it('should skip specified number of chunks', async () => {
      const originalChunks = Array.from(
        { length: 5 },
        (_, i) => new ResponseChunk({ id: String(i + 1), model: 'test', provider: 'test' })
      );

      const streamFactory = vi.fn().mockResolvedValue(
        (async function* () {
          for (const chunk of originalChunks) {
            yield chunk;
          }
        })()
      );

      streamingResponse = new StreamingResponse(streamFactory, mockController, mockLogger);
      const skippedStream = streamingResponse.skip(2);

      const results = [];
      for await (const chunk of skippedStream) {
        results.push(chunk);
      }

      expect(results).toHaveLength(3);
      expect(results.map(r => r.id)).toEqual(['3', '4', '5']);
    });
  });
});
