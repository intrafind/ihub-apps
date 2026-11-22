// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * The segment planner in the mode a chat turn uses for parallel tool calls
 * (`parallelMode: 'readOnly'`, #2485): only calls of tools that are trusted
 * reads share a batch, and only when every call of the round is one.
 *
 * The tools are stamped the way `getToolsForApp` stamps them, so the test
 * holds the planner to what the tool list really carries.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { planToolBatches } from '../../services/loop/segmentPlanner.js';
import { toolPoliciesSchema } from '../../services/loop/contracts/loop.js';
import { stampToolApproval } from '../../utils/toolApproval.js';
import { shippedToolsDir } from '../../services/tools/shippedToolDefinitions.js';

const READ_ONLY = { parallel: true, parallelMode: 'readOnly' };

/** Stamp one tool, as the tool list of an app does. */
function stamped(tool, { app = null, platform = null, installation = null } = {}) {
  return stampToolApproval([tool], app, platform, {
    getInstallation: () => installation
  })[0];
}

const search = stamped({ id: 'search', sideEffect: 'read' });
const read = stamped({ id: 'read_url', sideEffect: 'read', dataFlow: 'external' });
const write = stamped({ id: 'write_memory', sideEffect: 'write' });
const undeclared = stamped({ id: 'custom__lookup', _integration: { instanceId: 'custom' } });
const annotated = stamped({
  id: 'remote__list',
  _mcp: { serverId: 'remote', originalName: 'list', annotations: { readOnlyHint: true } }
});

/** The calls of one round, in the model's order. */
const round = (...tools) =>
  tools.map((toolDef, index) => ({
    call: { id: `call_${index}`, function: { name: toolDef?.id || 'missing' } },
    toolDef,
    args: { q: `value ${index}` }
  }));

/** The batches as lists of call ids: what ran with what, and in which order. */
const ids = batches => batches.map(batch => batch.map(item => item.call.id));

test('every call a trusted read: one batch, in call order', () => {
  assert.deepEqual(ids(planToolBatches(round(search, read, search), READ_ONLY)), [
    ['call_0', 'call_1', 'call_2']
  ]);
});

test('two reads with the same arguments share a batch: targets are not looked at', () => {
  const calls = round(search, search).map(item => ({ ...item, args: { q: 'same' } }));
  assert.deepEqual(ids(planToolBatches(calls, READ_ONLY)), [['call_0', 'call_1']]);
});

test('maxParallel caps a batch; the default is four', () => {
  const six = round(search, search, search, search, search, search);
  assert.deepEqual(ids(planToolBatches(six, READ_ONLY)), [
    ['call_0', 'call_1', 'call_2', 'call_3'],
    ['call_4', 'call_5']
  ]);
  assert.deepEqual(ids(planToolBatches(six, { ...READ_ONLY, maxParallel: 2 })), [
    ['call_0', 'call_1'],
    ['call_2', 'call_3'],
    ['call_4', 'call_5']
  ]);
});

test('one write in the round: every call runs alone, in the model order', () => {
  for (const calls of [
    round(search, write, read),
    round(write, search, read),
    round(search, read, write)
  ]) {
    assert.deepEqual(ids(planToolBatches(calls, READ_ONLY)), [['call_0'], ['call_1'], ['call_2']]);
  }
});

test('two writes with different arguments never overlap', () => {
  // The `targets` mode batches them (their arguments do not overlap); a chat turn must not.
  const calls = round(write, write);
  assert.deepEqual(ids(planToolBatches(calls, { parallel: true })), [['call_0', 'call_1']]);
  assert.deepEqual(ids(planToolBatches(calls, READ_ONLY)), [['call_0'], ['call_1']]);
});

test('an action without a declared side effect is never batched', () => {
  assert.equal(undeclared.sideEffect, 'unknown');
  assert.deepEqual(ids(planToolBatches(round(undeclared, undeclared), READ_ONLY)), [
    ['call_0'],
    ['call_1']
  ]);
  assert.deepEqual(ids(planToolBatches(round(search, undeclared), READ_ONLY)), [
    ['call_0'],
    ['call_1']
  ]);
});

test('a read that only an MCP annotation claims is never batched', () => {
  assert.equal(annotated.sideEffect, 'read');
  assert.equal(annotated.sideEffectSource, 'annotation');
  assert.deepEqual(ids(planToolBatches(round(annotated, annotated), READ_ONLY)), [
    ['call_0'],
    ['call_1']
  ]);
  assert.deepEqual(ids(planToolBatches(round(search, annotated), READ_ONLY)), [
    ['call_0'],
    ['call_1']
  ]);
});

test('the same MCP tool is batched once an admin declared it a read', () => {
  const installation = { id: 'remote', actions: { overrides: { list: { sideEffect: 'read' } } } };
  const overridden = stamped(
    {
      id: 'remote__list',
      _integration: { instanceId: 'remote', action: 'list' },
      _mcp: { serverId: 'remote', originalName: 'list', annotations: { readOnlyHint: true } }
    },
    { installation }
  );
  assert.equal(overridden.sideEffectSource, 'admin');
  assert.deepEqual(ids(planToolBatches(round(overridden, overridden), READ_ONLY)), [
    ['call_0', 'call_1']
  ]);
});

test('a tool that only claims readOnly, with no stamp behind it, is never batched', () => {
  // What a tool object says about itself is not enough: the stamp decides.
  const claims = { id: 'claims', readOnly: true };
  const forged = { id: 'forged', readOnly: true, sideEffect: 'read', approvalSource: 'default' };
  for (const tool of [claims, forged]) {
    assert.deepEqual(
      ids(planToolBatches(round(tool, tool), READ_ONLY)),
      [['call_0'], ['call_1']],
      tool.id
    );
  }
});

test('the tools of the loop itself declare their read and are batched', () => {
  // Not stamped: the loop adds them to the tool list on its own.
  const recall = { id: 'recall_tool_result', isInternalTool: true, sideEffect: 'read' };
  assert.deepEqual(ids(planToolBatches(round(recall, recall), READ_ONLY)), [['call_0', 'call_1']]);
  // An internal tool that declares nothing is a read for the approval gate only.
  const silent = { id: 'silent', isInternalTool: true };
  assert.deepEqual(ids(planToolBatches(round(silent, silent), READ_ONLY)), [
    ['call_0'],
    ['call_1']
  ]);
});

test('interactive, passthrough and gated calls stay alone, and make the round serial', () => {
  const question = stamped({ id: 'ask_user', sideEffect: 'read', interactive: true });
  const handover = stamped({ id: 'workflow_x', sideEffect: 'read', passthrough: true });
  const gated = stamped({ id: 'gated', sideEffect: 'read', requiresApproval: true });
  for (const special of [question, handover, gated]) {
    assert.deepEqual(
      ids(planToolBatches(round(search, special, read), READ_ONLY)),
      [['call_0'], ['call_1'], ['call_2']],
      special.id
    );
  }
});

test('a read is gated, and so alone, where the app asks for every call', () => {
  const app = { id: 'careful', toolApproval: { default: 'always' } };
  const asked = stamped({ id: 'search', sideEffect: 'read' }, { app });
  assert.equal(asked.readOnly, true);
  assert.deepEqual(ids(planToolBatches(round(asked, asked), READ_ONLY)), [['call_0'], ['call_1']]);
  // Under `writes` a trusted read is not asked for, and is batched.
  const writesApp = { id: 'normal', toolApproval: { default: 'writes' } };
  const free = stamped({ id: 'search', sideEffect: 'read' }, { app: writesApp });
  assert.deepEqual(ids(planToolBatches(round(free, free), READ_ONLY)), [['call_0', 'call_1']]);
});

test('a tool that asks a person is never batched, marked interactive or not', () => {
  // Every caller of the loop marks such a tool `interactive`; the planner does not rely on it.
  const unmarked = stamped({ id: 'ask_user', sideEffect: 'read', requiresUserInput: true });
  assert.equal(unmarked.interactive, undefined);
  assert.deepEqual(ids(planToolBatches(round(search, unmarked), READ_ONLY)), [
    ['call_0'],
    ['call_1']
  ]);
});

test('a call a seam may take over makes the round serial, whatever its stamp says', () => {
  // The loop's own tools carry no stamp; the approval seam resolves their
  // policy itself and may hold them for a person (platform default `always`).
  const recall = { id: 'recall_tool_result', isInternalTool: true, sideEffect: 'read' };
  const asked = [];
  const mayTakeOver = item => {
    asked.push(item.call.id);
    return item.toolDef.id === 'recall_tool_result';
  };
  assert.deepEqual(ids(planToolBatches(round(search, recall, read), READ_ONLY, { mayTakeOver })), [
    ['call_0'],
    ['call_1'],
    ['call_2']
  ]);
  assert.ok(asked.includes('call_1'), 'the seams were asked about the unstamped call');
  // Nothing may be taken over: one batch.
  assert.deepEqual(
    ids(planToolBatches(round(search, recall, read), READ_ONLY, { mayTakeOver: () => false })),
    [['call_0', 'call_1', 'call_2']]
  );
});

test('the targets mode does not ask the seams: it is planned as before', () => {
  const calls = round(search, read);
  const mayTakeOver = () => {
    throw new Error('not asked in the targets mode');
  };
  assert.deepEqual(ids(planToolBatches(calls, { parallel: true }, { mayTakeOver })), [
    ['call_0', 'call_1']
  ]);
});

test('the targets mode batches by the same stamp: a declared read, never a claim', () => {
  // What a workflow or agent node with `parallelToolCalls: true` runs on
  // (`PromptNodeExecutor`): the mode `targets`, on tools stamped like a chat's.
  const TARGETS = { parallel: true };
  const shipped = id =>
    JSON.parse(readFileSync(path.join(shippedToolsDir(), `${id}.json`), 'utf8'));
  // No arguments: nothing names a target, so only `readOnly` can put two calls together.
  const bare = (...tools) => round(...tools).map(item => ({ ...item, args: {} }));

  const memory = stamped(shipped('read_memory'));
  const inbox = stamped(shipped('read_inbox'));
  assert.equal(memory.readOnly, true);
  assert.equal(inbox.readOnly, true);
  assert.deepEqual(ids(planToolBatches(bare(memory, inbox), TARGETS)), [['call_0', 'call_1']]);

  // The same two tools as they shipped before they declared anything: one at a time.
  // This is what the declaration changed for such a node, with no feature involved.
  const undeclaredTool = id => {
    const { sideEffect: _declared, ...before } = shipped(id);
    return stamped(before);
  };
  assert.deepEqual(
    ids(
      planToolBatches(bare(undeclaredTool('read_memory'), undeclaredTool('read_inbox')), TARGETS)
    ),
    [['call_0'], ['call_1']]
  );

  // A write, a tool that only claims to read and a remote tool that says so
  // about itself never count as read-only here either.
  const claims = stamped({ id: 'claims', readOnly: true });
  for (const other of [stamped(shipped('write_memory')), claims, annotated, undeclared]) {
    assert.deepEqual(
      ids(planToolBatches(bare(memory, other), TARGETS)),
      [['call_0'], ['call_1']],
      other.id
    );
  }

  // The node's default (`parallelToolCalls` unset): one call at a time, declared or not.
  assert.deepEqual(ids(planToolBatches(bare(memory, inbox), { parallel: false })), [
    ['call_0'],
    ['call_1']
  ]);
});

test('a call of a tool that is not registered is never batched', () => {
  assert.deepEqual(ids(planToolBatches(round(search, null), READ_ONLY)), [['call_0'], ['call_1']]);
});

test('parallel: false wins over the mode, and one call is one batch', () => {
  assert.deepEqual(
    ids(planToolBatches(round(search, read), { parallel: false, parallelMode: 'readOnly' })),
    [['call_0'], ['call_1']]
  );
  assert.deepEqual(ids(planToolBatches(round(search), READ_ONLY)), [['call_0']]);
});

test('every item keeps its place in the model order', () => {
  const batches = planToolBatches(round(search, read, search), READ_ONLY);
  assert.deepEqual(
    batches.flat().map(item => item.position),
    [0, 1, 2]
  );
});

test('the policy contract knows the mode and defaults to targets', () => {
  assert.equal(toolPoliciesSchema.parse({}).parallelMode, 'targets');
  assert.equal(toolPoliciesSchema.parse({ parallelMode: 'readOnly' }).parallelMode, 'readOnly');
  assert.throws(() => toolPoliciesSchema.parse({ parallelMode: 'everything' }));
});
