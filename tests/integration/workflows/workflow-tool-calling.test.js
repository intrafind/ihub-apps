/**
 * Workflow Tool Calling Tests
 *
 * Tests for workflows that use real tools like googleSearch.
 *
 * NOTE: Structure tests run with Jest. Integration tests with real tools
 * require the workflow engine and should be run with the standalone test runner.
 */

import { toolCallingWorkflow } from './fixtures/mock-workflows.js';
import { skipIfNoApiKey, skipIfNoSearchApi } from './fixtures/workflow-test-utils.js';

describe('Tool Calling Workflow - Structure Tests', () => {
  describe('toolCallingWorkflow', () => {
    test('has correct structure', () => {
      expect(toolCallingWorkflow.id).toBe('test-tool-calling');
      expect(toolCallingWorkflow.config.maxIterations).toBe(10);
      expect(toolCallingWorkflow.config.allowCycles).toBe(false);
    });

    test('has start node with query input', () => {
      const startNode = toolCallingWorkflow.nodes.find(n => n.type === 'start');
      expect(startNode).toBeDefined();
      expect(startNode.config.inputVariables).toHaveLength(1);
      expect(startNode.config.inputVariables[0].name).toBe('query');
      expect(startNode.config.inputVariables[0].type).toBe('string');
    });

    test('has agent node with tool configuration', () => {
      const agentNode = toolCallingWorkflow.nodes.find(n => n.id === 'searcher');
      expect(agentNode).toBeDefined();
      expect(agentNode.type).toBe('agent');
    });

    test('agent node has googleSearch tool', () => {
      const agentNode = toolCallingWorkflow.nodes.find(n => n.id === 'searcher');
      expect(agentNode.config.tools).toBeDefined();
      expect(Array.isArray(agentNode.config.tools)).toBe(true);
      expect(agentNode.config.tools).toContain('googleSearch');
    });

    test('agent node has correct maxIterations for tool calling', () => {
      const agentNode = toolCallingWorkflow.nodes.find(n => n.id === 'searcher');
      expect(agentNode.config.maxIterations).toBe(3);
    });

    test('agent node has output variable', () => {
      const agentNode = toolCallingWorkflow.nodes.find(n => n.id === 'searcher');
      expect(agentNode.config.outputVariable).toBe('searchResults');
    });

    test('agent node has structured output schema', () => {
      const agentNode = toolCallingWorkflow.nodes.find(n => n.id === 'searcher');
      const schema = agentNode.config.outputSchema;

      expect(schema).toBeDefined();
      expect(schema.type).toBe('object');
      expect(schema.properties.summary).toBeDefined();
      expect(schema.properties.summary.type).toBe('string');
      expect(schema.properties.sources).toBeDefined();
      expect(schema.properties.sources.type).toBe('array');
    });

    test('has end node with searchResults output', () => {
      const endNode = toolCallingWorkflow.nodes.find(n => n.type === 'end');
      expect(endNode).toBeDefined();
      expect(endNode.config.outputVariables).toContain('searchResults');
    });

    test('has linear flow from start to end', () => {
      const edges = toolCallingWorkflow.edges;
      expect(edges).toHaveLength(2);

      const startToSearcher = edges.find(e => e.source === 'start' && e.target === 'searcher');
      const searcherToEnd = edges.find(e => e.source === 'searcher' && e.target === 'end');

      expect(startToSearcher).toBeDefined();
      expect(searcherToEnd).toBeDefined();
    });
  });
});

describe('Tool Configuration Validation', () => {
  test('tools array contains valid tool IDs', () => {
    const agentNode = toolCallingWorkflow.nodes.find(n => n.id === 'searcher');
    const tools = agentNode.config.tools;

    expect(tools.every(t => typeof t === 'string')).toBe(true);
    expect(tools.every(t => t.length > 0)).toBe(true);
  });

  test('maxIterations is reasonable for tool calls', () => {
    const agentNode = toolCallingWorkflow.nodes.find(n => n.id === 'searcher');
    const maxIterations = agentNode.config.maxIterations;

    // Should be between 1 and 10 for reasonable tool calling
    expect(maxIterations).toBeGreaterThanOrEqual(1);
    expect(maxIterations).toBeLessThanOrEqual(10);
  });

  test('workflow maxIterations allows for tool loops', () => {
    // Global workflow maxIterations should be >= agent node maxIterations
    const workflowMax = toolCallingWorkflow.config.maxIterations;
    const agentNode = toolCallingWorkflow.nodes.find(n => n.id === 'searcher');
    const agentMax = agentNode.config.maxIterations;

    expect(workflowMax).toBeGreaterThanOrEqual(agentMax);
  });
});

describe('System and Prompt Configuration', () => {
  test('agent has system prompt', () => {
    const agentNode = toolCallingWorkflow.nodes.find(n => n.id === 'searcher');
    expect(agentNode.config.system).toBeDefined();
    expect(agentNode.config.system.en).toBeDefined();
    expect(agentNode.config.system.en.length).toBeGreaterThan(10);
  });

  test('system prompt mentions tools', () => {
    const agentNode = toolCallingWorkflow.nodes.find(n => n.id === 'searcher');
    const systemPrompt = agentNode.config.system.en.toLowerCase();

    expect(systemPrompt).toContain('search');
  });

  test('agent has prompt with query variable', () => {
    const agentNode = toolCallingWorkflow.nodes.find(n => n.id === 'searcher');
    expect(agentNode.config.prompt).toBeDefined();
    expect(agentNode.config.prompt.en).toContain('{{query}}');
  });

  test('prompt instructs to use googleSearch tool', () => {
    const agentNode = toolCallingWorkflow.nodes.find(n => n.id === 'searcher');
    const prompt = agentNode.config.prompt.en.toLowerCase();

    expect(prompt).toContain('googlesearch');
  });
});

describe('API Configuration Check', () => {
  test('skipIfNoApiKey works correctly', () => {
    const result = skipIfNoApiKey();
    expect(typeof result).toBe('boolean');
  });

  test('skipIfNoSearchApi works correctly', () => {
    const result = skipIfNoSearchApi();
    expect(typeof result).toBe('boolean');

    // If we have the API key, we should have the CX too
    if (process.env.GOOGLE_SEARCH_API_KEY && !process.env.GOOGLE_SEARCH_CX) {
      console.warn('GOOGLE_SEARCH_API_KEY is set but GOOGLE_SEARCH_CX is missing');
    }
  });
});

describe('Edge Cases and Error Handling', () => {
  test('workflow has no orphan nodes', () => {
    const nodeIds = new Set(toolCallingWorkflow.nodes.map(n => n.id));
    const connectedNodes = new Set();

    // Add nodes that are sources or targets in edges
    toolCallingWorkflow.edges.forEach(edge => {
      connectedNodes.add(edge.source);
      connectedNodes.add(edge.target);
    });

    // Every node should be connected (start has no incoming, end has no outgoing)
    nodeIds.forEach(nodeId => {
      expect(connectedNodes.has(nodeId)).toBe(true);
    });
  });

  test('no edges reference non-existent nodes', () => {
    const nodeIds = new Set(toolCallingWorkflow.nodes.map(n => n.id));

    toolCallingWorkflow.edges.forEach(edge => {
      expect(nodeIds.has(edge.source)).toBe(true);
      expect(nodeIds.has(edge.target)).toBe(true);
    });
  });
});
