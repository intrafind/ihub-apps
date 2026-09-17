/**
 * Chat clarification lifecycle: a chat run paused for an `ask_user` question
 * ends when the question is answered, superseded or expires; workflow
 * questions (checkpoints) and runs that already ended are left alone.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { RunLog } from '../../services/loop/RunLog.js';
import { InteractionService } from '../../services/loop/InteractionService.js';
import {
  isChatClarification,
  endPausedChatRun,
  registerChatClarificationLifecycle
} from '../../services/chat/chatClarificationLifecycle.js';
import { RUN_LOG_EVENTS } from '../../../shared/runEvents.js';

async function setup() {
  const baseDir = await fs.mkdtemp(path.join(os.tmpdir(), 'chat-clarification-'));
  const runLog = new RunLog({ baseDir, forceEnabled: true, getPlatformConfig: () => ({}) });
  const svc = new InteractionService({ runLog, saveIntervalMs: 10 });
  const unregister = registerChatClarificationLifecycle(svc, { runLog });
  return { runLog, svc, unregister };
}

function waitForEnd(runLog, runId) {
  return new Promise(resolve => {
    const unsubscribe = runLog.subscribe(runId, event => {
      if (event.type !== RUN_LOG_EVENTS.RUN_END) return;
      unsubscribe();
      resolve(event);
    });
  });
}

async function pausedChatRun(runLog, svc, chatId) {
  const { runId } = await runLog.startRun({ kind: 'chat', user: { id: 'u1' } });
  runLog.append(runId, RUN_LOG_EVENTS.RUN_PAUSED, { reason: 'interaction' });
  const interaction = await svc.raise({
    runId,
    kind: 'question',
    origin: 'tool',
    prompt: { message: 'Which region?', inputType: 'text' },
    source: { toolCallId: 'call_1', toolId: 'ask_user', chatId }
  });
  return { runId, interaction };
}

test('isChatClarification: a tool question with a chat id and no checkpoint', () => {
  assert.equal(
    isChatClarification({ origin: 'tool', source: { chatId: 'c1', toolCallId: 'x' } }),
    true
  );
  assert.equal(
    isChatClarification({
      origin: 'tool',
      source: { chatId: 'c1', checkpointId: 'ckpt-1', executionId: 'wf-1' }
    }),
    false,
    'a question inside a workflow node pauses an execution instead'
  );
  assert.equal(isChatClarification({ origin: 'node', source: { chatId: 'c1' } }), false);
  assert.equal(isChatClarification({ origin: 'tool', source: {} }), false);
  assert.equal(isChatClarification(null), false);
});

test('answered / superseded / expired clarifications end their paused chat runs', async () => {
  const { runLog, svc, unregister } = await setup();

  const a = await pausedChatRun(runLog, svc, 'chat-a');
  const endA = waitForEnd(runLog, a.runId);
  await svc.answer(a.interaction.id, { value: 'EU' }, { user: { id: 'u1' }, channel: 'chat' });
  assert.deepEqual((await endA).data, {
    status: 'completed',
    finishReason: 'clarification_answered'
  });
  assert.equal(await runLog.hasEnded(a.runId), true);

  const b = await pausedChatRun(runLog, svc, 'chat-b');
  const endB = waitForEnd(runLog, b.runId);
  await svc.cancel(b.interaction.id, 'superseded');
  assert.equal((await endB).data.finishReason, 'clarification_superseded');
  assert.equal((await endB).data.status, 'aborted');

  const c = await pausedChatRun(runLog, svc, 'chat-c');
  const endC = waitForEnd(runLog, c.runId);
  await svc.expire(c.interaction.id);
  assert.equal((await endC).data.finishReason, 'clarification_expired');

  // The run listing reflects the end.
  await runLog.flush();
  const listed = await runLog.listRuns({});
  const statuses = Object.fromEntries(listed.map(r => [r.runId, r.status]));
  assert.equal(statuses[a.runId], 'completed');
  assert.equal(statuses[b.runId], 'aborted');
  assert.equal(statuses[c.runId], 'aborted');

  unregister();
  await svc.stop();
  await runLog.stop();
});

test('workflow questions and runs that already ended are left alone', async () => {
  const { runLog, svc, unregister } = await setup();

  // A question inside a workflow node: checkpointResume resumes the execution.
  const { runId: wfRun } = await runLog.startRun({ kind: 'workflow', user: { id: 'u1' } });
  const question = await svc.raise({
    runId: wfRun,
    kind: 'question',
    origin: 'tool',
    prompt: { message: 'Which quarter?', inputType: 'text' },
    source: { toolCallId: 'call_1', chatId: wfRun, checkpointId: 'ckpt-1', executionId: wfRun }
  });
  await svc.answer(question.id, { value: 'Q3' }, { user: { id: 'u1' } });
  await new Promise(r => setTimeout(r, 30));
  assert.equal(await runLog.hasEnded(wfRun), false);

  // A chat run that ended before its clarification was settled is not ended twice.
  const d = await pausedChatRun(runLog, svc, 'chat-d');
  runLog.endRun(d.runId, { status: 'aborted', finishReason: 'connection_closed' });
  assert.equal(await endPausedChatRun({ ...d.interaction, status: 'answered' }, { runLog }), null);
  await svc.answer(d.interaction.id, { value: 'US' }, { user: { id: 'u1' } });
  await new Promise(r => setTimeout(r, 30));
  await runLog.flush();
  const events = await runLog.readEvents(d.runId);
  const ends = events.filter(e => e.type === RUN_LOG_EVENTS.RUN_END);
  assert.equal(ends.length, 1);
  assert.equal(ends[0].data.finishReason, 'connection_closed');

  // Not a settled status: nothing to write.
  assert.equal(await endPausedChatRun({ ...d.interaction, status: 'pending' }, { runLog }), null);

  unregister();
  await svc.stop();
  await runLog.stop();
});
