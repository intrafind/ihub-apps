// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * The two surfaces of the gateway for other agents:
 *
 * - `mcp`: `tools/call` of an app tool on the MCP server iHub builds for a
 *   caller (`buildMcpServer`). An MCP client of the SDK talks to it over the
 *   SDK's in-memory transport, so the request goes through the SDK's own
 *   dispatch and schema validation.
 * - `a2a`: `message/send` and `message/stream` through `dispatchA2A`, the
 *   function behind `POST /a2a`.
 *
 * Both run the app on the real loop. The tests of these surfaces
 * (`mcpServerService.test.js`, `a2aHandler.test.js`) replace
 * `ChatService.invokeAppInternal`; here it is the product's.
 *
 * Not recorded: the bearer token check in front of both (`middleware/mcpAuth.js`).
 * The principal is built as that middleware builds it for a signed-in user,
 * with the scopes of the token.
 *
 * @module tests/golden/surfaces/gateway
 */
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { defineCase } from '../harness.js';
import { turn } from '../../helpers/scriptedModel.js';
import { buildMcpServer } from '../../../services/mcp/McpServerService.js';
import { dispatchA2A } from '../../../services/mcp/a2aHandler.js';
import { MCP_SCOPES } from '../../../services/mcp/scopes.js';
import { app, goldenUser, surfaceConfig, usage, usersGroup } from './fixtures.js';

const APPS = [app('desk', { integrations: { lookup: {}, dangerous: {} } })];

const gatewayConfig = () =>
  surfaceConfig({
    apps: APPS,
    platform: {
      mcpServer: {
        enabled: true,
        expose: { tools: false, apps: true, workflows: false, resources: false }
      }
    },
    groups: { users: usersGroup(['desk']) },
    extra: {
      idPatterns: [
        // A call through the gateway has no run of the caller: `mcp-<epoch ms>`.
        /\bmcp-(\d{10,})\b/g,
        // The chat a call's files are stored under: that id and a random suffix.
        /\bmcp-<id:\d+>-([a-z0-9]{6})\b/g,
        // A stored file.
        /\bfile_([0-9a-f]{24})\b/g
      ],
      // The chat id of a call is minted for the call; the options of its model call hold it.
      volatileKeys: ['configHash']
    }
  });

/** The caller: a signed-in user whose token carries the scope for apps. */
const gatewayUser = env =>
  goldenUser(env, { authMode: 'oauth_authorization_code', scopes: [MCP_SCOPES.APPS_INVOKE] });

/** Connect an MCP client to the server iHub builds for the caller, and call one tool. */
async function mcpToolsCall(env, { name, args }) {
  const platform = env.configCache.getPlatform();
  const server = await buildMcpServer({ user: gatewayUser(env), platform });
  const client = new Client({ name: 'golden-client', version: '1.0.0' });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  /** One call through the pair; the two ends are closed after it, however it went. */
  const exchange = async () => {
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
    const listed = await client.listTools();
    const request = { name, arguments: args };
    const response = await client.callTool(request);
    return {
      result: {
        tools: listed.tools.map(tool => ({ name: tool.name, inputSchema: tool.inputSchema })),
        request: { method: 'tools/call', params: request },
        response
      }
    };
  };
  const [called] = await Promise.allSettled([exchange()]);
  // Both ends are closed, whatever the first close does.
  const closed = await Promise.allSettled([client.close(), server.close()]);
  // A call that failed is the failure to report, not what closing did after it.
  if (called.status === 'rejected') throw called.reason;
  const notClosed = closed.find(outcome => outcome.status === 'rejected');
  if (notClosed) {
    throw new Error('a transport of the MCP exchange did not close', { cause: notClosed.reason });
  }
  return called.value;
}

const base64 = text => Buffer.from(text, 'utf8').toString('base64');

export const mcpCases = [
  defineCase({
    surface: 'mcp',
    name: 'ok',
    title: 'tools/call of an app: the app runs its tool and the answer is the text of the result.',
    config: gatewayConfig,
    script: () => [
      turn.toolCalls([{ name: 'lookup', args: { key: 'A-1' } }], { usage: usage(40, 8) }),
      turn.text('Record A-1 is open.', { usage: usage(62, 6) })
    ],
    run: env => mcpToolsCall(env, { name: 'app__desk', args: { message: 'Look up record A-1.' } })
  }),
  defineCase({
    surface: 'mcp',
    name: 'file-lift',
    title: 'tools/call with a file: the file becomes an upload of the call and reaches the model.',
    config: gatewayConfig,
    script: () => [turn.text('The note says A-1 is open.', { usage: usage(80, 8) })],
    run: env =>
      mcpToolsCall(env, {
        name: 'app__desk',
        args: {
          message: 'What does the note say?',
          files: [
            { name: 'note.txt', mimeType: 'text/plain', data: base64('Record A-1 is open.\n') }
          ]
        }
      })
  }),
  defineCase({
    surface: 'mcp',
    name: 'error-mapping',
    title: 'The provider fails: tools/call answers with isError and the message of the failure.',
    config: gatewayConfig,
    script: () => [
      turn.error(400, { error: { message: 'The request was refused', code: 'bad_request' } })
    ],
    run: env => mcpToolsCall(env, { name: 'app__desk', args: { message: 'Look up record A-1.' } })
  }),
  defineCase({
    surface: 'mcp',
    name: 'approval-refused',
    title: 'A tool that needs approval is refused inside a gateway call: nobody can approve it.',
    config: gatewayConfig,
    script: () => [
      turn.toolCalls([{ name: 'dangerous', args: { key: 'A-1' } }], { usage: usage(40, 8) }),
      turn.text('I could not close record A-1.', { usage: usage(90, 8) })
    ],
    run: env => mcpToolsCall(env, { name: 'app__desk', args: { message: 'Close record A-1.' } })
  })
];

const a2aMessage = text => ({
  kind: 'message',
  role: 'user',
  messageId: 'a2a-msg-1',
  parts: [{ kind: 'text', text }]
});

/** One JSON-RPC request through the dispatcher behind `POST /a2a`. */
async function a2aCall(env, request, { streamed = false } = {}) {
  const platform = env.configCache.getPlatform();
  const events = [];
  const response = await dispatchA2A(request, {
    user: gatewayUser(env),
    platform,
    baseUrl: 'https://ihub.example',
    ...(streamed ? { stream: event => events.push(event) } : {})
  });
  return { result: { request, response, ...(streamed ? { events } : {}) } };
}

export const a2aCases = [
  defineCase({
    surface: 'a2a',
    name: 'message-send',
    title:
      'message/send to an app skill: the task runs the app and ends completed with the answer.',
    config: gatewayConfig,
    script: () => [
      turn.toolCalls([{ name: 'lookup', args: { key: 'A-1' } }], { usage: usage(40, 8) }),
      turn.text('Record A-1 is open.', { usage: usage(62, 6) })
    ],
    run: env =>
      a2aCall(env, {
        jsonrpc: '2.0',
        id: 1,
        method: 'message/send',
        params: { message: a2aMessage('Look up record A-1.'), metadata: { skillId: 'app__desk' } }
      })
  }),
  defineCase({
    surface: 'a2a',
    name: 'message-stream',
    title: 'message/stream to an app skill: the task, its status updates and the answer as events.',
    config: gatewayConfig,
    script: () => [turn.text(['Record A-1 ', 'is open.'], { usage: usage(40, 6) })],
    run: env =>
      a2aCall(
        env,
        {
          jsonrpc: '2.0',
          id: 2,
          method: 'message/stream',
          params: {
            message: a2aMessage('What about record A-1?'),
            metadata: { skillId: 'app__desk' }
          }
        },
        { streamed: true }
      )
  }),
  defineCase({
    surface: 'a2a',
    name: 'error-mapping',
    title: 'The provider fails: the task ends failed and says why.',
    config: gatewayConfig,
    script: () => [
      turn.error(400, { error: { message: 'The request was refused', code: 'bad_request' } })
    ],
    run: env =>
      a2aCall(env, {
        jsonrpc: '2.0',
        id: 3,
        method: 'message/send',
        params: { message: a2aMessage('Look up record A-1.'), metadata: { skillId: 'app__desk' } }
      })
  })
];
