// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

import { describe, it, expect, beforeAll, afterAll, beforeEach, jest } from '@jest/globals';
import http from 'node:http';
import { randomUUID } from 'node:crypto';

/**
 * A question an MCP server asks mid-call reaches the chat user through iHub's
 * own connection (McpServerConnection over HTTP), on both protocol eras, and
 * the call's timeout stands still while the person answers.
 */

const interactions = {
  raised: [],
  answers: [],
  raise: jest.fn(async params => {
    const interaction = { ...params, status: 'pending', createdAt: new Date().toISOString() };
    interactions.raised.push(interaction);
    return interaction;
  }),
  // The person answers after a while — longer than the call's own timeout —
  // or, with no answer queued, never.
  waitForAnswer: jest.fn(() =>
    interactions.answers.length
      ? new Promise(resolve =>
          setTimeout(
            () => resolve({ status: 'answered', answer: interactions.answers.shift() }),
            600
          )
        )
      : new Promise(() => {})
  ),
  cancel: jest.fn(async () => {})
};
jest.unstable_mockModule('../../services/loop/InteractionService.js', () => ({
  default: interactions
}));

const { McpServer, createMcpHandler, inputRequired, inputResponse } =
  await import('@modelcontextprotocol/server');
const { NodeStreamableHTTPServerTransport, toNodeHandler } =
  await import('@modelcontextprotocol/node');
const z = await import('zod/v4');
const { McpServerConnection } = await import('../../services/mcp/McpServerConnection.js');
const { bindStreamRun, unbindStreamRun, RunStreamEmitter, setEnvelopeDelivery } =
  await import('../../services/loop/RunStream.js');

/** Every server instance built, closed at the end (a question left open keeps a timer). */
const built = [];

/** A server whose tool asks for a project name before it creates the project. */
function buildServer() {
  const server = new McpServer({ name: 'billing', version: '1.0.0' });
  built.push(server);
  server.registerTool(
    'create_project',
    { description: 'Create a paid project', inputSchema: z.object({}) },
    async (_args, ctx) => {
      const answer = inputResponse(ctx.mcpReq.inputResponses, 'name');
      if (answer.kind !== 'elicit') {
        return inputRequired({
          inputRequests: {
            name: inputRequired.elicit({
              message: 'Name the project ($25/month)',
              requestedSchema: {
                type: 'object',
                properties: { name: { type: 'string' } },
                required: ['name']
              }
            })
          }
        });
      }
      return {
        content: [
          {
            type: 'text',
            text:
              answer.action === 'accept'
                ? `created ${answer.content.name}`
                : `not created (${answer.action})`
          }
        ]
      };
    }
  );
  return server;
}

let httpServer;
let baseUrl;
beforeAll(async () => {
  const modern = toNodeHandler(createMcpHandler(buildServer, { legacy: 'reject' }));
  const sessions = new Map();
  httpServer = http.createServer(async (req, res) => {
    let body = '';
    for await (const chunk of req) body += chunk;
    const parsed = body ? JSON.parse(body) : undefined;
    if (req.url === '/modern') return modern(req, res, parsed);
    // A 2025-era server with sessions (it answers the 2026 probe with an error).
    const sessionId = req.headers['mcp-session-id'];
    let transport = sessionId && sessions.get(sessionId);
    if (!transport) {
      transport = new NodeStreamableHTTPServerTransport({
        sessionIdGenerator: () => randomUUID(),
        onsessioninitialized: id => sessions.set(id, transport)
      });
      await buildServer().connect(transport);
    }
    await transport.handleRequest(req, res, parsed);
  });
  await new Promise(resolve => httpServer.listen(0, '127.0.0.1', resolve));
  baseUrl = `http://127.0.0.1:${httpServer.address().port}`;
});
afterAll(
  () =>
    new Promise(resolve => {
      // A server request still waiting on an answer must not hold the close.
      Promise.allSettled(built.map(server => server.close())).then(() => {
        httpServer.closeAllConnections();
        httpServer.close(resolve);
      });
    })
);

const user = { id: 'alice', groups: ['users'] };

function connection(path) {
  return new McpServerConnection(
    {
      id: 'billing',
      name: 'Billing',
      transport: { type: 'streamableHttp', url: `${baseUrl}${path}` },
      timeoutMs: 250
    },
    { blockPrivateIps: false, allowedHosts: [] }
  );
}

describe.each([
  ['2026-07-28', '/modern'],
  ['2025-era session', '/legacy']
])('a server question mid-call (%s)', (_label, path) => {
  let frames;
  beforeEach(() => {
    interactions.raised.length = 0;
    frames = [];
    setEnvelopeDelivery((streamId, envelope) => frames.push(envelope));
    bindStreamRun('chat-1', 'chat-parent', new RunStreamEmitter({ streamId: 'chat-1' }));
  });

  it('goes to the chat, and the call waits for the answer past its own timeout', async () => {
    interactions.answers.push({ value: 'accept', data: { name: 'Billing' } });
    const conn = connection(path);
    try {
      const result = await conn.callTool(
        'create_project',
        {},
        { context: { chatId: 'chat-1', user, toolId: 'billing__create_project' } }
      );
      expect(result).toBe('created Billing');
      expect(interactions.raised).toHaveLength(1);
      expect(interactions.raised[0].prompt.message).toBe('Name the project ($25/month)');
      expect(interactions.raised[0].source.mcpElicitation).toMatchObject({ serverId: 'billing' });
      expect(frames.some(f => f.type === 'interaction/raised')).toBe(true);
    } finally {
      await conn.disconnect();
      unbindStreamRun('chat-1', 'chat-parent');
    }
  });

  it('cancels the question and ends the call when the turn is stopped', async () => {
    interactions.cancel.mockClear();
    const turn = new AbortController();
    const conn = connection(path);
    try {
      const call = conn.callTool(
        'create_project',
        {},
        { context: { chatId: 'chat-1', user, signal: turn.signal } }
      );
      setTimeout(() => turn.abort(), 400);
      await expect(call).rejects.toThrow(/abort/i);
      expect(interactions.cancel).toHaveBeenCalledWith(interactions.raised[0].id, 'aborted');
    } finally {
      await conn.disconnect();
      unbindStreamRun('chat-1', 'chat-parent');
    }
  });

  it('tells the server "cancel" when no chat turn can show the question', async () => {
    unbindStreamRun('chat-1', 'chat-parent');
    const conn = connection(path);
    try {
      const result = await conn.callTool('create_project', {}, { context: { user } });
      expect(result).toBe('not created (cancel)');
      expect(interactions.raised).toHaveLength(0);
    } finally {
      await conn.disconnect();
    }
  });
});
