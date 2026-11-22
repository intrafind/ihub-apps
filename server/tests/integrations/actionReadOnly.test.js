// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * Which actions of an integration may run side by side with other calls
 * (#2485): only an action that is a read by declaration.
 *
 * - declared `sideEffect: 'read'` in the definition: yes;
 * - no declaration (`unknown`, what a custom integration made from an old tool
 *   file has until an admin says more): never;
 * - a tool of an MCP server that calls itself read-only (`readOnlyHint`): never;
 * - the same action or tool once an admin set `sideEffect: read` on it
 *   (Admin → Integrations → the action): yes. A `write` set by an admin takes
 *   a declared read out again.
 *
 * The tools are built the way the tool list builds them: the HTTP adapter's
 * `discoverActions`, `toolFromAction`, the approval stamp, then the planner in
 * the mode a chat turn uses.
 *
 * Nothing is written: no migration belongs to this, and no file under
 * `contents/` changes.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { toolFromAction } from '../../services/integrations/integrationTools.js';
import { discoverActions } from '../../services/integrations/protocols/http/HttpAdapter.js';
import { validateIntegrationDefinition } from '../../validators/integrationDefinitionSchema.js';
import { planToolBatches } from '../../services/loop/segmentPlanner.js';
import { isTrustedReadOnly, stampToolApproval } from '../../utils/toolApproval.js';
import { needsApproval } from '../../../shared/toolApproval.js';

const READ_ONLY = { parallel: true, parallelMode: 'readOnly' };

function definition() {
  const action = (name, extra = {}) => ({
    name,
    parameters: { type: 'object', properties: { id: { type: 'string' } } },
    request: { method: 'GET', url: `/${name}/{id}` },
    ...extra
  });
  const result = validateIntegrationDefinition({
    id: 'custom/orders',
    version: '1.0.0',
    name: { en: 'Orders' },
    protocol: { type: 'http', baseUrl: 'https://orders.example.invalid' },
    auth: { modes: ['none'] },
    actions: [
      action('list_orders', { sideEffect: 'read' }),
      // What V211 made of an admin's tool file: an action that declares nothing.
      action('lookup'),
      action('cancel_order', { sideEffect: 'destructive' })
    ]
  });
  assert.equal(result.success, true, JSON.stringify(result.errors));
  return result.data;
}

function installation(overrides = {}) {
  return {
    id: 'orders',
    definition: 'custom/orders',
    enabled: true,
    values: {},
    actions: { enabled: ['*'], disabled: [], overrides }
  };
}

/** The installation's tools as an app's tool list holds them, by action name. */
async function toolsOf(instance, { app = null, platform = null } = {}) {
  const def = definition();
  const actions = await discoverActions({ definition: def, instance, language: 'en' });
  const built = actions.map(action =>
    toolFromAction({ instance, definition: def, label: 'Orders' }, action, 'en')
  );
  const stamped = stampToolApproval(built, app, platform, { getInstallation: () => instance });
  return Object.fromEntries(stamped.map(tool => [tool._integration.action, tool]));
}

/** A tool of a remote MCP server as `McpAdapter.discoverTools` hands it over. */
function mcpTool(annotations) {
  return {
    id: 'remote__list_issues',
    name: 'remote__list_issues',
    description: 'List issues',
    parameters: { type: 'object', properties: {} },
    type: 'integration',
    _mcp: { serverId: 'remote', originalName: 'list_issues', annotations },
    _integration: {
      instanceId: 'remote',
      instanceLabel: 'Remote',
      action: 'list_issues',
      definition: 'com.intrafind/mcp-server'
    }
  };
}

/** Whether two calls of the tool share a batch in a chat turn. */
function batched(tool) {
  const calls = ['a', 'b'].map(id => ({
    call: { id, function: { name: tool.id } },
    toolDef: tool,
    args: { id }
  }));
  return planToolBatches(calls, READ_ONLY).length === 1;
}

describe('an action of a custom integration', () => {
  it('declared read: marked read-only and batched', async () => {
    const tools = await toolsOf(installation());
    assert.equal(tools.list_orders.sideEffect, 'read');
    assert.equal(tools.list_orders.sideEffectSource, 'definition');
    assert.equal(tools.list_orders.readOnly, true);
    assert.equal(batched(tools.list_orders), true);
  });

  it('no declaration: unknown, not read-only, never batched', async () => {
    const tools = await toolsOf(installation());
    assert.equal(tools.lookup.sideEffect, 'unknown');
    assert.equal(tools.lookup.sideEffectSource, 'default');
    assert.equal(tools.lookup.readOnly, false);
    assert.equal(isTrustedReadOnly(tools.lookup), false);
    assert.equal(batched(tools.lookup), false);
  });

  it('a write is never batched', async () => {
    const tools = await toolsOf(installation());
    assert.equal(tools.cancel_order.readOnly, false);
    assert.equal(batched(tools.cancel_order), false);
  });

  it('the undeclared action is batched once an admin set it to read', async () => {
    const tools = await toolsOf(installation({ lookup: { sideEffect: 'read' } }));
    assert.equal(tools.lookup.sideEffect, 'read');
    assert.equal(tools.lookup.sideEffectSource, 'admin');
    assert.equal(tools.lookup.readOnly, true);
    assert.equal(batched(tools.lookup), true);
    // The other actions are untouched by that override.
    assert.equal(batched(tools.cancel_order), false);
  });

  it('a declared read an admin set to write is not batched any more', async () => {
    const tools = await toolsOf(installation({ list_orders: { sideEffect: 'write' } }));
    assert.equal(tools.list_orders.sideEffectSource, 'admin');
    assert.equal(tools.list_orders.readOnly, false);
    assert.equal(batched(tools.list_orders), false);
  });

  it('the tool carries the trusted value before it is stamped, too', async () => {
    const def = definition();
    const instance = installation({ lookup: { sideEffect: 'read' } });
    const actions = await discoverActions({ definition: def, instance, language: 'en' });
    const byName = Object.fromEntries(
      actions.map(action => [
        action.name,
        toolFromAction({ instance, definition: def, label: 'Orders' }, action, 'en')
      ])
    );
    assert.equal(byName.list_orders.readOnly, true);
    assert.equal(byName.lookup.readOnly, true);
    assert.equal(byName.cancel_order.readOnly, false);
  });

  it('what a connector adds to a tool cannot make it read-only', () => {
    const def = definition();
    const instance = installation();
    const tool = toolFromAction(
      { instance, definition: def, label: 'Orders' },
      {
        name: 'cancel_order',
        toolId: 'orders__cancel_order',
        parameters: { type: 'object', properties: {} },
        sideEffect: 'destructive',
        dataFlow: 'external',
        extras: { readOnly: true }
      },
      'en'
    );
    assert.equal(tool.readOnly, false);
  });
});

describe('a tool of a remote MCP server', () => {
  const stamp = (tool, instance = null, platform = null) =>
    stampToolApproval([tool], null, platform, { getInstallation: () => instance })[0];

  it('read-only by its own annotation only: never batched, and still asked for under writes', () => {
    const tool = stamp(mcpTool({ readOnlyHint: true }), null, {
      toolApproval: { defaults: { external: 'writes' } }
    });
    assert.equal(tool.sideEffect, 'read');
    assert.equal(tool.sideEffectSource, 'annotation');
    assert.equal(tool.readOnly, undefined);
    assert.equal(needsApproval(tool), true);
    assert.equal(batched(stamp(mcpTool({ readOnlyHint: true }))), false);
  });

  it('without annotations: unknown, never batched', () => {
    const tool = stamp(mcpTool(undefined));
    assert.equal(tool.sideEffect, 'unknown');
    assert.equal(batched(tool), false);
  });

  it('batched once an admin set the tool to read', () => {
    const instance = {
      id: 'remote',
      actions: { overrides: { list_issues: { sideEffect: 'read' } } }
    };
    const tool = stamp(mcpTool({ readOnlyHint: true }), instance);
    assert.equal(tool.sideEffectSource, 'admin');
    assert.equal(tool.readOnly, true);
    assert.equal(batched(tool), true);
  });

  it('an override for another tool of the server changes nothing', () => {
    const instance = { id: 'remote', actions: { overrides: { other: { sideEffect: 'read' } } } };
    assert.equal(batched(stamp(mcpTool({ readOnlyHint: true }), instance)), false);
  });
});

describe('a skill of a remote A2A agent', () => {
  const stamp = (tool, instance = null, platform = null) =>
    stampToolApproval([tool], null, platform, { getInstallation: () => instance })[0];
  /**
   * A skill as `A2aAdapter.discoverTools` hands it over. `claims` is what the
   * remote side would say about its own skill; no agent card field feeds it
   * today, and nothing it says may count.
   */
  const a2aTool = (claims = {}) => ({
    id: 'a2a__desk__summarise',
    name: 'a2a__desk__summarise',
    description: 'Summarise a text',
    parameters: { type: 'object', properties: { message: { type: 'string' } } },
    type: 'integration',
    _a2a: { agentId: 'desk', agentName: 'Desk', skillId: 'summarise', skillName: 'Summarise' },
    _integration: {
      instanceId: 'desk',
      instanceLabel: 'Desk',
      action: 'summarise',
      definition: 'com.intrafind/a2a-agent'
    },
    ...claims
  });
  const WRITES = { toolApproval: { defaults: { external: 'writes' } } };

  it('as built today: unknown, never batched, asked for under writes', () => {
    const tool = stamp(a2aTool(), null, WRITES);
    assert.equal(tool.sideEffect, 'unknown');
    assert.equal(needsApproval(tool), true);
    assert.equal(batched(stamp(a2aTool())), false);
  });

  it('a read the skill claims for itself: still unknown, never batched, still asked for', () => {
    const claims = { sideEffect: 'read' };
    const tool = stamp(a2aTool(claims), null, WRITES);
    assert.equal(tool.sideEffect, 'unknown');
    assert.equal(tool.sideEffectSource, 'default');
    assert.notEqual(tool.readOnly, true);
    assert.equal(isTrustedReadOnly(tool), false);
    assert.equal(needsApproval(tool), true);
    assert.equal(batched(stamp(a2aTool(claims))), false);
  });

  it('batched, and no longer asked for, once an admin set the skill to read', () => {
    const instance = { id: 'desk', actions: { overrides: { summarise: { sideEffect: 'read' } } } };
    const tool = stamp(a2aTool(), instance, WRITES);
    assert.equal(tool.sideEffectSource, 'admin');
    assert.equal(tool.readOnly, true);
    assert.equal(needsApproval(tool), false);
    assert.equal(batched(stamp(a2aTool(), instance)), true);
  });
});
