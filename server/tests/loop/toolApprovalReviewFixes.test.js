// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * Regression tests for the review of PR #3136 (tool approval, #2945):
 *
 *  1. an installation save without `approval` keeps the admin's gate
 *  2. a resumed workflow acts as its own principal, never as the approver
 *  3. an approved call in a workflow node runs once (consumed before it runs;
 *     the grant checks the arguments and is used once)
 *  4. a chat approval answered for a turn that is then refused can be sent again
 *  6. an approval the sweeper expired or cancelled continues as APPROVAL_EXPIRED
 *  7. the stored paused transcript is bounded (arguments, thought signatures, total)
 *  8. calls outside the loop (direct tool API for programs, MCP App views) are gated
 *  9. secret-looking arguments are redacted for anyone but the requester
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { InstalledIntegrationService } from '../../services/integrations/InstalledIntegrationService.js';
import {
  executionActingUser,
  CheckpointResumeError
} from '../../services/workflow/checkpointResume.js';
import { actorSnapshot } from '../../services/workflow/executionActor.js';
import {
  TOOL_APPROVAL_CHECKPOINT,
  resumeApprovalPlan
} from '../../services/workflow/questionPause.js';
import { PromptNodeExecutor } from '../../services/workflow/executors/PromptNodeExecutor.js';
import { oneShotGrant } from '../../services/loop/seams/approvalSeam.js';
import { RunLog } from '../../services/loop/RunLog.js';
import { InteractionService } from '../../services/loop/InteractionService.js';
import { FilesystemStorageProvider } from '../../storage/providers/filesystem/index.js';
import { ChatRepository } from '../../services/chat/ChatRepository.js';
import {
  MAX_TRANSCRIPT_CHARS,
  pausedTurnTranscript,
  prepareChatApproval,
  settleChatApprovals
} from '../../services/chat/chatToolApproval.js';
import {
  directCallNeedsApproval,
  isUnattendedCaller,
  redactInteractionForViewer,
  redactApprovalArgs
} from '../../utils/toolApproval.js';

const silent = { debug() {}, info() {}, warn() {}, error() {} };

// ── 1 ────────────────────────────────────────────────────────────────────────

test('#1 an installation save that does not name approval keeps the stored one; null clears it', async () => {
  const entry = {
    definition: {
      id: 'org.example/portal',
      protocol: { type: 'openapi' },
      auth: { modes: ['none'] },
      install: [],
      actions: []
    }
  };
  const service = new InstalledIntegrationService({
    registry: { list: () => [entry], get: () => entry, ensureLoaded: async () => {} }
  });
  const existing = {
    id: 'portal',
    definition: 'org.example/portal',
    approval: { default: 'always', actions: { create: 'always' } }
  };
  const base = { id: 'portal', definition: 'org.example/portal', enabled: true, values: {} };
  const kept = await service._prepare(base, { existing });
  assert.deepEqual(kept.instance.approval, existing.approval);
  const replaced = await service._prepare(
    { ...base, approval: { default: 'writes' } },
    { existing }
  );
  assert.deepEqual(replaced.instance.approval, { default: 'writes' });
  const cleared = await service._prepare({ ...base, approval: null }, { existing });
  assert.equal(cleared.instance.approval, undefined);
});

// ── 2 ────────────────────────────────────────────────────────────────────────

test('#2 a resumed execution acts as its recorded principal, never as the approver', () => {
  const owner = { id: 'ada', name: 'Ada', groups: ['users', 'sales'], authMode: 'oidc' };
  const approver = { id: 'boss', groups: ['admins', 'legal'] };
  const pending = { id: 'ckpt-1', nodeId: 'n1', type: TOOL_APPROVAL_CHECKPOINT };
  const state = {
    data: {
      _workflow: { actor: actorSnapshot(owner) },
      _pausedLoops: { n1: { kind: 'approval', approval: { actor: actorSnapshot(owner) } } }
    }
  };
  const acting = executionActingUser(state, pending, { answeringUser: approver });
  assert.equal(acting.id, 'ada');
  assert.deepEqual(acting.groups.includes('legal'), false);
  // A human checkpoint and a question continue as the execution's principal too.
  for (const type of ['approval', 'question']) {
    const user = executionActingUser(state, { ...pending, type }, { answeringUser: approver });
    assert.equal(user.id, 'ada');
  }
  // A tool approval without a recorded principal refuses to run the call.
  assert.throws(
    () => executionActingUser({ data: {} }, pending, { answeringUser: approver }),
    error => error instanceof CheckpointResumeError && error.code === 'ACTOR_UNKNOWN'
  );
  // An execution started before the actor was recorded: a question goes on as before.
  assert.equal(
    executionActingUser({ data: {} }, { ...pending, type: 'question' }, { answeringUser: approver })
      .id,
    'boss'
  );
  // Agent runs keep their agent principal kind.
  assert.deepEqual(actorSnapshot({ id: 'agent:p1', isAgent: true, profileId: 'p1' }), {
    kind: 'agent',
    profileId: 'p1',
    triggeredBy: null
  });
});

// ── 3 ────────────────────────────────────────────────────────────────────────

test('#3 the approved call is marked used on the state before it runs; a retried step does not run it again', async () => {
  const executor = new PromptNodeExecutor({ agentLoop: {} });
  const paused = {
    kind: 'approval',
    checkpointId: 'ckpt-1',
    messages: [
      { role: 'assistant', tool_calls: [{ id: 'call_1', function: { name: 'dangerous' } }] },
      { role: 'tool', tool_call_id: 'call_1', content: '{"status":"awaiting_approval"}' }
    ],
    approval: { toolCallId: 'call_1', name: 'dangerous', args: { target: 'A' } }
  };
  const state = { data: { _pausedLoops: { n1: paused } } };
  const updates = [];
  const context = {
    executionId: 'wf-1',
    engine: { stateManager: { update: async (id, patch) => updates.push({ id, patch }) } }
  };
  await executor._consumeApproval({ id: 'n1' }, context, state);
  assert.equal(updates.length, 1, 'persisted before the call runs');
  assert.equal(updates[0].patch.data._pausedLoops.n1.approval.consumed, true);
  assert.equal(state.data._pausedLoops.n1.approval.consumed, true);

  const retry = resumeApprovalPlan(state.data._pausedLoops.n1, { decision: 'approve' });
  assert.equal(retry.resume, null, 'a retried step never runs the approved call again');
  assert.equal(JSON.parse(retry.messages[1].content).code, 'APPROVAL_ALREADY_USED');
});

test('#3 the grant of an approved call checks the arguments and is used once', () => {
  const grant = oneShotGrant({ callId: 'call_1', args: { target: 'A' } });
  const call = (id, args) => ({ call: { id }, args });
  assert.equal(grant(call('call_1', { target: 'B' })), false, 'other arguments');
  assert.equal(grant(call('call_2', { target: 'A' })), false, 'another call');
  assert.equal(grant(call('call_1', { target: 'A' })), true);
  assert.equal(grant(call('call_1', { target: 'A' })), false, 'only once');
  const workflowGrant = new PromptNodeExecutor({ agentLoop: {} })._approvalSeamOptions({
    context: { executionId: 'wf-1' },
    nodeId: 'n1',
    config: {},
    resume: { toolCall: { id: 'call_1' }, args: { target: 'A' } }
  }).isGranted;
  assert.equal(workflowGrant(call('call_1', { target: 'X' })), false);
  assert.equal(workflowGrant(call('call_1', { target: 'A' })), true);
  assert.equal(workflowGrant(call('call_1', { target: 'A' })), false);
});

// ── 4 and 6 ──────────────────────────────────────────────────────────────────

async function setup(t) {
  const baseDir = await fs.mkdtemp(path.join(os.tmpdir(), 'tool-approval-review-'));
  const runLog = new RunLog({ baseDir, forceEnabled: true, getPlatformConfig: () => ({}) });
  const interactions = new InteractionService({ runLog, saveIntervalMs: 10 });
  const provider = new FilesystemStorageProvider({
    baseDir: path.join(baseDir, 'store'),
    flushIntervalMs: 25
  });
  await provider.initialize();
  const repository = new ChatRepository({
    documents: provider.documents,
    locks: provider.locks,
    logger: silent
  });
  t.after(async () => {
    await interactions.stop?.();
    await provider.shutdown();
    await fs.rm(baseDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  });
  return { interactions, repository };
}

async function pausedChat({ interactions, repository }, chatId) {
  const interaction = await interactions.raise({
    runId: 'chat-00000000-0000-4000-8000-000000000002',
    kind: 'approval',
    origin: 'tool',
    prompt: { message: 'Run?', displayData: { toolId: 'dangerous', args: { target: 'A' } } },
    policy: { timeoutMs: 60_000 },
    source: { chatId, toolCallId: 'call_1', toolId: 'dangerous' }
  });
  await repository.ensureChat({ chatId, ownerId: 'u1', identityMode: 'default', appId: 'app1' });
  await repository.updateChat(chatId, {
    toolApproval: {
      grants: [],
      pending: {
        interactionId: interaction.id,
        call: { id: 'call_1', name: 'dangerous', toolId: 'dangerous', args: { target: 'A' } },
        transcript: [{ role: 'tool', tool_call_id: 'call_1', content: '{}' }]
      }
    }
  });
  return interaction;
}

const allow = async () => true;
const approveMessage = interactionId => ({
  approvalResponse: { interactionId, decision: 'approve' }
});

test('#4 nothing is answered before commit; a refused turn puts the answered approval back once', async t => {
  const env = await setup(t);
  const chatId = 'chat-review-restore';
  const interaction = await pausedChat(env, chatId);
  const params = async () => ({
    chatId,
    user: { id: 'u1' },
    chat: await env.repository.getChat(chatId),
    lastMessage: approveMessage(interaction.id),
    repository: env.repository,
    interactionService: env.interactions,
    authorizeInteraction: allow
  });

  const prepared = await prepareChatApproval(await params());
  assert.equal(prepared.refusal, null);
  assert.equal((await env.interactions.get(interaction.id)).status, 'pending', 'not answered yet');

  const first = await prepared.commit();
  assert.equal(first.resume.outcome, 'approved');
  assert.equal((await env.repository.getChat(chatId)).toolApproval.pending, null);
  // The turn was refused before its loop ran: the approval goes back, with its answer.
  assert.equal(await first.restore(), true);
  assert.equal(
    (await env.repository.getChat(chatId)).toolApproval.pending.settled.outcome,
    'approved'
  );

  // The same decision again: used without answering twice; two at once → one wins.
  const [a, b] = await Promise.all([
    settleChatApprovals(await params()),
    settleChatApprovals(await params())
  ]);
  const resumed = [a, b].filter(r => r.resume);
  assert.equal(resumed.length, 1);
  assert.equal(resumed[0].resume.outcome, 'approved');
  assert.equal([a, b].find(r => r.refusal).refusal.code, 'APPROVAL_ALREADY_ANSWERED');
});

test('#6 an approval the sweeper cancelled or expired continues as expired and clears the chat', async t => {
  const env = await setup(t);
  for (const settle of ['cancel', 'expire']) {
    const chatId = `chat-review-${settle}`;
    const interaction = await pausedChat(env, chatId);
    await env.interactions[settle](interaction.id);
    const result = await settleChatApprovals({
      chatId,
      user: { id: 'u1' },
      chat: await env.repository.getChat(chatId),
      lastMessage: approveMessage(interaction.id),
      repository: env.repository,
      interactionService: env.interactions,
      authorizeInteraction: allow
    });
    assert.equal(result.refusal, null);
    assert.equal(result.resume.outcome, 'expired');
    assert.equal((await env.repository.getChat(chatId)).toolApproval.pending, null);
  }
});

// ── 7 ────────────────────────────────────────────────────────────────────────

test('#7 the paused transcript bounds arguments and thought signatures, and refuses what stays too large', () => {
  const huge = 'x'.repeat(40 * 1024);
  const question = { role: 'user', content: 'Q' };
  const messages = [
    question,
    {
      role: 'assistant',
      content: null,
      thoughtSignatures: [huge],
      tool_calls: [
        { id: 'c0', function: { name: 'search', arguments: JSON.stringify({ q: huge }) } },
        { id: 'call_1', function: { name: 'dangerous', arguments: '{"target":"A"}' } }
      ]
    },
    { role: 'tool', tool_call_id: 'c0', content: 'ok' },
    { role: 'tool', tool_call_id: 'call_1', content: '{"status":"awaiting_approval"}' }
  ];
  const transcript = pausedTurnTranscript(messages, {
    startMessage: question,
    toolCallId: 'call_1'
  });
  const [assistant] = transcript;
  assert.equal(assistant.thoughtSignatures, undefined);
  assert.doesNotThrow(() => JSON.parse(assistant.tool_calls[0].function.arguments));
  assert.ok(assistant.tool_calls[0].function.arguments.length < 200);
  assert.equal(assistant.tool_calls[1].function.arguments, '{"target":"A"}');
  assert.ok(JSON.stringify(transcript).length <= MAX_TRANSCRIPT_CHARS);

  // A step with so many calls that even the tight bound is exceeded: nothing is kept.
  const calls = Array.from({ length: 400 }, (_, i) => ({
    id: `c${i}`,
    function: { name: 'search', arguments: JSON.stringify({ q: 'y'.repeat(1500) }) }
  }));
  const crowded = [
    question,
    { role: 'assistant', content: null, tool_calls: [...calls, { id: 'call_1', function: {} }] }
  ];
  assert.equal(
    pausedTurnTranscript(crowded, { startMessage: question, toolCallId: 'call_1' }),
    null
  );
});

// ── 8 ────────────────────────────────────────────────────────────────────────

test('#8 programs cannot approve: the direct tool API and MCP App views refuse gated tools', () => {
  assert.equal(isUnattendedCaller({ id: 'c', isOAuthClient: true }), true);
  assert.equal(isUnattendedCaller({ id: 'k', isPersonalApiKey: true }), true);
  assert.equal(isUnattendedCaller({ id: 'u', authMode: 'oauth_authorization_code' }), true);
  assert.equal(isUnattendedCaller({ id: 'a', isAgent: true }), true);
  assert.equal(isUnattendedCaller({ id: 'u', authMode: 'oidc' }), false);

  const viewCall = {
    id: 'create_issue',
    _mcp: { serverId: 'jira', originalName: 'create_issue', annotations: { readOnlyHint: true } },
    _integration: { instanceId: 'jira', action: 'create_issue' }
  };
  const getInstallation = id => (id === 'jira' ? { id, approval: { default: 'writes' } } : null);
  // The server claims read-only; under "writes" that claim is not trusted.
  assert.equal(directCallNeedsApproval(viewCall, {}, { getInstallation }), true);
  assert.equal(directCallNeedsApproval(viewCall, {}, { getInstallation: () => null }), false);
});

// ── 9 ────────────────────────────────────────────────────────────────────────

test('#9 secret-looking arguments are redacted for anyone but the requester', () => {
  const interaction = {
    kind: 'approval',
    prompt: {
      displayData: {
        args: { query: 'ACME', apiKey: 'k-1', nested: { password: 'p', Authorization: 'Bearer x' } }
      }
    }
  };
  const seen = redactInteractionForViewer(interaction);
  assert.deepEqual(seen.prompt.displayData.args, {
    query: 'ACME',
    apiKey: '***REDACTED***',
    nested: { password: '***REDACTED***', Authorization: '***REDACTED***' }
  });
  assert.equal(interaction.prompt.displayData.args.apiKey, 'k-1', 'the stored args stay complete');
  assert.deepEqual(redactApprovalArgs({ token: 't', q: 1 }), { token: '***REDACTED***', q: 1 });
  const question = { kind: 'question', prompt: { displayData: { args: { token: 't' } } } };
  assert.equal(redactInteractionForViewer(question), question);
});
