import { describe, it, expect } from '@jest/globals';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import {
  jsonSchemaToInputSchema,
  buildAppInputSchema,
  buildWorkflowMcpParams
} from '../../services/mcp/McpServerService.js';

/**
 * Regression test for the MCP gateway advertising EMPTY input schemas.
 *
 * The gateway builds a correct JSON Schema (with `message`/`input` + declared
 * variables) but used to hand it to the SDK under a `jsonSchema` config key.
 * SDK 1.x `registerTool` only reads `inputSchema` and requires a Zod raw shape,
 * so it ignored our schema and every tool advertised `{ properties: {} }`.
 * Clients then stripped all arguments and calls failed with
 * "Missing required argument: 'message'".
 *
 * These tests drive the REAL SDK path (registerTool -> tools/list -> tools/call)
 * over an in-memory transport, so a regression here reproduces the exact
 * client-visible failure.
 */

async function connect(registerToolsFn) {
  const server = new McpServer(
    { name: 'test', version: '0.0.0' },
    { capabilities: { tools: { listChanged: false } } }
  );
  registerToolsFn(server);

  const client = new Client({ name: 'test-client', version: '0.0.0' }, { capabilities: {} });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  return { server, client };
}

describe('MCP gateway input schema advertisement', () => {
  it('advertises message (required) plus declared variables for an app tool', async () => {
    const app = {
      id: 'web-chat',
      description: 'General chat assistant',
      variables: [
        { name: 'tone', type: 'string', required: false, description: 'Desired tone' },
        { name: 'count', type: 'number', required: true, label: 'Count' }
      ]
    };

    const { client } = await connect(server => {
      server.registerTool(
        `app__${app.id}`,
        { description: 'chat', ...jsonSchemaToInputSchema(buildAppInputSchema(app)) },
        async () => ({ content: [{ type: 'text', text: 'ok' }] })
      );
    });

    const { tools } = await client.listTools();
    const tool = tools.find(t => t.name === 'app__web-chat');
    expect(tool).toBeDefined();

    // The whole point: properties must NOT be empty.
    expect(tool.inputSchema.type).toBe('object');
    expect(Object.keys(tool.inputSchema.properties)).toEqual(
      expect.arrayContaining(['message', 'tone', 'count'])
    );
    expect(tool.inputSchema.properties.message.type).toBe('string');
    expect(tool.inputSchema.properties.count.type).toBe('number');
    // message is always required; a required variable is too; optional var is not.
    expect(tool.inputSchema.required).toEqual(expect.arrayContaining(['message', 'count']));
    expect(tool.inputSchema.required).not.toContain('tone');
  });

  it('passes declared args to the handler and strips undeclared ones', async () => {
    const app = {
      id: 'web-chat',
      variables: [{ name: 'tone', type: 'string', required: false }]
    };
    let received;

    const { client } = await connect(server => {
      server.registerTool(
        `app__${app.id}`,
        { description: 'chat', ...jsonSchemaToInputSchema(buildAppInputSchema(app)) },
        async args => {
          received = args;
          return { content: [{ type: 'text', text: 'ok' }] };
        }
      );
    });

    await client.callTool({
      name: 'app__web-chat',
      arguments: { message: 'who is daniel manzke?', tone: 'formal', bogus: 'x' }
    });

    expect(received.message).toBe('who is daniel manzke?');
    expect(received.tone).toBe('formal');
    // Undeclared keys are stripped by the Zod object (default strip behaviour).
    expect(received.bogus).toBeUndefined();
  });

  it('rejects a call missing the required message argument', async () => {
    const { client } = await connect(server => {
      server.registerTool(
        'app__web-chat',
        {
          description: 'chat',
          ...jsonSchemaToInputSchema(buildAppInputSchema({ id: 'web-chat' }))
        },
        async () => ({ content: [{ type: 'text', text: 'ok' }] })
      );
    });

    const result = await client.callTool({ name: 'app__web-chat', arguments: {} });
    // The SDK surfaces schema-validation failures as an error result (isError),
    // not a thrown rejection. Either way the required `message` is enforced.
    expect(result.isError).toBe(true);
    expect(JSON.stringify(result.content)).toMatch(/Invalid arguments|Required|message/i);
  });

  it('advertises input (required) plus start-node variables for a workflow tool', async () => {
    const wf = {
      id: 'corpus-analysis-direct',
      nodes: [
        {
          type: 'start',
          config: {
            inputVariables: [
              { name: 'userQuestion', type: 'string', required: true, description: 'The question' },
              { name: 'topicSeeds', type: 'string', required: false }
            ]
          }
        }
      ]
    };

    const { client } = await connect(server => {
      server.registerTool(
        `workflow__${wf.id}`,
        { description: 'wf', ...jsonSchemaToInputSchema(buildWorkflowMcpParams(wf)) },
        async () => ({ content: [{ type: 'text', text: 'ok' }] })
      );
    });

    const { tools } = await client.listTools();
    const tool = tools.find(t => t.name === 'workflow__corpus-analysis-direct');
    expect(Object.keys(tool.inputSchema.properties)).toEqual(
      expect.arrayContaining(['input', 'userQuestion', 'topicSeeds'])
    );
    expect(tool.inputSchema.required).toEqual(expect.arrayContaining(['input', 'userQuestion']));
  });

  it('converts a nested JSON Schema tool (enum + nested object) without losing structure', async () => {
    const parameters = {
      type: 'object',
      properties: {
        question: { type: 'string', description: 'A short question', maxLength: 500 },
        input_type: {
          type: 'string',
          enum: ['text', 'select', 'confirm'],
          description: 'Input type'
        },
        options: {
          type: 'array',
          items: { type: 'object', properties: { value: { type: 'string' } } }
        }
      },
      required: ['question']
    };

    const { client } = await connect(server => {
      server.registerTool(
        'ask_user',
        { description: 'ask', ...jsonSchemaToInputSchema(parameters) },
        async () => ({ content: [{ type: 'text', text: 'ok' }] })
      );
    });

    const { tools } = await client.listTools();
    const tool = tools.find(t => t.name === 'ask_user');
    expect(Object.keys(tool.inputSchema.properties)).toEqual(
      expect.arrayContaining(['question', 'input_type', 'options'])
    );
    expect(tool.inputSchema.properties.input_type.enum).toEqual(['text', 'select', 'confirm']);
    expect(tool.inputSchema.properties.options.type).toBe('array');
    expect(tool.inputSchema.required).toEqual(['question']);
  });

  it('omits inputSchema for a paramless definition (no forced validation)', () => {
    expect(jsonSchemaToInputSchema({ type: 'object', properties: {} })).toEqual({});
    expect(jsonSchemaToInputSchema(null)).toEqual({});
  });

  describe('optional model selection on app tools', () => {
    it('advertises an optional free-form modelId when the app allows model selection', () => {
      const schema = buildAppInputSchema({ id: 'web-chat' });
      expect(schema.properties.modelId).toBeDefined();
      expect(schema.properties.modelId.type).toBe('string');
      expect(schema.properties.modelId.enum).toBeUndefined();
      expect(schema.required).not.toContain('modelId');
    });

    it('advertises modelId as an enum when the app restricts allowedModels', () => {
      const schema = buildAppInputSchema({
        id: 'web-chat',
        allowedModels: ['gpt-4o', 'claude-sonnet-5']
      });
      expect(schema.properties.modelId.enum).toEqual(['gpt-4o', 'claude-sonnet-5']);
    });

    it('omits modelId entirely when the app disallows model selection', () => {
      const schema = buildAppInputSchema({ id: 'web-chat', disallowModelSelection: true });
      expect(schema.properties.modelId).toBeUndefined();
    });

    it('surfaces the modelId enum through the real SDK tools/list', async () => {
      const app = { id: 'web-chat', allowedModels: ['gpt-4o', 'claude-sonnet-5'] };
      const { client } = await connect(server => {
        server.registerTool(
          `app__${app.id}`,
          { description: 'chat', ...jsonSchemaToInputSchema(buildAppInputSchema(app)) },
          async () => ({ content: [{ type: 'text', text: 'ok' }] })
        );
      });
      const { tools } = await client.listTools();
      const tool = tools.find(t => t.name === 'app__web-chat');
      expect(tool.inputSchema.properties.modelId.enum).toEqual(['gpt-4o', 'claude-sonnet-5']);
      expect(tool.inputSchema.required).toEqual(['message']);
    });
  });
});
