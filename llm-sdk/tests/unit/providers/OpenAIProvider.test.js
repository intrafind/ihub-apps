import { OpenAIProvider } from '../../../src/providers/OpenAIProvider.js';
import { Message, ToolCall } from '../../../src/core/Message.js';
import { ConfigurationError } from '../../../src/utils/ErrorHandler.js';

describe('OpenAIProvider', () => {
  let provider;
  let mockConfig;

  beforeEach(() => {
    mockConfig = {
      apiKey: 'sk-test123456789012345678901234567890',
      logger: { child: jest.fn(() => ({ info: jest.fn(), error: jest.fn(), warn: jest.fn(), debug: jest.fn() })) }
    };
  });

  describe('constructor', () => {
    it('should initialize with valid config', () => {
      provider = new OpenAIProvider(mockConfig);
      expect(provider.name).toBe('openaiprovider');
      expect(provider.baseURL).toBe('https://api.openai.com/v1');
      expect(provider.models).toContain('gpt-4');
      expect(provider.models).toContain('gpt-3.5-turbo');
    });

    it('should allow custom baseURL', () => {
      const configWithCustomURL = {
        ...mockConfig,
        baseURL: 'https://custom.openai.com/v1'
      };
      provider = new OpenAIProvider(configWithCustomURL);
      expect(provider.baseURL).toBe('https://custom.openai.com/v1');
    });

    it('should throw ConfigurationError for invalid API key', () => {
      const invalidConfig = { ...mockConfig, apiKey: 'invalid-key' };
      expect(() => new OpenAIProvider(invalidConfig)).toThrow(ConfigurationError);
    });
  });

  describe('capabilities', () => {
    beforeEach(() => {
      provider = new OpenAIProvider(mockConfig);
    });

    it('should support tools', () => {
      expect(provider.supportsTools()).toBe(true);
    });

    it('should support images', () => {
      expect(provider.supportsImages()).toBe(true);
    });

    it('should support structured output', () => {
      expect(provider.supportsStructuredOutput()).toBe(true);
    });

    it('should support streaming', () => {
      expect(provider.supportsStreaming()).toBe(true);
    });

    it('should return correct context lengths', () => {
      expect(provider.getMaxContextLength('gpt-4')).toBe(8192);
      expect(provider.getMaxContextLength('gpt-4-turbo')).toBe(128000);
      expect(provider.getMaxContextLength('gpt-3.5-turbo')).toBe(16384);
    });

    it('should return correct output token limits', () => {
      expect(provider.getMaxOutputTokens('gpt-4')).toBe(4096);
      expect(provider.getMaxOutputTokens('gpt-3.5-turbo')).toBe(4096);
    });
  });

  describe('formatMessages', () => {
    beforeEach(() => {
      provider = new OpenAIProvider(mockConfig);
    });

    it('should format simple text message', () => {
      const messages = [Message.user('Hello')];
      const formatted = provider.formatMessages(messages);
      
      expect(formatted).toHaveLength(1);
      expect(formatted[0]).toEqual({
        role: 'user',
        content: 'Hello'
      });
    });

    it('should format message with images', () => {
      const messages = [Message.userWithImage('Look at this', 'https://example.com/image.jpg')];
      const formatted = provider.formatMessages(messages);
      
      expect(formatted).toHaveLength(1);
      expect(formatted[0].role).toBe('user');
      expect(Array.isArray(formatted[0].content)).toBe(true);
      expect(formatted[0].content).toHaveLength(2);
      expect(formatted[0].content[0].type).toBe('text');
      expect(formatted[0].content[1].type).toBe('image_url');
    });

    it('should format message with tool calls', () => {
      const toolCalls = [new ToolCall('call_1', 'test_tool', { param: 'value' })];
      const messages = [Message.assistantWithToolCalls('I will call a tool', toolCalls)];
      const formatted = provider.formatMessages(messages);
      
      expect(formatted).toHaveLength(1);
      expect(formatted[0].role).toBe('assistant');
      expect(formatted[0].tool_calls).toHaveLength(1);
      expect(formatted[0].tool_calls[0]).toEqual({
        id: 'call_1',
        type: 'function',
        function: {
          name: 'test_tool',
          arguments: '{"param":"value"}'
        }
      });
    });

    it('should format tool response message', () => {
      const messages = [Message.toolResponse('call_1', 'Success', 'test_tool')];
      const formatted = provider.formatMessages(messages);
      
      expect(formatted).toHaveLength(1);
      expect(formatted[0]).toEqual({
        role: 'tool',
        content: 'Success',
        tool_call_id: 'call_1',
        name: 'test_tool'
      });
    });
  });

  describe('formatTools', () => {
    beforeEach(() => {
      provider = new OpenAIProvider(mockConfig);
    });

    it('should format tools correctly', () => {
      const tools = [{
        name: 'test_tool',
        description: 'A test tool',
        parameters: {
          type: 'object',
          properties: {
            input: { type: 'string' }
          },
          required: ['input']
        }
      }];

      const formatted = provider.formatTools(tools);
      
      expect(formatted).toHaveLength(1);
      expect(formatted[0]).toEqual({
        type: 'function',
        function: {
          name: 'test_tool',
          description: 'A test tool',
          parameters: {
            type: 'object',
            properties: {
              input: { type: 'string' }
            },
            required: ['input']
          }
        }
      });
    });
  });

  describe('parseToolCalls', () => {
    beforeEach(() => {
      provider = new OpenAIProvider(mockConfig);
    });

    it('should parse tool calls from OpenAI message', () => {
      const openaiMessage = {
        role: 'assistant',
        content: null,
        tool_calls: [{
          id: 'call_1',
          type: 'function',
          function: {
            name: 'test_tool',
            arguments: '{"param":"value"}'
          }
        }]
      };

      const toolCalls = provider.parseToolCalls(openaiMessage);
      
      expect(toolCalls).toHaveLength(1);
      expect(toolCalls[0]).toBeInstanceOf(ToolCall);
      expect(toolCalls[0].id).toBe('call_1');
      expect(toolCalls[0].name).toBe('test_tool');
      expect(toolCalls[0].arguments).toEqual({ param: 'value' });
    });

    it('should handle invalid JSON in tool arguments', () => {
      const openaiMessage = {
        tool_calls: [{
          id: 'call_1',
          function: {
            name: 'test_tool',
            arguments: 'invalid json'
          }
        }]
      };

      const toolCalls = provider.parseToolCalls(openaiMessage);
      
      expect(toolCalls).toHaveLength(1);
      expect(toolCalls[0].arguments).toEqual({});
    });

    it('should return empty array for message without tool calls', () => {
      const openaiMessage = {
        role: 'assistant',
        content: 'Hello'
      };

      const toolCalls = provider.parseToolCalls(openaiMessage);
      expect(toolCalls).toHaveLength(0);
    });
  });

  describe('buildHttpRequest', () => {
    beforeEach(() => {
      provider = new OpenAIProvider(mockConfig);
    });

    it('should build basic chat request', () => {
      const request = {
        model: 'gpt-4',
        messages: [Message.user('Hello')],
        temperature: 0.7
      };

      const httpRequest = provider.buildHttpRequest(request);
      
      expect(httpRequest.url).toBe('https://api.openai.com/v1/chat/completions');
      expect(httpRequest.method).toBe('POST');
      expect(httpRequest.headers).toHaveProperty('Authorization');
      expect(httpRequest.body.model).toBe('gpt-4');
      expect(httpRequest.body.messages).toHaveLength(1);
      expect(httpRequest.body.temperature).toBe(0.7);
    });

    it('should include tools in request', () => {
      const tools = [{
        name: 'test_tool',
        description: 'A test tool',
        parameters: { type: 'object', properties: {} }
      }];

      const request = {
        model: 'gpt-4',
        messages: [Message.user('Hello')],
        tools,
        toolChoice: 'auto'
      };

      const httpRequest = provider.buildHttpRequest(request);
      
      expect(httpRequest.body.tools).toHaveLength(1);
      expect(httpRequest.body.tool_choice).toBe('auto');
    });

    it('should handle structured output', () => {
      const request = {
        model: 'gpt-4',
        messages: [Message.user('Hello')],
        responseFormat: {
          type: 'json_schema',
          schema: {
            type: 'object',
            properties: {
              answer: { type: 'string' }
            }
          }
        }
      };

      const httpRequest = provider.buildHttpRequest(request);
      
      expect(httpRequest.body.response_format).toBeDefined();
      expect(httpRequest.body.response_format.type).toBe('json_schema');
      expect(httpRequest.body.response_format.json_schema.strict).toBe(true);
    });
  });

  describe('enforceSchemaConstraints', () => {
    beforeEach(() => {
      provider = new OpenAIProvider(mockConfig);
    });

    it('should add additionalProperties: false to objects', () => {
      const schema = {
        type: 'object',
        properties: {
          nested: {
            type: 'object',
            properties: {
              value: { type: 'string' }
            }
          }
        }
      };

      const constrained = provider.enforceSchemaConstraints(schema);
      
      expect(constrained.additionalProperties).toBe(false);
      expect(constrained.properties.nested.additionalProperties).toBe(false);
    });

    it('should handle array items', () => {
      const schema = {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            value: { type: 'string' }
          }
        }
      };

      const constrained = provider.enforceSchemaConstraints(schema);
      
      expect(constrained.items.additionalProperties).toBe(false);
    });
  });

  describe('normalizeFinishReason', () => {
    beforeEach(() => {
      provider = new OpenAIProvider(mockConfig);
    });

    it('should normalize known finish reasons', () => {
      expect(provider.normalizeFinishReason('stop')).toBe('stop');
      expect(provider.normalizeFinishReason('length')).toBe('length');
      expect(provider.normalizeFinishReason('tool_calls')).toBe('tool_calls');
      expect(provider.normalizeFinishReason('content_filter')).toBe('content_filter');
    });

    it('should pass through unknown finish reasons', () => {
      expect(provider.normalizeFinishReason('unknown')).toBe('unknown');
    });

    it('should handle null finish reason', () => {
      expect(provider.normalizeFinishReason(null)).toBeNull();
      expect(provider.normalizeFinishReason(undefined)).toBeNull();
    });
  });

  describe('model info', () => {
    beforeEach(() => {
      provider = new OpenAIProvider(mockConfig);
    });

    it('should return available models', () => {
      const models = provider.getAvailableModels();
      expect(Array.isArray(models)).toBe(true);
      expect(models).toContain('gpt-4');
      expect(models).toContain('gpt-3.5-turbo');
    });

    it('should return model info for valid model', () => {
      const info = provider.getModelInfo('gpt-4');
      expect(info).toBeDefined();
      expect(info.id).toBe('gpt-4');
      expect(info.provider).toBe('openaiprovider');
      expect(info.capabilities.tools).toBe(true);
      expect(info.capabilities.images).toBe(true);
    });

    it('should return null for invalid model', () => {
      const info = provider.getModelInfo('invalid-model');
      expect(info).toBeNull();
    });

    it('should return pricing info', () => {
      const pricing = provider.getModelPricing('gpt-4');
      expect(pricing).toBeDefined();
      expect(typeof pricing.input).toBe('number');
      expect(typeof pricing.output).toBe('number');
    });
  });
});