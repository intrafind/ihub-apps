import { describe, it, expect, jest, beforeEach } from '@jest/globals';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';

/**
 * What an MCP client gets back from a workflow tool: the answer and nothing
 * else. The answer is the `output` of the workflow's end step; text comes as
 * text, and JSON comes as JSON (`structuredContent`) next to the same JSON
 * written out as text for a client that reads only text. A run that did not
 * finish with an answer is an error. Driven through the real gateway over an
 * in-memory transport, which is also what shows that the SDK lets
 * `structuredContent` through for a tool without a declared output schema.
 */

const runTool = jest.fn();

jest.unstable_mockModule('../../toolLoader.js', () => ({
  loadConfiguredTools: jest.fn(async () => []),
  runTool,
  loadTools: jest.fn(async () => []),
  discoverMcpTools: jest.fn(async () => []),
  resolveNativeWebSearchProvider: jest.fn(() => null),
  resolveAppNativeWebSearch: jest.fn(() => null),
  getToolsForApp: jest.fn(async () => []),
  localizeTools: jest.fn(tools => tools),
  // The rest of toolLoader's exports: ESM link-checks every name an importer asks for.
  discoverA2aTools: jest.fn(async () => []),
  MAX_SKILL_NAME_ENUM: 100,
  DEFAULT_NATIVE_WEB_SEARCH_MAX_USES: 5,
  NATIVE_SEARCH_WITH_PAGE_READER: new Set(),
  NATIVE_WEB_SEARCH_FALLBACK_TOOL_ID: 'braveSearch',
  READ_URL_TOOL_ID: 'read_url',
  WEBSEARCH_TOOL_IDS: Object.freeze([]),
  resolveWebsearchToolId: jest.fn(() => null),
  describeWebSearchAvailability: jest.fn(async () => ({})),
  resolveNativeWebSearchFallbackTools: jest.fn(async () => [])
}));

const { default: configCache } = await import('../../configCache.js');
configCache.setCacheEntry('config/workflows.json', [
  {
    id: 'review',
    name: { en: 'Review' },
    description: { en: 'Reviews a statement.' },
    enabled: true,
    chatIntegration: { enabled: true },
    nodes: [{ id: 'start', type: 'start', config: { inputVariables: [] } }],
    edges: []
  }
]);

const { buildMcpServer, workflowToolResult } =
  await import('../../services/mcp/McpServerService.js');
const { MCP_SCOPES } = await import('../../services/mcp/scopes.js');

const user = {
  id: 'alice',
  scopes: [MCP_SCOPES.WORKFLOWS_RUN],
  permissions: { workflows: new Set(['review']) }
};

async function callReview() {
  const platform = {
    defaultLanguage: 'en',
    mcpServer: { expose: { tools: false, apps: false, workflows: true, resources: false } }
  };
  const server = await buildMcpServer({ user, platform });
  const client = new Client({ name: 'test-client', version: '0.0.0' }, { capabilities: {} });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  return client.callTool({ name: 'workflow__review', arguments: { input: 'a statement' } });
}

/** What the workflow runner resolves with for a finished run. */
const finished = output => ({
  status: 'completed',
  executionId: 'wf-exec-1',
  output,
  outputText: 'ignored: the gateway reads the output'
});

describe('the answer of a workflow tool', () => {
  beforeEach(() => runTool.mockReset());

  it('is text as text, without the run around it', async () => {
    runTool.mockResolvedValue(finished({ output: '# The review', topic: 'wind' }));
    const result = await callReview();
    expect(result.isError).toBeFalsy();
    expect(result.content).toEqual([{ type: 'text', text: '# The review' }]);
    expect(result.structuredContent).toBeUndefined();
  });

  it('is JSON as JSON, next to the same JSON as text', async () => {
    const answer = { verdict: 'ok', findings: [{ id: 1 }, { id: 2 }] };
    runTool.mockResolvedValue(finished({ output: answer, topic: 'wind' }));
    const result = await callReview();
    expect(result.isError).toBeFalsy();
    // Not a string: the JSON itself
    expect(result.structuredContent).toEqual({ output: answer });
    expect(JSON.parse(result.content[0].text)).toEqual(answer);
  });

  it('keeps a list as a list', async () => {
    runTool.mockResolvedValue(finished({ output: ['a', 'b'] }));
    const result = await callReview();
    expect(result.structuredContent).toEqual({ output: ['a', 'b'] });
  });

  it('is an error when the run did not finish with an answer', async () => {
    runTool.mockResolvedValue({
      status: 'failed',
      executionId: 'wf-exec-2',
      error: 'Node end failed: The end step has no output',
      outputText: 'Workflow failed: Node end failed: The end step has no output'
    });
    const result = await callReview();
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toBe('Node end failed: The end step has no output');
  });

  it('is empty text when the end step gave no answer', async () => {
    runTool.mockResolvedValue(finished({ output: '', topic: 'wind' }));
    const result = await callReview();
    expect(result.isError).toBeFalsy();
    expect(result.content).toEqual([{ type: 'text', text: '' }]);
  });
});

describe('workflowToolResult', () => {
  it('passes a plain text answer through', () => {
    expect(workflowToolResult('Just text')).toEqual({
      content: [{ type: 'text', text: 'Just text' }]
    });
  });

  it('writes numbers and booleans as text, not as JSON', () => {
    expect(workflowToolResult(finished({ output: 3 }))).toEqual({
      content: [{ type: 'text', text: '3' }]
    });
    expect(workflowToolResult(finished({ output: false }))).toEqual({
      content: [{ type: 'text', text: 'false' }]
    });
  });
});
