/**
 * Unit tests for VLLMProvider
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { VLLMProvider } from '../../../src/providers/VLLMProvider.js';

describe('VLLMProvider', () => {
  let provider;
  const mockConfig = {
    baseURL: 'http://localhost:8000/v1',
    apiKey: 'test-key' // Optional for VLLM
  };

  beforeEach(() => {
    provider = new VLLMProvider(mockConfig);
  });

  describe('initialization', () => {
    it('should initialize with baseURL configuration', () => {
      expect(provider.baseURL).toBe('http://localhost:8000/v1');
      expect(provider.name).toBe('vllm');
    });

    it('should work without API key', () => {
      const noKeyConfig = { baseURL: 'http://localhost:8000/v1' };
      expect(() => new VLLMProvider(noKeyConfig)).not.toThrow();
    });

    it('should require baseURL', () => {
      expect(() => new VLLMProvider({})).toThrow(
        'VLLM requires either baseURL or url configuration'
      );
    });

    it('should have correct model list', () => {
      const models = provider.getAvailableModels();
      expect(models).toContain('local-llama-2-7b');
      expect(models).toContain('local-mistral-7b');
      expect(models).toContain('custom-model');
    });
  });

  describe('capabilities', () => {
    it('should support required capabilities', () => {
      expect(provider.supportsTools()).toBe(true);
      expect(provider.supportsImages()).toBe(true);
      expect(provider.supportsStructuredOutput()).toBe(false); // Limited in VLLM
      expect(provider.supportsStreaming()).toBe(true);
    });

    it('should return conservative context lengths', () => {
      expect(provider.getMaxContextLength('local-llama-2-7b')).toBe(4096);
      expect(provider.getMaxContextLength('local-mistral-7b')).toBe(32000);
      expect(provider.getMaxContextLength('unknown-model')).toBe(4096);
    });

    it('should return conservative output token limits', () => {
      expect(provider.getMaxOutputTokens('any-model')).toBe(2048);
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

    it('should handle empty content for tool calls', () => {
      const messages = [
        {
          role: 'assistant',
          content: '',
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

      expect(formatted[0].content).toBeNull(); // VLLM compatibility
      expect(formatted[0].tool_calls).toHaveLength(1);
    });

    it('should format messages with images', () => {
      const messages = [
        {
          role: 'user',
          content: [
            { type: 'text', data: { text: 'Describe this image' } },
            { type: 'image', data: { base64: 'base64data', mimeType: 'image/png' } }
          ]
        }
      ];

      const formatted = provider.formatMessages(messages);

      expect(formatted[0].content).toHaveLength(2);
      expect(formatted[0].content[1].type).toBe('image_url');
      expect(formatted[0].content[1].image_url.url).toBe('data:image/png;base64,base64data');
    });
  });

  describe('tool formatting', () => {
    it('should format tools with schema sanitization', () => {
      const tools = [
        {
          name: 'complex_tool',
          description: 'A complex tool with unsupported features',
          parameters: {
            type: 'object',
            properties: {
              query: { type: 'string', format: 'uri' }, // format may be removed
              options: {
                type: 'object',
                additionalProperties: true, // will be removed
                properties: {
                  limit: { type: 'integer' }
                }
              }
            },
            additionalProperties: false, // will be removed
            required: ['query']
          }
        }
      ];

      const formatted = provider.formatTools(tools);
      const sanitizedParams = formatted[0].function.parameters;

      expect(formatted).toHaveLength(1);
      expect(formatted[0].type).toBe('function');
      expect(sanitizedParams.additionalProperties).toBeUndefined();
      expect(sanitizedParams.properties.options.additionalProperties).toBeUndefined();
    });

    it('should sanitize nested schema objects', () => {
      const schema = {
        type: 'object',
        properties: {
          nested: {
            type: 'object',
            allOf: [{ type: 'object' }], // unsupported, will be removed
            properties: {
              value: { type: 'string' }
            }
          }
        }
      };

      const sanitized = provider.sanitizeSchema(schema);

      expect(sanitized.properties.nested.allOf).toBeUndefined();
      expect(sanitized.properties.nested.properties.value).toBeDefined();
    });
  });

  describe('HTTP request building', () => {
    it('should build correct HTTP request', () => {
      const request = {
        model: 'local-llama-2-7b',
        messages: [{ role: 'user', content: 'Hello' }],
        temperature: 0.8,
        maxTokens: 1000,
        stream: false
      };

      const httpRequest = provider.buildHttpRequest(request);

      expect(httpRequest.url).toBe('http://localhost:8000/v1/chat/completions');
      expect(httpRequest.method).toBe('POST');
      expect(httpRequest.body.model).toBe('local-llama-2-7b');
      expect(httpRequest.body.temperature).toBe(0.8);
      expect(httpRequest.body.max_tokens).toBe(1000);
      expect(httpRequest.body.stream).toBe(false);
    });

    it('should handle different endpoint URL formats', () => {
      const providerWithDifferentURL = new VLLMProvider({
        baseURL: 'http://localhost:8000/v1/chat/completions' // Full endpoint URL
      });

      const request = {
        model: 'test-model',
        messages: [{ role: 'user', content: 'Hello' }]
      };

      const httpRequest = providerWithDifferentURL.buildHttpRequest(request);

      expect(httpRequest.url).toBe('http://localhost:8000/v1/chat/completions');
    });

    it('should include tools with sanitized schemas', () => {
      const request = {
        model: 'local-model',
        messages: [{ role: 'user', content: 'Hello' }],
        tools: [
          {
            name: 'test_tool',
            description: 'A test tool',
            parameters: {
              type: 'object',
              properties: { query: { type: 'string' } },
              additionalProperties: true // will be sanitized
            }
          }
        ]
      };

      const httpRequest = provider.buildHttpRequest(request);

      expect(httpRequest.body.tools).toHaveLength(1);
      expect(httpRequest.body.tools[0].function.parameters.additionalProperties).toBeUndefined();
    });

    it('should only include basic response format', () => {
      const request = {
        model: 'local-model',
        messages: [{ role: 'user', content: 'Hello' }],
        responseFormat: { type: 'json_object' }
      };

      const httpRequest = provider.buildHttpRequest(request);

      expect(httpRequest.body.response_format).toEqual({ type: 'json_object' });
    });
  });

  describe('response parsing', () => {
    it('should parse successful response', () => {
      const vllmResponse = {
        id: 'vllm-123',
        choices: [
          {
            index: 0,
            message: {
              role: 'assistant',
              content: 'Hello from VLLM!'
            },
            finish_reason: 'stop'
          }
        ],
        usage: {
          prompt_tokens: 8,
          completion_tokens: 4,
          total_tokens: 12
        }
      };

      const response = provider.parseResponse(vllmResponse, { model: 'local-model' });

      expect(response.id).toBe('vllm-123');
      expect(response.model).toBe('local-model');
      expect(response.provider).toBe('vllm');
      expect(response.choices[0].message.content).toBe('Hello from VLLM!');
      expect(response.usage.totalTokens).toBe(12);
    });

    it('should handle error responses', () => {
      const errorResponse = {
        error: {
          message: 'Model not found',
          code: 'model_not_found'
        }
      };

      expect(() => {
        provider.parseResponse(errorResponse, { model: 'invalid-model' });
      }).toThrow('VLLM API error');
    });
  });

  describe('model information', () => {
    it('should return model information for known models', () => {
      const modelInfo = provider.getModelInfo('local-mistral-7b');

      expect(modelInfo).toBeDefined();
      expect(modelInfo.id).toBe('local-mistral-7b');
      expect(modelInfo.provider).toBe('vllm');
      expect(modelInfo.capabilities.tools).toBe(true);
      expect(modelInfo.capabilities.structuredOutput).toBe(false);
      expect(modelInfo.pricing).toBeNull(); // No pricing for local models
    });

    it('should return custom model info for unknown models', () => {
      const modelInfo = provider.getModelInfo('my-custom-model');

      expect(modelInfo).toBeDefined();
      expect(modelInfo.id).toBe('my-custom-model');
      expect(modelInfo.capabilities.tools).toBe(true);
      expect(modelInfo.limits.maxTokens).toBe(2048);
      expect(modelInfo.limits.contextLength).toBe(4096);
    });

    it('should identify code generation models', () => {
      const codeModelInfo = provider.getModelInfo('local-codellama-34b');

      expect(codeModelInfo.capabilities.codeGeneration).toBe(true);
    });

    it('should identify vision models', () => {
      const visionModelInfo = provider.getModelInfo('local-llava-model');

      expect(visionModelInfo.capabilities.images).toBe(true);
    });
  });

  describe('validation', () => {
    it('should require baseURL or url', () => {
      expect(() => new VLLMProvider({})).toThrow(
        'VLLM requires either baseURL or url configuration'
      );
    });

    it('should accept url instead of baseURL', () => {
      const config = { url: 'http://localhost:8000' };
      const provider = new VLLMProvider(config);
      expect(provider.baseURL).toBe('http://localhost:8000');
    });

    it('should provide placeholder API key when none provided', () => {
      const config = { baseURL: 'http://localhost:8000' };
      const provider = new VLLMProvider(config);
      expect(provider.config.apiKey).toBe('no-key-required');
    });
  });

  describe('headers creation', () => {
    it('should create headers without auth for placeholder key', () => {
      const provider = new VLLMProvider({
        baseURL: 'http://localhost:8000',
        apiKey: 'no-key-required'
      });

      const headers = provider.createHeaders();

      expect(headers['Content-Type']).toBe('application/json');
      expect(headers.Authorization).toBeUndefined();
    });

    it('should include auth header for real API key', () => {
      const provider = new VLLMProvider({
        baseURL: 'http://localhost:8000',
        apiKey: 'real-api-key'
      });

      const headers = provider.createHeaders();

      expect(headers.Authorization).toBe('Bearer real-api-key');
    });
  });
});
