// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * MCP server (`/api/mcp`): `app__<id>` and `workflow__<id>` tools take an
 * optional `files` input, ingested into the invocation's chat, and an app's
 * generated files and pictures come back as standard MCP content blocks
 * (embedded `resource` with a base64 `blob`, `image`) next to the text block.
 *
 * Driven through the real gateway over an in-memory transport; the app runs on
 * the real run service, only the model is scripted (`helpers/appRunEnv.js`).
 * A workflow's start is the one thing replaced: the runner's `runTool`, so the
 * test sees what the workflow would get without running one.
 *
 * Run: node --test server/tests/mcp/mcpServerFiles.test.js
 */
import { after, before, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
// The environment first: it isolates the contents directory before the server loads.
import { startAppRunEnv, USAGE } from '../helpers/appRunEnv.js';
import { turn } from '../helpers/scriptedModel.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import {
  appToolResult,
  buildAppInputSchema,
  buildMcpServer,
  buildWorkflowMcpParams
} from '../../services/mcp/McpServerService.js';
import { MCP_SCOPES } from '../../services/mcp/scopes.js';
import { toolRunner } from '../../services/run/ToolRunner.js';
import { getChatFileRepository } from '../../services/chatFiles/ChatFileRepository.js';
import { RUN_LOG_EVENTS } from '../../../shared/runEvents.js';

let env;
let user;

before(async () => {
  env = await startAppRunEnv({
    platform: {
      defaultLanguage: 'en',
      mcpServer: { expose: { tools: false, apps: true, workflows: true, resources: false } }
    },
    workflows: [
      {
        id: 'review',
        name: { en: 'Review' },
        enabled: true,
        chatIntegration: { enabled: true },
        nodes: [{ id: 'start', type: 'start', config: { inputVariables: [] } }],
        edges: []
      }
    ]
  });
  user = {
    ...env.user('alice', ['everything']),
    scopes: [MCP_SCOPES.APPS_INVOKE, MCP_SCOPES.WORKFLOWS_RUN]
  };
});

after(async () => {
  await env?.stop();
});

beforeEach(() => env.reset());

async function withClient(fn) {
  const server = await buildMcpServer({ user, platform: env.configCache.getPlatform() });
  const client = new Client({ name: 'test-client', version: '0.0.0' }, { capabilities: {} });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  try {
    return await fn(client);
  } finally {
    await Promise.allSettled([client.close(), server.close()]);
  }
}

const PNG_B64 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==';

/** The chat the app's run belonged to, from its ledger start. */
const runChatId = () =>
  env.ledger.find(event => event.type === RUN_LOG_EVENTS.RUN_START)?.data.refs.chatId;

describe('the files input of app and workflow tools', () => {
  it('is advertised on both tools and stays optional', async t => {
    env.script(t, []);
    const { tools } = await withClient(client => client.listTools());
    for (const name of ['app__specialist', 'workflow__review']) {
      const tool = tools.find(entry => entry.name === name);
      assert.equal(tool.inputSchema.properties.files.type, 'array');
      for (const key of ['name', 'mimeType', 'data', 'text']) {
        assert.ok(key in tool.inputSchema.properties.files.items.properties, key);
      }
      assert.equal((tool.inputSchema.required || []).includes('files'), false);
    }
    assert.ok(buildAppInputSchema({ id: 'x' }).properties.files);
    assert.ok(buildWorkflowMcpParams({ id: 'w' }).properties.files);
  });

  it('is ingested into the invocation chat and reaches the app as an upload', async t => {
    const model = env.script(t, [turn.text('done', { usage: USAGE })]);
    const text = 'Quarterly numbers\nrevenue,42\n';
    const result = await withClient(client =>
      client.callTool({
        name: 'app__specialist',
        arguments: {
          message: 'Summarize the file',
          files: [
            { name: 'q3.csv', mimeType: 'text/csv', data: Buffer.from(text).toString('base64') }
          ]
        }
      })
    );
    assert.equal(result.isError, undefined);
    // What the app's model reads: the message and the file's text.
    const sent = JSON.stringify(model.requests[0].body.messages);
    assert.match(sent, /Summarize the file/);
    assert.match(sent, /revenue,42/);
    // `files` is not a prompt variable: its base64 never reaches the model.
    assert.doesNotMatch(sent, new RegExp(Buffer.from(text).toString('base64')));
    const chatId = runChatId();
    assert.equal(typeof chatId, 'string');
    const stored = await getChatFileRepository().list({ type: 'chat', id: chatId });
    assert.equal(stored.length, 1);
    assert.deepEqual([stored[0].name, stored[0].origin], ['q3.csv', 'mcp']);
  });

  it('accepts a text file as well as base64', async t => {
    const model = env.script(t, [turn.text('done', { usage: USAGE })]);
    await withClient(client =>
      client.callTool({
        name: 'app__specialist',
        arguments: { message: 'Read it', files: [{ name: 'note.md', text: '# Note\nhello' }] }
      })
    );
    assert.match(JSON.stringify(model.requests[0].body.messages), /hello/);
  });

  it('without files nothing changes: a chat of the call, no file data', async t => {
    env.script(t, [turn.text('done', { usage: USAGE })]);
    const result = await withClient(client =>
      client.callTool({ name: 'app__specialist', arguments: { message: 'hi' } })
    );
    assert.deepEqual(result.content, [{ type: 'text', text: 'done' }]);
    // The run service mints the chat of a call that brought none.
    assert.match(runChatId(), /^agent:mcp-\d+:/);
  });

  it('fails soft on invalid, oversized and unsupported files: an error result, no app run', async t => {
    env.script(t, []);
    const cases = [
      [{ name: 'a.csv', data: 'not base64 !!' }, /not valid base64/],
      [{ name: 'a.csv', data: 'A'.repeat(36 * 1024 * 1024) }, /larger than 25 MB/],
      [{ name: 'a.csv' }, /needs "data"/],
      [{ data: 'aGk=' }, /files\[0\]\.name/],
      [{ name: 'pic.png', mimeType: 'image/png', data: PNG_B64 }, /unsupported type/]
    ];
    await withClient(async client => {
      for (const [file, pattern] of cases) {
        const result = await client.callTool({
          name: 'app__specialist',
          arguments: { message: 'x', files: [file] }
        });
        assert.equal(result.isError, true);
        assert.match(result.content[0].text, pattern);
      }
    });
    assert.equal(runChatId(), undefined, 'no app run');
  });

  it('is handed to a workflow as its uploaded files', async t => {
    env.script(t, []);
    const calls = [];
    const original = toolRunner.runTool;
    toolRunner.runTool = async (toolId, params) => {
      calls.push({ toolId, params });
      return { status: 'completed', executionId: 'e1', output: { output: 'ok' }, outputText: 'ok' };
    };
    t.after(() => {
      toolRunner.runTool = original;
    });
    const result = await withClient(client =>
      client.callTool({
        name: 'workflow__review',
        arguments: {
          input: 'check it',
          files: [{ name: 'draft.md', text: 'The draft says hello' }]
        }
      })
    );
    assert.equal(result.isError, undefined);
    const [{ toolId, params }] = calls;
    assert.equal(toolId, 'workflow_review');
    assert.equal(params.files, undefined);
    assert.equal(params.user.id, 'alice');
    assert.equal(params._fileData.length, 1);
    assert.match(params._fileData[0].content, /hello/);
    assert.equal(typeof params.chatId, 'string');
  });
});

describe('what an app returns over MCP', () => {
  it('is its text, then every generated file as an embedded resource and every picture as an image', () => {
    const pdf = Buffer.from('%PDF-1.4 fake');
    const result = appToolResult('done', {
      generatedFiles: [
        {
          id: 'a'.repeat(32),
          name: 'Report.pdf',
          mimeType: 'application/pdf',
          bytes: pdf.length,
          data: pdf.toString('base64')
        }
      ],
      images: [{ mimeType: 'image/png', data: PNG_B64 }]
    });
    assert.equal(result.content.length, 3);
    assert.deepEqual(result.content[0], { type: 'text', text: 'done' });
    assert.equal(result.content[1].type, 'resource');
    assert.equal(result.content[1].resource.mimeType, 'application/pdf');
    assert.equal(result.content[1].resource.blob, pdf.toString('base64'));
    assert.match(result.content[1].resource.uri, /^ihub:\/\/generated\/.+\/Report\.pdf$/);
    assert.deepEqual(result.content[2], { type: 'image', data: PNG_B64, mimeType: 'image/png' });
    // nothing is serialized into the text block
    assert.doesNotMatch(result.content[0].text, new RegExp(PNG_B64.slice(0, 20)));
  });

  it('an app run hands what it produced to the result: nothing, for an answer without files', async t => {
    env.script(t, [turn.text('done', { usage: USAGE })]);
    const result = await withClient(client =>
      client.callTool({ name: 'app__specialist', arguments: { message: 'make it' } })
    );
    assert.deepEqual(result.content, [{ type: 'text', text: 'done' }]);
  });

  it('appToolResult skips entries without bytes', () => {
    assert.deepEqual(
      appToolResult('t', { generatedFiles: [{ name: 'x', mimeType: 'text/plain' }], images: [{}] }),
      { content: [{ type: 'text', text: 't' }] }
    );
  });
});
