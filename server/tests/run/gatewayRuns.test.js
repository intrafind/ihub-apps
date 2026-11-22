// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * The MCP gateway and the A2A endpoint on the run service: nothing of the
 * gateway, the run service, the tool runner or the agent loop is replaced, only
 * the model is scripted (`helpers/appRunEnv.js`).
 *
 * - an app called through `tools/call` or `message/send` runs on the run
 *   service, as the caller, and answers;
 * - nobody can answer there: a call that needs approval is denied, never pending;
 * - a tool the caller may no longer use is refused by the tool runner and
 *   audited (the MCP grant re-check moved there): through `tools/call` of an
 *   integration, and inside an app an A2A task runs;
 * - a caller without resolved permissions, or one who may not open the app, is refused.
 *
 * Run: node --test server/tests/run/gatewayRuns.test.js
 */
import { after, before, beforeEach, describe, it, mock } from 'node:test';
import assert from 'node:assert/strict';
// The environment first: it isolates the contents directory before the server loads.
import { startAppRunEnv, toolRuns, USAGE } from '../helpers/appRunEnv.js';
import { turn } from '../helpers/scriptedModel.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { buildMcpServer } from '../../services/mcp/McpServerService.js';
import { dispatchA2A } from '../../services/mcp/a2aHandler.js';
import { invokeApp } from '../../services/mcp/appInvoker.js';
import { MCP_SCOPES } from '../../services/mcp/scopes.js';
import { toolRunner } from '../../services/run/ToolRunner.js';
import { RUN_REFUSAL_CODES } from '../../services/run/RunService.js';
import { queryAuditLog } from '../../services/AuditLogService.js';
import { APPROVAL_ERROR_CODES } from '../../../shared/toolApproval.js';
import { RUN_LOG_EVENTS } from '../../../shared/runEvents.js';

let env;

before(async () => {
  env = await startAppRunEnv({
    platform: {
      mcpServer: {
        enabled: true,
        expose: { tools: true, apps: true, workflows: false, resources: false }
      }
    }
  });
});

after(async () => {
  await env?.stop();
});

beforeEach(() => env.reset());

const eventsOf = type => env.ledger.filter(event => event.type === type);

/** A signed-in caller of these groups whose token carries these scopes. */
const caller = (groups, scopes) => ({
  ...env.user('u-caller', groups),
  authMode: 'oauth_authorization_code',
  scopes
});

const ALL_SCOPES = [MCP_SCOPES.APPS_INVOKE, MCP_SCOPES.TOOLS_READ, MCP_SCOPES.TOOLS_CALL];

/** Connect an MCP client to the server iHub builds for the caller, run `fn`, close both ends. */
async function withMcpClient(user, fn) {
  const server = await buildMcpServer({ user, platform: env.configCache.getPlatform() });
  const client = new Client({ name: 'test-client', version: '1.0.0' });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  try {
    return await fn(client);
  } finally {
    await Promise.allSettled([client.close(), server.close()]);
  }
}

/** A model turn that disables an installation before it answers. */
const disablingFirst = (instanceId, inner) => (request, ctx) => {
  disable(instanceId);
  return inner.respond(request, ctx);
};

function disable(instanceId) {
  const integrations = env.configCache.getIntegrations();
  mock.method(env.configCache, 'getIntegrations', () => ({
    ...integrations,
    data: {
      ...integrations.data,
      installed: integrations.data.installed.map(instance =>
        instance.id === instanceId ? { ...instance, enabled: false } : instance
      )
    }
  }));
}

async function auditEntries(resource, since) {
  const { entries } = await queryAuditLog({ resource, result: 'failure', limit: 50 });
  return entries.filter(entry => entry.ts >= since);
}

const textOf = result => result.content.find(part => part.type === 'text')?.text;

describe('MCP tools/call of an app', () => {
  it('runs the app on the run service as the caller and returns its answer', async t => {
    env.script(t, [turn.text('Record A-1 is open.', { usage: USAGE })]);
    const result = await withMcpClient(caller(['everything'], ALL_SCOPES), client =>
      client.callTool({ name: 'app__specialist', arguments: { message: 'Look up A-1.' } })
    );
    assert.equal(result.isError, undefined);
    assert.equal(textOf(result), 'Record A-1 is open.');
    const [start] = eventsOf(RUN_LOG_EVENTS.RUN_START);
    assert.equal(start.data.kind, 'subagent');
    assert.equal(start.data.principal.id, 'u-caller');
    assert.equal(start.data.refs.appId, 'specialist');
  });

  it('a tool that needs approval inside the app is denied, never pending', async t => {
    const model = env.script(t, [
      turn.toolCalls([{ name: 'dangerous', args: { key: 'A-1' } }], { usage: USAGE }),
      turn.text('I could not close it.', { usage: USAGE })
    ]);
    const result = await withMcpClient(caller(['everything'], ALL_SCOPES), client =>
      client.callTool({ name: 'app__specialist', arguments: { message: 'Close A-1.' } })
    );
    assert.equal(textOf(result), 'I could not close it.');
    assert.equal(toolRuns.dangerous.length, 0);
    const denied = model.requests[1].body.messages.find(message => message.role === 'tool');
    assert.equal(JSON.parse(denied.content).code, APPROVAL_ERROR_CODES.APPROVAL_REQUIRED_NO_USER);
    assert.equal(eventsOf(RUN_LOG_EVENTS.INTERACTION_RAISED).length, 0);
  });
});

describe('MCP tools/call of an integration', () => {
  it('runs a granted tool through the tool runner, with the call abort signal', async t => {
    env.script(t, []);
    const seen = [];
    const original = toolRunner.runTool;
    toolRunner.runTool = async (toolId, params, options) => {
      seen.push({ toolId, user: params.user?.id, signal: options.signal });
      return { found: params.key };
    };
    t.after(() => {
      toolRunner.runTool = original;
    });
    const result = await withMcpClient(caller(['everything'], ALL_SCOPES), client =>
      client.callTool({ name: 'lookup', arguments: { key: 'A-1' } })
    );
    assert.equal(result.isError, undefined);
    assert.equal(seen.length, 1);
    assert.equal(seen[0].user, 'u-caller');
    // The request's own signal: a client that cancels the call cancels the tool (#3926).
    assert.ok(seen[0].signal instanceof AbortSignal);
  });

  it('a tool whose installation was disabled after the listing is refused and audited', async t => {
    env.script(t, []);
    t.after(() => mock.restoreAll());
    const since = new Date().toISOString();
    const result = await withMcpClient(caller(['everything'], ALL_SCOPES), async client => {
      const { tools } = await client.listTools();
      assert.ok(tools.some(tool => tool.name === 'lookup'));
      disable('lookup');
      return client.callTool({ name: 'lookup', arguments: { key: 'A-1' } });
    });
    assert.equal(result.isError, true);
    assert.equal(textOf(result), 'access_denied: tool not permitted for this caller');
    assert.equal(toolRuns.lookup.length, 0);
    const [entry] = await auditEntries('tool', since);
    assert.deepEqual(
      [entry.resourceId, entry.source, entry.actor.id, entry.details.origin],
      ['lookup', 'mcp', 'u-caller', 'mcp']
    );
  });

  it("a tool the caller's groups do not grant is not listed and cannot be called", async t => {
    env.script(t, []);
    const result = await withMcpClient(caller(['no-secret'], ALL_SCOPES), async client => {
      const { tools } = await client.listTools();
      assert.equal(
        tools.some(tool => tool.name === 'secret'),
        false
      );
      return client.callTool({ name: 'secret', arguments: {} });
    });
    assert.equal(result.isError, true);
    assert.equal(toolRuns.secret.length, 0);
  });
});

describe('A2A message/send to an app skill', () => {
  const send = (user, text) =>
    dispatchA2A(
      {
        jsonrpc: '2.0',
        id: 1,
        method: 'message/send',
        params: {
          message: {
            kind: 'message',
            role: 'user',
            messageId: 'm-1',
            parts: [{ kind: 'text', text }]
          },
          metadata: { skillId: 'app__specialist' }
        }
      },
      { user, platform: env.configCache.getPlatform(), baseUrl: 'https://ihub.example' }
    );

  it('runs the app on the run service; a tool it may no longer use is refused and audited', async t => {
    t.after(() => mock.restoreAll());
    const since = new Date().toISOString();
    env.script(t, [
      disablingFirst(
        'lookup',
        turn.toolCalls([{ name: 'lookup', args: { key: 'A-1' } }], { usage: USAGE })
      ),
      turn.text('The lookup is not available.', { usage: USAGE })
    ]);
    const response = await send(caller(['everything'], [MCP_SCOPES.APPS_INVOKE]), 'Look up A-1.');
    assert.equal(response.result.status.state, 'completed');
    assert.equal(toolRuns.lookup.length, 0);
    const [entry] = await auditEntries('tool', since);
    assert.deepEqual([entry.resourceId, entry.actor.id], ['lookup', 'u-caller']);
    assert.equal(entry.details.origin, 'subagent');
    const [start] = eventsOf(RUN_LOG_EVENTS.RUN_START);
    assert.equal(start.data.principal.id, 'u-caller');
  });

  it('a tool that needs approval is denied, never pending', async t => {
    env.script(t, [
      turn.toolCalls([{ name: 'dangerous', args: { key: 'A-1' } }], { usage: USAGE }),
      turn.text('I could not do that.', { usage: USAGE })
    ]);
    const response = await send(caller(['everything'], [MCP_SCOPES.APPS_INVOKE]), 'Close A-1.');
    assert.equal(response.result.status.state, 'completed');
    assert.equal(toolRuns.dangerous.length, 0);
    assert.equal(eventsOf(RUN_LOG_EVENTS.INTERACTION_RAISED).length, 0);
  });
});

describe('a caller the run service refuses', () => {
  const invoke = user =>
    invokeApp({
      appId: 'specialist',
      messages: [{ role: 'user', content: 'hi' }],
      user,
      origin: 'mcp'
    });

  it('without resolved permissions: refused before anything runs', async t => {
    env.script(t, []);
    await assert.rejects(invoke({ id: 'bare', groups: ['everything'] }), error => {
      assert.equal(error.code, 'PRINCIPAL_UNRESOLVED');
      return true;
    });
    await assert.rejects(invoke(null), { code: 'PRINCIPAL_UNRESOLVED' });
    assert.equal(eventsOf(RUN_LOG_EVENTS.RUN_START).length, 0);
  });

  it('who may not open the app: refused and audited', async t => {
    env.script(t, []);
    const since = new Date().toISOString();
    await assert.rejects(
      invokeApp({
        appId: 'restricted',
        messages: [{ role: 'user', content: 'hi' }],
        user: env.user('u-users', ['users']),
        origin: 'a2a'
      }),
      { code: RUN_REFUSAL_CODES.APP_NOT_PERMITTED }
    );
    const [entry] = await auditEntries('app', since);
    assert.deepEqual([entry.resourceId, entry.source], ['restricted', 'api']);
  });
});
