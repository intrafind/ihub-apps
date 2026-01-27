/**
 * Tests for iFinder adapter
 */
import IFinderAdapter from '../adapters/ifinder.js';
import logger from '../utils/logger.js';

describe('iFinder Adapter', () => {
  const mockModel = {
    id: 'ifinder-dama-dev',
    provider: 'ifinder',
    config: {
      baseUrl: 'https://dama.dev.intrafind.io',
      uuid: 'test-uuid',
      searchFields: { creators: '', 'file.name': '' },
      searchMode: 'multiword',
      searchDistance: '',
      profileId: 'test-profile',
      filter: [{ key: 'application.keyword', values: ['PDF'], isNegated: false }]
    }
  };

  describe('formatMessages', () => {
    test('should extract last user message', () => {
      const messages = [
        { role: 'system', content: 'You are a helpful assistant.' },
        { role: 'user', content: 'First question' },
        { role: 'assistant', content: 'First answer' },
        { role: 'user', content: 'Second question' }
      ];

      const result = IFinderAdapter.formatMessages(messages);
      expect(result).toBe('Second question');
    });

    test('should throw error when no user message found', () => {
      const messages = [
        { role: 'system', content: 'You are a helpful assistant.' },
        { role: 'assistant', content: 'Hello there!' }
      ];

      expect(() => IFinderAdapter.formatMessages(messages)).toThrow(
        'No user message found for iFinder query'
      );
    });
  });

  describe('createCompletionRequest', () => {
    test('should create valid request object with authenticated user', () => {
      const messages = [{ role: 'user', content: 'What is protocol WP29522?' }];
      const user = {
        id: 'test-user',
        email: 'test@example.com',
        name: 'Test User'
      };
      const options = { user };

      // Mock the JWT generation to avoid needing actual private key
      const originalGetAuthHeader = require('../utils/iFinderJwt.js').getIFinderAuthorizationHeader;
      require('../utils/iFinderJwt.js').getIFinderAuthorizationHeader = jest
        .fn()
        .mockReturnValue('Bearer test-jwt-token');

      const result = IFinderAdapter.createCompletionRequest(mockModel, messages, null, options);

      expect(result).toHaveProperty('url');
      expect(result).toHaveProperty('method', 'POST');
      expect(result).toHaveProperty('headers');
      expect(result).toHaveProperty('body');

      // Check URL structure
      expect(result.url).toContain('dama.dev.intrafind.io');
      expect(result.url).toContain('internal-api/v2/rag/ask');
      expect(result.url).toContain('uuid=test-uuid');

      // Check headers
      expect(result.headers['Accept']).toBe('text/event-stream');
      expect(result.headers['content-type']).toBe('application/json');
      expect(result.headers['Authorization']).toBe('Bearer test-jwt-token');

      // Check body
      const body = JSON.parse(result.body);
      expect(body.question).toBe('What is protocol WP29522?');
      expect(body.metaData).toBe(true);
      expect(body.telemetry).toBe(true);
      expect(body.filter).toEqual(mockModel.config.filter);

      // Restore original function
      require('../utils/iFinderJwt.js').getIFinderAuthorizationHeader = originalGetAuthHeader;
    });

    test('should throw error for anonymous user', () => {
      const messages = [{ role: 'user', content: 'Test question' }];
      const user = { id: 'anonymous' };
      const options = { user };

      expect(() =>
        IFinderAdapter.createCompletionRequest(mockModel, messages, null, options)
      ).toThrow('iFinder requires authenticated user access - anonymous access not supported');
    });

    test('should throw error when no user provided', () => {
      const messages = [{ role: 'user', content: 'Test question' }];

      expect(() => IFinderAdapter.createCompletionRequest(mockModel, messages, null, {})).toThrow(
        'iFinder requires authenticated user access - anonymous access not supported'
      );
    });
  });

  describe('processResponseBuffer', () => {
    test('should process SSE events correctly', () => {
      const sseBuffer = [
        'event:telemetry',
        'data:{"telemetry":"{\\"usage\\":{\\"total_tokens\\":100}}"}',
        '',
        'event:passages',
        'data:{"passages":[{"id":"doc1","text":"Sample text","score":0.8}]}',
        '',
        'event:answer',
        'data:{"answer":"This is"}',
        '',
        'event:answer',
        'data:{"answer":" the answer"}',
        '',
        'event:done',
        'data:{}',
        ''
      ].join('\\n');

      const result = IFinderAdapter.processResponseBuffer(sseBuffer);

      expect(result.content).toEqual(['This is', ' the answer']);
      expect(result.complete).toBe(true);
      expect(result.finishReason).toBe('stop');
      expect(result.passages).toHaveLength(1);
      expect(result.passages[0]).toMatchObject({
        id: 'doc1',
        text: 'Sample text',
        score: 0.8
      });
      expect(result.telemetry).toMatchObject({
        usage: { total_tokens: 100 }
      });
    });

    test('should handle malformed events gracefully', () => {
      const sseBuffer = [
        'event:answer',
        'data:invalid-json',
        '',
        'event:answer',
        'data:{"answer":"valid answer"}',
        ''
      ].join('\\n');

      const result = IFinderAdapter.processResponseBuffer(sseBuffer);

      expect(result.content).toEqual(['valid answer']);
      expect(result.complete).toBe(false);
    });
  });

  describe('getModelInfo', () => {
    test('should return correct model information', () => {
      const info = IFinderAdapter.getModelInfo();

      expect(info).toEqual({
        provider: 'ifinder',
        supportsStreaming: true,
        supportsImages: false,
        supportsTools: false,
        maxTokens: null,
        contextWindow: null
      });
    });
  });
});
