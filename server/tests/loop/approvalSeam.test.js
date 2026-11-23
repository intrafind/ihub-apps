// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * The shared approval seam (#2945) outside the chat:
 *
 * - seam order: workflow / agent nodes register it first, scheduled runs hand
 *   it to the chat turn as its gate (before `chat-tools` and `passthrough`);
 * - headless fallback (`interactions.headlessFallback`): deny, park only when
 *   something can park it, fail;
 * - workflow nodes: deny unless approver groups are named, then park; the
 *   resumed node runs the stored call or hands the model the rejection;
 * - scheduled runs: "always allow for this task" still lets the call through;
 * - MCP gateway: a gated tool is refused with APPROVAL_REQUIRED_NO_USER;
 * - a definition migration that renames an action keeps its approval;
 * - every `runTool` caller is known (pre-mortem #4: a new bypass is noticed).
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { approvalSeam } from '../../services/loop/seams/approvalSeam.js';
import { scheduledRunSeams } from '../../services/scheduler/tasks/runSeams.js';
import { PromptNodeExecutor } from '../../services/workflow/executors/PromptNodeExecutor.js';
import { resumeApprovalPlan, pausedLoopState } from '../../services/workflow/questionPause.js';
import { ToolRunner } from '../../services/run/ToolRunner.js';
import { planMigration } from '../../services/integrations/definitions/migrationPlanner.js';

const GATED = { id: 'dangerous', approval: 'always', approvalSource: 'tool', sideEffect: 'write' };
const info = (toolDef = GATED, args = { target: 'A' }) => ({
  toolDef,
  toolId: toolDef.id,
  name: toolDef.id,
  args,
  call: { id: 'call_1', function: { name: toolDef.id } }
});
const ctx = (headlessFallback = 'park') => ({
  iteration: 1,
  messages: [],
  policies: { interactions: { headlessFallback } },
  meta: {}
});

test('ungated, granted and interactive calls pass through untouched', async () => {
  const seam = approvalSeam({ isGranted: i => i.toolId === 'granted' });
  assert.equal(await seam.preTool(ctx(), info({ id: 'free' })), null);
  assert.equal(await seam.preTool(ctx(), info({ ...GATED, id: 'granted' })), null);
  assert.equal(await seam.preTool(ctx(), info({ ...GATED, interactive: true })), null);
});

test('mayTakeOver: the seam says which calls it may hold, from the policy it resolves itself', () => {
  const seam = approvalSeam({ isGranted: () => true });
  assert.equal(seam.mayTakeOver(ctx(), info({ id: 'free' })), false);
  // A grant is not looked at: the call still counts as one that may be held.
  assert.equal(seam.mayTakeOver(ctx(), info()), true);
  assert.equal(seam.mayTakeOver(ctx(), info({ ...GATED, interactive: true })), false);
  assert.equal(seam.mayTakeOver(ctx(), { toolDef: null }), false);

  // A tool nobody stamped: the stamp says nothing, the seam's own resolver decides.
  const unstamped = { id: 'recall_tool_result', isInternalTool: true, sideEffect: 'read' };
  const always = approvalSeam({
    resolvePolicy: () => ({ approval: 'always', sideEffect: 'read', sideEffectSource: 'tool' })
  });
  assert.equal(always.mayTakeOver(ctx(), info(unstamped)), true);
  assert.equal(approvalSeam().mayTakeOver(ctx(), info(unstamped)), false);
});

test('headless fallback: deny and park-without-a-parker refuse with APPROVAL_REQUIRED_NO_USER; fail ends the run', async () => {
  for (const mode of ['deny', 'park']) {
    const out = await approvalSeam({ headless: true }).preTool(ctx(mode), info());
    assert.equal(out.handled, true);
    assert.equal(out.terminate, undefined, `${mode} lets the model carry on`);
    assert.equal(JSON.parse(out.message.content).code, 'APPROVAL_REQUIRED_NO_USER');
  }
  const failed = await approvalSeam({ headless: true }).preTool(ctx('fail'), info());
  assert.equal(failed.terminate.status, 'error');
  assert.equal(failed.terminate.error.code, 'APPROVAL_REQUIRED_NO_USER');
});

test('with someone to ask, the call pauses on the raised interaction', async () => {
  const raised = [];
  const seam = approvalSeam({
    raise: async (i, c, policy) => {
      raised.push({ args: i.args, policy });
      return { id: 'int-1', kind: 'approval' };
    }
  });
  const out = await seam.preTool(ctx(), info());
  assert.equal(out.terminate.status, 'paused');
  assert.equal(out.terminate.finishReason, 'approval');
  assert.equal(out.terminate.pendingInteraction.id, 'int-1');
  assert.match(out.message.content, /awaiting_approval/);
  assert.deepEqual(raised[0].args, { target: 'A' });
  assert.equal(raised[0].policy.approval, 'always');
});

test('workflow node: no approver groups → refused; approver groups → parked for them; the approved call is granted on resume', async () => {
  const executor = new PromptNodeExecutor({ agentLoop: {} });
  const denied = approvalSeam(
    executor._approvalSeamOptions({ context: { executionId: 'wf-1' }, nodeId: 'n1', config: {} })
  );
  const refusal = await denied.preTool(ctx(), info());
  assert.equal(JSON.parse(refusal.message.content).code, 'APPROVAL_REQUIRED_NO_USER');
  assert.equal(refusal.terminate, undefined);

  const options = executor._approvalSeamOptions({
    context: { executionId: 'wf-1' },
    nodeId: 'n1',
    config: { toolApproval: { approverGroups: ['legal'] } }
  });
  assert.equal(typeof options.raise, 'function', 'approver groups make it parkable');

  const resumed = executor._approvalSeamOptions({
    context: { executionId: 'wf-1' },
    nodeId: 'n1',
    config: { toolApproval: { approverGroups: ['legal'] } },
    resume: { toolCall: { id: 'call_1' }, args: { target: 'A' } }
  });
  assert.equal(resumed.isGranted(info()), true);
  assert.equal(resumed.isGranted({ ...info(), call: { id: 'call_2' } }), false);
});

test('workflow node: the node registers the approval seam before its other seams', async () => {
  let captured = null;
  const executor = new PromptNodeExecutor({
    agentLoop: {
      run: async request => {
        captured = request;
        return { status: 'completed', content: 'ok', usage: {}, messages: [] };
      }
    }
  });
  await executor.executeLLMWithTools({
    model: { id: 'm', provider: 'openai' },
    messages: [{ role: 'user', content: 'x' }],
    tools: [GATED],
    config: {},
    context: { executionId: 'wf-1' },
    nodeId: 'n1'
  });
  assert.deepEqual(
    captured.seams.map(s => s.name),
    ['approval', 'workflow-node', 'question']
  );
});

test('workflow node resume: approve runs the stored call with the stored args; reject becomes USER_REJECTED', () => {
  const paused = pausedLoopState({
    checkpointId: 'ckpt-1',
    toolCallId: 'call_1',
    messages: [
      {
        role: 'assistant',
        tool_calls: [{ id: 'call_1', function: { name: 'dangerous', arguments: '{"target":"B"}' } }]
      },
      { role: 'tool', tool_call_id: 'call_1', content: '{"status":"awaiting_approval"}' }
    ],
    approval: {
      toolCallId: 'call_1',
      toolId: 'dangerous',
      name: 'dangerous',
      args: { target: 'A' }
    }
  });
  const approved = resumeApprovalPlan(paused, { decision: 'approve' });
  assert.deepEqual(approved.resume.args, { target: 'A' });
  assert.equal(approved.resume.toolCall.id, 'call_1');
  const rejected = resumeApprovalPlan(paused, { decision: 'reject' });
  assert.equal(rejected.resume, null);
  assert.equal(JSON.parse(rejected.messages[1].content).code, 'USER_REJECTED');
  assert.equal(resumeApprovalPlan({ ...paused, kind: undefined }, { decision: 'approve' }), null);
});

test('scheduled runs: the gate is the shared seam; "always allow for this task" lets the call run', async () => {
  const { approvalGate, seams } = scheduledRunSeams({
    allowedTools: new Set(['allowed']),
    raiseApproval: async () => ({ id: 'int-2', kind: 'approval' })
  });
  assert.equal(approvalGate.name, 'approval');
  assert.ok(
    seams.every(s => typeof s.preTool !== 'function'),
    'no other seam takes a call over'
  );
  assert.equal(await approvalGate.preTool(ctx(), info({ ...GATED, id: 'allowed' })), null);
  const paused = await approvalGate.preTool(ctx(), info());
  assert.equal(paused.terminate.pendingInteraction.id, 'int-2');
});

test('MCP gateway: a gated tool cannot run, an ungated one can', async () => {
  // The gateway hands its calls to the tool runner with `approval: 'refuse'`
  // (server/tests/mcpToolUserContext.test.js drives the handler itself).
  const ran = [];
  const runner = new ToolRunner({ runTool: async toolId => ran.push(toolId) });
  const gatewayCall = (toolDef, platform = {}) =>
    runner.execute(null, {
      toolId: toolDef.id,
      toolDef,
      args: {},
      toolContext: { origin: 'mcp', approval: 'refuse', argsFrom: 'caller', platform }
    });
  await assert.rejects(gatewayCall({ id: 'x', approval: 'always' }), {
    code: 'APPROVAL_REQUIRED_NO_USER'
  });
  await gatewayCall({ id: 'y' });
  await assert.rejects(
    gatewayCall({ id: 'z' }, { toolApproval: { defaults: { default: 'always' } } }),
    {
      code: 'APPROVAL_REQUIRED_NO_USER'
    }
  );
  assert.deepEqual(ran, ['y']);
});

test('a definition migration that renames an action keeps its approval', () => {
  const instance = {
    id: 'crm',
    definition: 'com.example/crm',
    definitionVersion: '1.0.0',
    values: {},
    actions: { enabled: ['*'], disabled: [], overrides: {} },
    approval: { default: 'writes', actions: { create_lead: 'always' } }
  };
  const renamed = planMigration({
    instance,
    apps: [],
    definition: { id: 'com.example/crm', version: '2.0.0' },
    from: '1.0.0',
    migrations: [
      { id: '2.0.0', steps: [{ renameAction: { from: 'create_lead', to: 'create_contact' } }] }
    ]
  });
  assert.ok(renamed.ok);
  assert.deepEqual(renamed.instance.approval, {
    default: 'writes',
    actions: { create_contact: 'always' }
  });
  const removed = planMigration({
    instance,
    apps: [],
    definition: { id: 'com.example/crm', version: '2.0.0' },
    from: '1.0.0',
    migrations: [{ id: '2.0.0', steps: [{ removeAction: { name: 'create_lead' } }] }]
  });
  assert.deepEqual(removed.instance.approval, { default: 'writes' });
});

// ── pre-mortem #4: every runTool caller is known ────────────────────────────
//
// Every call of `runTool(` outside `server/services/run/` is an entry of
// `server/tests/run/runToolAllowList.json`, with its reason and the issue that
// removes it: server/tests/run/runToolCallers.test.js.

const here = path.dirname(fileURLToPath(import.meta.url));
const serverRoot = path.resolve(here, '../..');

async function* jsFiles(dir) {
  for (const entry of await fs.readdir(dir, { withFileTypes: true })) {
    if (['node_modules', 'tests', 'defaults'].includes(entry.name)) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) yield* jsFiles(full);
    else if (entry.name.endsWith('.js')) yield full;
  }
}

/**
 * Every place that calls an MCP server's or A2A agent's tool directly
 * (`callTool`, `callToolRaw`, `_callUserTool`) — below `runTool`, so outside
 * the approval seam — and why that is not a bypass.
 */
const KNOWN_REMOTE_TOOL_CALLERS = {
  'services/integrations/protocols/a2a/A2aAdapter.js': 'adapter.run, reached through runTool',
  'services/integrations/protocols/mcp/McpAdapter.js': 'adapter.run, reached through runTool',
  'services/mcp/McpClientManager.js': 'the client manager itself',
  'services/mcp/McpServerConnection.js': 'the connection itself',
  'routes/mcpAppRoutes.js': 'MCP App view calls: gated tools are refused before callToolRaw'
};

test('every direct MCP / A2A tool caller is listed with a reason', async () => {
  const callers = new Set();
  for await (const file of jsFiles(serverRoot)) {
    const rel = path.relative(serverRoot, file).split(path.sep).join('/');
    const source = await fs.readFile(file, 'utf8');
    const code = source
      .split('\n')
      .filter(line => !/^\s*(\*|\/\/)/.test(line))
      .join('\n');
    if (/\.(callTool|callToolRaw|_callUserTool)\(/.test(code)) callers.add(rel);
  }
  const unknown = [...callers].filter(rel => !KNOWN_REMOTE_TOOL_CALLERS[rel]);
  assert.deepEqual(unknown, [], 'new direct MCP/A2A tool callers: gate them or list them');
  const gone = Object.keys(KNOWN_REMOTE_TOOL_CALLERS).filter(rel => !callers.has(rel));
  assert.deepEqual(gone, [], 'listed callers that no longer call a remote tool');
});
