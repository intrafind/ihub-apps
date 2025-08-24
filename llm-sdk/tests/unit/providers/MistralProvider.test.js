/**
 * Unit tests for MistralProvider
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { MistralProvider } from '../../../src/providers/MistralProvider.js';

describe('MistralProvider', () => {
  let provider;
  const mockConfig = {
    apiKey: 'test-mistral-key',
    baseURL: 'https://api.mistral.ai/v1'
  };

  beforeEach(() => {
    provider = new MistralProvider(mockConfig);
  });

  describe('initialization', () => {
    it('should initialize with correct configuration', () => {
      expect(provider.config.apiKey).toBe('test-mistral-key');
      expect(provider.baseURL).toBe('https://api.mistral.ai/v1');
      expect(provider.name).toBe('mistral');
    });

    it('should have correct model list', () => {
      const models = provider.getAvailableModels();
      expect(models).toContain('mistral-small');
      expect(models).toContain('mistral-large');
      expect(models).toContain('open-mistral-7b');
    });
  });

  describe('capabilities', () => {
    it('should support required capabilities', () => {
      expect(provider.supportsTools()).toBe(true);
      expect(provider.supportsImages()).toBe(true);
      expect(provider.supportsStructuredOutput()).toBe(true);
      expect(provider.supportsStreaming()).toBe(true);
    });

    it('should return correct context lengths', () => {
      expect(provider.getMaxContextLength('mistral-small')).toBe(32000);
      expect(provider.getMaxContextLength('open-mixtral-8x22b')).toBe(64000);
      expect(provider.getMaxContextLength('unknown-model')).toBe(32000);
    });
  });

  describe('message formatting', () => {
    it('should format simple text messages', () => {
      const messages = [
        { role: 'user', content: 'Hello' },
        { role: 'assistant', content: 'Hi there!' }
      ];

      const formatted = provider.formatMessages(messages);

      expect(formatted).toHaveLength(2);
      expect(formatted[0]).toEqual({ role: 'user', content: 'Hello' });
      expect(formatted[1]).toEqual({ role: 'assistant', content: 'Hi there!' });
    });

    it('should format messages with image content', () => {
      const messages = [
        {
          role: 'user',
          content: [
            { type: 'text', data: { text: 'What is in this image?' } },
            { type: 'image', data: { base64: 'base64data', mimeType: 'image/jpeg' } }
          ]
        }
      ];

      const formatted = provider.formatMessages(messages);

      expect(formatted[0].content).toHaveLength(2);
      expect(formatted[0].content[0]).toEqual({ type: 'text', text: 'What is in this image?' });
      expect(formatted[0].content[1]).toEqual({
        type: 'image_url',
        image_url: {
          url: 'data:image/jpeg;base64,base64data',
          detail: 'high'
        }
      });
    });

    it('should format messages with tool calls', () => {
      const messages = [
        {
          role: 'assistant',
          content: 'I need to call a function',
          toolCalls: [
            {
              id: 'call_123',
              name: 'get_weather',
              arguments: { location: 'Paris' }
            }
          ]
        }
      ];

      const formatted = provider.formatMessages(messages);

      expect(formatted[0].tool_calls).toHaveLength(1);
      expect(formatted[0].tool_calls[0]).toEqual({
        id: 'call_123',
        type: 'function',
        function: {
          name: 'get_weather',
          arguments: '{"location":"Paris"}'
        }
      });
    });
  });

  describe('tool formatting', () => {
    it('should format tools correctly', () => {
      const tools = [
        {
          name: 'get_weather',
          description: 'Get weather information',
          parameters: {
            type: 'object',
            properties: {
              location: { type: 'string', description: 'City name' }
            },
            required: ['location']
          }
        }
      ];

      const formatted = provider.formatTools(tools);

      expect(formatted).toHaveLength(1);
      expect(formatted[0]).toEqual({
        type: 'function',
        function: {
          name: 'get_weather',
          description: 'Get weather information',
          parameters: {
            type: 'object',
            properties: {
              location: { type: 'string', description: 'City name' }
            },
            required: ['location']
          }
        }
      });
    });

    it('should parse tool calls from response', () => {
      const message = {
        tool_calls: [
          {
            id: 'call_456',
            function: {
              name: 'search',
              arguments: '{"query":"AI"}'
            }
          }
        ]
      };

      const toolCalls = provider.parseToolCalls(message);

      expect(toolCalls).toHaveLength(1);
      expect(toolCalls[0].id).toBe('call_456');
      expect(toolCalls[0].name).toBe('search');
      expect(toolCalls[0].arguments).toEqual({ query: 'AI' });
    });

    it('should handle malformed tool call arguments', () => {
      const message = {
        tool_calls: [
          {
            id: 'call_789',
            function: {
              name: 'broken',
              arguments: 'invalid json'
            }
          }
        ]
      };

      const toolCalls = provider.parseToolCalls(message);

      expect(toolCalls).toHaveLength(1);
      expect(toolCalls[0].arguments).toEqual({});
    });
  });

  describe('HTTP request building', () => {
    it('should build correct HTTP request', () => {
      const request = {
        model: 'mistral-small',
        messages: [{ role: 'user', content: 'Hello' }],
        temperature: 0.7,
        maxTokens: 1000,
        stream: false
      };

      const httpRequest = provider.buildHttpRequest(request);

      expect(httpRequest.url).toBe('https://api.mistral.ai/v1/chat/completions');
      expect(httpRequest.method).toBe('POST');
      expect(httpRequest.body.model).toBe('mistral-small');
      expect(httpRequest.body.temperature).toBe(0.7);
      expect(httpRequest.body.max_tokens).toBe(1000);
      expect(httpRequest.body.stream).toBe(false);
    });

    it('should include tools in request when provided', () => {
      const request = {
        model: 'mistral-small',
        messages: [{ role: 'user', content: 'Hello' }],
        tools: [
          {
            name: 'test_tool',
            description: 'A test tool',
            parameters: { type: 'object', properties: {} }
          }
        ],
        toolChoice: 'auto'
      };

      const httpRequest = provider.buildHttpRequest(request);

      expect(httpRequest.body.tools).toHaveLength(1);
      expect(httpRequest.body.tool_choice).toBe('auto');
    });

    it('should include structured output in request', () => {
      const request = {
        model: 'mistral-small',
        messages: [{ role: 'user', content: 'Hello' }],
        responseFormat: {
          type: 'json_schema',
          schema: {
            type: 'object',
            properties: {
              result: { type: 'string' }
            }
          }
        }
      };

      const httpRequest = provider.buildHttpRequest(request);

      expect(httpRequest.body.response_format).toEqual({
        type: 'json_schema',
        json_schema: {
          schema: {
            type: 'object',
            properties: {
              result: { type: 'string' }
            }
          },
          name: 'response',
          strict: true
        }
      });
    });
  });

  describe('response parsing', () => {
    it('should parse complete response correctly', () => {
      const mistralResponse = {
        id: 'chatcmpl-123',
        choices: [
          {
            index: 0,
            message: {
              role: 'assistant',
              content: 'Hello there!'
            },
            finish_reason: 'stop'
          }
        ],
        usage: {
          prompt_tokens: 10,
          completion_tokens: 5,
          total_tokens: 15
        },
        created: Date.now()
      };

      const response = provider.parseResponse(mistralResponse, { model: 'mistral-small' });

      expect(response.id).toBe('chatcmpl-123');
      expect(response.model).toBe('mistral-small');
      expect(response.provider).toBe('mistral');
      expect(response.choices).toHaveLength(1);
      expect(response.choices[0].message.content).toBe('Hello there!');
      expect(response.choices[0].finishReason).toBe('stop');
      expect(response.usage.totalTokens).toBe(15);
    });

    it('should handle complex content format in response', () => {
      const mistralResponse = {
        id: 'chatcmpl-456',
        choices: [
          {
            index: 0,
            message: {
              role: 'assistant',
              content: [{ type: 'text', text: 'Complex response' }]
            },
            finish_reason: 'stop'
          }
        ]
      };

      const response = provider.parseResponse(mistralResponse, { model: 'mistral-small' });

      expect(response.choices[0].message.content).toBe('Complex response');
    });
  });

  describe('validation', () => {
    it('should validate configuration', () => {
      expect(() => new MistralProvider({})).toThrow('Mistral API key is required');
    });

    it('should accept valid configuration', () => {
      const validConfig = { apiKey: 'test-key' };
      expect(() => new MistralProvider(validConfig)).not.toThrow();
    });
  });

  describe('model information', () => {
    it('should return model information', () => {
      const modelInfo = provider.getModelInfo('mistral-large');

      expect(modelInfo).toBeDefined();
      expect(modelInfo.id).toBe('mistral-large');
      expect(modelInfo.provider).toBe('mistral');
      expect(modelInfo.capabilities.tools).toBe(true);
      expect(modelInfo.capabilities.images).toBe(true);
      expect(modelInfo.capabilities.structuredOutput).toBe(true);
    });

    it('should return null for unknown model', () => {
      const modelInfo = provider.getModelInfo('unknown-model');
      expect(modelInfo).toBeNull();
    });

    it('should return pricing information', () => {
      const pricing = provider.getModelPricing('mistral-small');
      expect(pricing).toEqual({ input: 2, output: 6 });
    });
  });
});
