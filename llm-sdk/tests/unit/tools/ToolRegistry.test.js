/**
 * Unit tests for ToolRegistry
 */

import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import { ToolRegistry } from '../../../src/tools/ToolRegistry.js';

describe('ToolRegistry', () => {
  let registry;
  let mockLogger;

  beforeEach(() => {
    mockLogger = {
      debug: vi.fn(),
      warn: vi.fn(),
      error: vi.fn()
    };
    registry = new ToolRegistry(mockLogger);
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  describe('tool registration', () => {
    it('should register a simple tool', () => {
      const tool = {
        name: 'test_tool',
        description: 'A test tool',
        parameters: {
          type: 'object',
          properties: {
            query: { type: 'string', description: 'Query parameter' }
          },
          required: ['query']
        }
      };

      const result = registry.registerTool(tool);

      expect(result).toBe(registry); // Should return self for chaining
      expect(registry.hasTool('test_tool')).toBe(true);
      expect(registry.listTools()).toContain('test_tool');
    });

    it('should register tool with handler', () => {
      const handler = vi.fn().mockResolvedValue('result');
      const tool = {
        name: 'handled_tool',
        description: 'Tool with handler',
        handler
      };

      registry.registerTool(tool);

      expect(registry.hasHandler('handled_tool')).toBe(true);
      expect(registry.getHandler('handled_tool')).toBe(handler);
    });

    it('should normalize tool names', () => {
      const tool = {
        name: 'Tool With Spaces!',
        description: 'Test normalization'
      };

      registry.registerTool(tool);

      expect(registry.hasTool('Tool_With_Spaces_')).toBe(true);
      expect(registry.listTools()).toContain('Tool_With_Spaces_');
    });

    it('should handle tool names starting with numbers', () => {
      const tool = {
        name: '123invalid',
        description: 'Tool starting with number'
      };

      registry.registerTool(tool);

      expect(registry.listTools()).toContain('tool_123invalid');
    });

    it('should require tool name', () => {
      expect(() => {
        registry.registerTool({ description: 'No name' });
      }).toThrow('Tool name is required');
    });

    it('should require tool description', () => {
      expect(() => {
        registry.registerTool({ name: 'no_desc' });
      }).toThrow('Tool description is required');
    });

    it('should validate parameter schema', () => {
      expect(() => {
        registry.registerTool({
          name: 'invalid_schema',
          description: 'Invalid schema',
          parameters: 'not an object'
        });
      }).toThrow('Tool parameters must be a valid JSON schema');
    });

    it('should register multiple tools at once', () => {
      const tools = [
        { name: 'tool1', description: 'First tool' },
        { name: 'tool2', description: 'Second tool' },
        { name: 'tool3', description: 'Third tool' }
      ];

      registry.registerTools(tools);

      expect(registry.listTools()).toHaveLength(3);
      expect(registry.hasTool('tool1')).toBe(true);
      expect(registry.hasTool('tool2')).toBe(true);
      expect(registry.hasTool('tool3')).toBe(true);
    });
  });

  describe('tool retrieval', () => {
    beforeEach(() => {
      registry.registerTool({
        name: 'search',
        description: 'Search tool',
        parameters: {
          type: 'object',
          properties: {
            query: { type: 'string' },
            limit: { type: 'integer', default: 10 }
          },
          required: ['query']
        },
        metadata: { category: 'utility' }
      });
    });

    it('should retrieve tool definition', () => {
      const tool = registry.getTool('search');

      expect(tool).toBeDefined();
      expect(tool.name).toBe('search');
      expect(tool.description).toBe('Search tool');
      expect(tool.parameters.required).toContain('query');
      expect(tool.metadata.category).toBe('utility');
    });

    it('should return null for unknown tool', () => {
      expect(registry.getTool('unknown')).toBeNull();
    });

    it('should list all registered tools', () => {
      registry.registerTool({ name: 'another', description: 'Another tool' });

      const tools = registry.listTools();
      expect(tools).toHaveLength(2);
      expect(tools).toContain('search');
      expect(tools).toContain('another');
    });

    it('should get all tool definitions', () => {
      registry.registerTool({ name: 'calc', description: 'Calculator' });

      const allTools = registry.getAllTools();
      expect(allTools).toHaveLength(2);
      expect(allTools.map(t => t.name)).toContain('search');
      expect(allTools.map(t => t.name)).toContain('calc');
    });
  });

  describe('tool unregistration', () => {
    beforeEach(() => {
      registry.registerTool({
        name: 'temp_tool',
        description: 'Temporary tool',
        handler: vi.fn()
      });
    });

    it('should unregister tool and handler', () => {
      expect(registry.hasTool('temp_tool')).toBe(true);
      expect(registry.hasHandler('temp_tool')).toBe(true);

      const result = registry.unregisterTool('temp_tool');

      expect(result).toBe(true);
      expect(registry.hasTool('temp_tool')).toBe(false);
      expect(registry.hasHandler('temp_tool')).toBe(false);
    });

    it('should return false for non-existent tool', () => {
      const result = registry.unregisterTool('non_existent');
      expect(result).toBe(false);
    });
  });

  describe('provider converters', () => {
    beforeEach(() => {
      registry.registerTool({
        name: 'test_tool',
        description: 'Test tool for conversion',
        parameters: {
          type: 'object',
          properties: { input: { type: 'string' } }
        }
      });
    });

    it('should get tools formatted for OpenAI', () => {
      const tools = registry.getToolsForProvider('openai');

      expect(tools).toHaveLength(1);
      expect(tools[0]).toEqual({
        type: 'function',
        function: {
          name: 'test_tool',
          description: 'Test tool for conversion',
          parameters: {
            type: 'object',
            properties: { input: { type: 'string' } }
          }
        }
      });
    });

    it('should get tools formatted for Anthropic', () => {
      const tools = registry.getToolsForProvider('anthropic');

      expect(tools).toHaveLength(1);
      expect(tools[0]).toEqual({
        name: 'test_tool',
        description: 'Test tool for conversion',
        input_schema: {
          type: 'object',
          properties: { input: { type: 'string' } }
        }
      });
    });

    it('should get tools formatted for Google', () => {
      const tools = registry.getToolsForProvider('google');

      expect(tools).toHaveLength(1);
      expect(tools[0]).toEqual({
        functionDeclarations: [
          {
            name: 'test_tool',
            description: 'Test tool for conversion',
            parameters: {
              type: 'object',
              properties: { input: { type: 'string' } }
            }
          }
        ]
      });
    });

    it('should filter tools by name list', () => {
      registry.registerTool({ name: 'tool2', description: 'Second tool' });

      const tools = registry.getToolsForProvider('openai', ['test_tool']);

      expect(tools).toHaveLength(1);
      expect(tools[0].function.name).toBe('test_tool');
    });

    it('should throw error for unsupported provider', () => {
      expect(() => {
        registry.getToolsForProvider('unsupported');
      }).toThrow('No converter available for provider: unsupported');
    });
  });

  describe('tool call parsing', () => {
    it('should parse OpenAI tool calls', () => {
      const toolCalls = [
        {
          id: 'call_123',
          function: {
            name: 'search',
            arguments: '{"query": "test"}'
          }
        }
      ];

      const parsed = registry.parseToolCalls(toolCalls, 'openai');

      expect(parsed).toHaveLength(1);
      expect(parsed[0]).toEqual({
        id: 'call_123',
        name: 'search',
        arguments: { query: 'test' }
      });
    });

    it('should parse Anthropic tool calls', () => {
      const toolCalls = [
        {
          id: 'toolu_123',
          name: 'search',
          input: { query: 'test' }
        }
      ];

      const parsed = registry.parseToolCalls(toolCalls, 'anthropic');

      expect(parsed).toHaveLength(1);
      expect(parsed[0]).toEqual({
        id: 'toolu_123',
        name: 'search',
        arguments: { query: 'test' }
      });
    });

    it('should handle single tool call', () => {
      const toolCall = {
        id: 'call_456',
        function: { name: 'calc', arguments: '{"expr": "2+2"}' }
      };

      const parsed = registry.parseToolCalls(toolCall, 'openai');

      expect(parsed).toHaveLength(1);
      expect(parsed[0].name).toBe('calc');
    });

    it('should return empty array for null tool calls', () => {
      expect(registry.parseToolCalls(null, 'openai')).toEqual([]);
      expect(registry.parseToolCalls(undefined, 'openai')).toEqual([]);
    });
  });

  describe('tool response formatting', () => {
    it('should format successful results for OpenAI', () => {
      const results = [
        {
          toolCallId: 'call_123',
          name: 'search',
          result: { items: ['result1', 'result2'] },
          isSuccess: true
        }
      ];

      const formatted = registry.formatToolResponses(results, 'openai');

      expect(formatted).toHaveLength(1);
      expect(formatted[0]).toEqual({
        role: 'tool',
        tool_call_id: 'call_123',
        name: 'search',
        content: '{"items":["result1","result2"]}'
      });
    });

    it('should format error results for OpenAI', () => {
      const results = [
        {
          toolCallId: 'call_456',
          name: 'broken_tool',
          error: { message: 'Tool failed' },
          isSuccess: false
        }
      ];

      const formatted = registry.formatToolResponses(results, 'openai');

      expect(formatted[0].content).toBe('Error: Tool failed');
    });

    it('should format results for Anthropic', () => {
      const results = [
        {
          toolCallId: 'toolu_123',
          name: 'search',
          result: 'Success',
          isSuccess: true
        }
      ];

      const formatted = registry.formatToolResponses(results, 'anthropic');

      expect(formatted[0]).toEqual({
        role: 'user',
        content: [
          {
            type: 'tool_result',
            tool_use_id: 'toolu_123',
            content: 'Success',
            is_error: false
          }
        ]
      });
    });

    it('should return empty array for empty results', () => {
      expect(registry.formatToolResponses([], 'openai')).toEqual([]);
      expect(registry.formatToolResponses(null, 'openai')).toEqual([]);
    });
  });

  describe('custom converter registration', () => {
    it('should register custom converter', () => {
      const customConverter = {
        formatTool: vi.fn().mockReturnValue({ custom: 'tool' }),
        parseToolCall: vi.fn().mockReturnValue({ custom: 'call' }),
        formatToolResponse: vi.fn().mockReturnValue({ custom: 'response' })
      };

      registry.registerConverter('custom', customConverter);

      const tools = registry.getToolsForProvider('custom');
      expect(customConverter.formatTool).toHaveBeenCalled();
    });

    it('should validate converter interface', () => {
      const incompleteConverter = {
        formatTool: vi.fn()
        // Missing parseToolCall and formatToolResponse
      };

      expect(() => {
        registry.registerConverter('incomplete', incompleteConverter);
      }).toThrow('Converter must have parseToolCall method');
    });

    it('should require provider name', () => {
      const converter = {
        formatTool: vi.fn(),
        parseToolCall: vi.fn(),
        formatToolResponse: vi.fn()
      };

      expect(() => {
        registry.registerConverter('', converter);
      }).toThrow('Provider name is required');
    });
  });

  describe('registry management', () => {
    beforeEach(() => {
      registry.registerTool({ name: 'tool1', description: 'Tool 1', handler: vi.fn() });
      registry.registerTool({ name: 'tool2', description: 'Tool 2' });
    });

    it('should clear all tools', () => {
      expect(registry.listTools()).toHaveLength(2);

      registry.clear();

      expect(registry.listTools()).toHaveLength(0);
      expect(registry.hasHandler('tool1')).toBe(false);
    });

    it('should provide registry statistics', () => {
      const stats = registry.getStats();

      expect(stats.totalTools).toBe(2);
      expect(stats.toolsWithHandlers).toBe(1);
      expect(stats.supportedProviders).toBe(4); // openai, anthropic, google, mistral
      expect(stats.providers).toContain('openai');
      expect(stats.providers).toContain('anthropic');
    });
  });

  describe('name normalization', () => {
    it('should normalize various invalid characters', () => {
      expect(registry.normalizeToolName('tool@name#123')).toBe('tool_name_123');
      expect(registry.normalizeToolName('tool-name.version')).toBe('tool-name.version');
      expect(registry.normalizeToolName('tool name with spaces')).toBe('tool_name_with_spaces');
    });

    it('should handle empty or null names', () => {
      expect(registry.normalizeToolName('')).toBe('unnamed_tool');
      expect(registry.normalizeToolName(null)).toBe('unnamed_tool');
      expect(registry.normalizeToolName(undefined)).toBe('unnamed_tool');
    });

    it('should ensure names start with valid character', () => {
      expect(registry.normalizeToolName('123tool')).toBe('tool_123tool');
      expect(registry.normalizeToolName('-invalid')).toBe('tool_-invalid');
    });
  });

  describe('schema validation', () => {
    it('should validate correct schemas', () => {
      const validSchema = {
        type: 'object',
        properties: {
          query: { type: 'string' },
          limit: { type: 'number' }
        },
        required: ['query']
      };

      expect(registry.isValidJsonSchema(validSchema)).toBe(true);
    });

    it('should reject invalid schemas', () => {
      expect(registry.isValidJsonSchema(null)).toBe(false);
      expect(registry.isValidJsonSchema('not an object')).toBe(false);
      expect(registry.isValidJsonSchema({ type: 123 })).toBe(false);
      expect(registry.isValidJsonSchema({ required: 'not an array' })).toBe(false);
    });
  });
});
