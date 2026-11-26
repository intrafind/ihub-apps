// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

import { describe, it, expect } from '@jest/globals';
import {
  McpServer,
  InMemoryTransport,
  createMcpHandler,
  CLIENT_CAPABILITIES_META_KEY
} from '@modelcontextprotocol/server';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import * as z from 'zod/v4';
import { gatewayApproval } from '../../services/mcp/McpServerService.js';
import {
  argumentsDigest,
  gatewayRequestStateCodec
} from '../../services/mcp/gatewayRequestState.js';

/**
 * Approval of a gated gateway tool through the MCP client (elicitation, #2945).
 *
 * The person is asked through the client; only an answer to a question the
 * gateway itself asked (a signed `requestState` for this caller, tool and
 * arguments) approves the call. A client that cannot ask gets the old refusal.
 */

const tool = { id: 'jira_createIssue', _integration: { name: 'Jira', instanceId: 'jira' } };
const user = { id: 'alice' };

/** A server with one gated tool, as `buildMcpServer` registers it. */
function buildServer(runs) {
  const server = new McpServer(
    { name: 'test', version: '0.0.0' },
    {
      capabilities: { tools: { listChanged: false } },
      requestState: { verify: gatewayRequestStateCodec().verify }
    }
  );
  server.registerTool(
    tool.id,
    { description: 'gated', inputSchema: z.object({ summary: z.string() }) },
    async (args, ctx) => {
      const approval = await gatewayApproval({ server, ctx, tool, args, user });
      if (!approval.approved) return approval.result;
      runs.push(args);
      return { content: [{ type: 'text', text: 'created' }] };
    }
  );
  return server;
}

function clientAnswering(answer, { elicitation = true, versionNegotiation } = {}) {
  const asked = [];
  const client = new Client(
    { name: 'test-client', version: '0.0.0' },
    {
      capabilities: elicitation ? { elicitation: { form: {} } } : {},
      ...(versionNegotiation ? { versionNegotiation } : {})
    }
  );
  if (elicitation) {
    client.setRequestHandler('elicitation/create', async request => {
      asked.push(request.params);
      return answer;
    });
  }
  return { client, asked };
}

async function connectLegacy(runs, options) {
  const server = buildServer(runs);
  const { client, asked } = clientAnswering(options.answer, options);
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  return { client, asked };
}

async function connectModern(runs, options) {
  const handler = createMcpHandler(() => buildServer(runs), { legacy: 'reject' });
  const { client, asked } = clientAnswering(options.answer, {
    ...options,
    versionNegotiation: { mode: 'auto' }
  });
  await client.connect(
    new StreamableHTTPClientTransport(new URL('http://gateway.test/mcp'), {
      fetch: (url, init) => handler.fetch(new Request(url, init))
    })
  );
  return { client, asked };
}

const call = client =>
  client.callTool({ name: tool.id, arguments: { summary: 'Printer on fire' } });

describe.each([
  ['2025-era session', connectLegacy],
  ['2026-07-28', connectModern]
])('approval through elicitation (%s)', (_label, connect) => {
  it('asks the person and runs the call once they approve', async () => {
    const runs = [];
    const { client, asked } = await connect(runs, {
      answer: { action: 'accept', content: { approve: true } }
    });
    const result = await call(client);
    expect(result.isError).toBeFalsy();
    expect(result.content[0].text).toBe('created');
    expect(asked).toHaveLength(1);
    expect(asked[0].message).toContain('jira_createIssue');
    expect(asked[0].message).toContain('Printer on fire');
    expect(runs).toEqual([{ summary: 'Printer on fire' }]);
  });

  it('does not run the call when the person declines or leaves it unchecked', async () => {
    for (const answer of [
      { action: 'decline' },
      { action: 'cancel' },
      { action: 'accept', content: { approve: false } }
    ]) {
      const runs = [];
      const { client } = await connect(runs, { answer });
      const result = await call(client);
      expect(result.isError).toBe(true);
      expect(result.content[0].text).toMatch(/^USER_REJECTED/);
      expect(runs).toEqual([]);
    }
  });

  it('refuses the call as before when the client cannot ask anyone', async () => {
    const runs = [];
    const { client } = await connect(runs, { elicitation: false });
    const result = await call(client);
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toMatch(/^APPROVAL_REQUIRED_NO_USER/);
    expect(runs).toEqual([]);
  });
});

describe('an approval the gateway did not ask for', () => {
  const server = { server: { getClientCapabilities: () => undefined } };
  const envelope = { [CLIENT_CAPABILITIES_META_KEY]: { elicitation: {} } };
  const accepted = { approval: { action: 'accept', content: { approve: true } } };
  const args = { summary: 'Printer on fire' };

  const ctxWith = (state, responses = accepted) => ({
    mcpReq: { envelope, inputResponses: responses, requestState: () => state }
  });

  it('is not taken: an answer without the signed state is asked again', async () => {
    const outcome = await gatewayApproval({ server, ctx: ctxWith(undefined), tool, args, user });
    expect(outcome.approved).toBeUndefined();
    expect(outcome.result.resultType).toBe('input_required');
    expect(Object.keys(outcome.result.inputRequests)).toEqual(['approval']);
    expect(typeof outcome.result.requestState).toBe('string');
  });

  it('is not taken for other arguments, another tool or another caller', async () => {
    const binding = { kind: 'approval', tool: tool.id, user: user.id, args: argumentsDigest(args) };
    for (const state of [
      { ...binding, args: argumentsDigest({ summary: 'something else' }) },
      { ...binding, tool: 'jira_deleteIssue' },
      { ...binding, user: 'mallory' }
    ]) {
      const outcome = await gatewayApproval({ server, ctx: ctxWith(state), tool, args, user });
      expect(outcome.approved).toBeUndefined();
      expect(outcome.result.resultType).toBe('input_required');
    }
  });

  it('is taken when it answers the state minted for exactly this call', async () => {
    const state = { kind: 'approval', tool: tool.id, user: user.id, args: argumentsDigest(args) };
    // Key order of the arguments does not matter.
    const outcome = await gatewayApproval({
      server,
      ctx: ctxWith(state),
      tool,
      args: { ...args },
      user
    });
    expect(outcome).toEqual({ approved: true });
  });

  it('signs the state: a tampered one does not verify', async () => {
    const codec = gatewayRequestStateCodec();
    const minted = await codec.mint({ kind: 'approval', tool: tool.id, user: user.id, args: 'x' });
    const [payload, signature] = minted.split('.');
    const forged = `${Buffer.from(
      JSON.stringify({ kind: 'approval', tool: tool.id, user: 'mallory', args: 'x' })
    ).toString('base64url')}.${signature}`;
    await expect(codec.verify(minted)).resolves.toBeDefined();
    await expect(codec.verify(forged)).rejects.toThrow();
    expect(payload).not.toBe(forged.split('.')[0]);
  });
});
