/**
 * Who stopped a scheduled run: every abort of a running turn carries a cause,
 * and the run, its chat and the ledger say so. Also the server half of
 * issue #2830: a browser opening and leaving the chat of a running scheduled
 * run must not cancel it.
 */
import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import * as tasks from '../services/scheduler/tasks/taskService.js';
import { executeTaskRun } from '../services/scheduler/tasks/taskExecution.js';
import { getScheduledTaskRepository } from '../services/scheduler/tasks/ScheduledTaskRepository.js';
import { getChatRepository } from '../services/chat/ChatRepository.js';
import { abortCause, userAbortCause } from '../services/chat/abortCause.js';
import { abortChatRequest, abortChatRequestOnDisconnect } from '../sse.js';
import {
  cleanup,
  getLedger,
  principal,
  scriptedChatService,
  setupHarness,
  taskInput,
  teardownHarness
} from './helpers/scheduledTaskHarness.js';
import { openaiText } from './loop/helpers/llmFixtures.js';

before(() => setupHarness());
after(() => teardownHarness());

const ada = () => principal({ id: 'user-ada', name: 'Ada' });

/**
 * Start a run whose model call waits until the test lets it answer, or until
 * the turn is aborted (then it fails the way a cancelled request does).
 */
async function startBlockedRun(user, { replies = [openaiText(['Done.'])] } = {}) {
  const task = await tasks.createTask(user, taskInput());
  const queued = await tasks.requestRun(user, task.id);
  let reached;
  const modelCalled = new Promise(resolve => (reached = resolve));
  let release;
  const gate = new Promise(resolve => (release = resolve));
  const { deps } = scriptedChatService(replies, {
    onRequest: (_req, ctx) =>
      new Promise((resolve, reject) => {
        reached();
        gate.then(resolve);
        const abort = () => reject(new DOMException('The operation was aborted.', 'AbortError'));
        if (ctx.signal.aborted) abort();
        else ctx.signal.addEventListener('abort', abort, { once: true });
      })
  });
  const finished = executeTaskRun({ taskId: task.id, runId: queued.id }, deps);
  await modelCalled;
  const run = await getScheduledTaskRepository().getRun(task.id, queued.id);
  return { task, runId: queued.id, chatId: run.chatId, finished, release };
}

describe('the cause of a stopped scheduled run', () => {
  it('names the owner who cancelled it', async () => {
    const user = ada();
    const { task, runId, finished } = await startBlockedRun(user);

    await tasks.cancelRun(user, task.id, runId);
    const run = await finished;

    assert.equal(run.status, 'cancelled');
    assert.equal(run.reason.code, 'ABORTED');
    assert.equal(run.reason.message, 'Cancelled by the owner');
    assert.equal(run.reason.cause.kind, 'task_run_cancelled');
    assert.deepEqual(run.reason.cause.actor, { type: 'user', id: 'user-ada' });
    assert.equal(
      run.reason.cause.origin.via,
      'POST /api/scheduled-tasks/:taskId/runs/:runId/cancel'
    );
    assert.deepEqual(run.reason.cause.related, { taskId: task.id, runId });
    await cleanup(user);
  });

  it('records the cause on the ledger and on the stored message', async () => {
    const user = ada();
    const { chatId, finished } = await startBlockedRun(user);

    abortChatRequest(
      chatId,
      await userAbortCause('user_stop', user, {
        via: 'POST /api/apps/:appId/chat/:chatId/stop',
        source: 'stop-button'
      })
    );
    const run = await finished;

    assert.equal(run.reason.cause.kind, 'user_stop');
    assert.equal(run.reason.cause.origin.source, 'stop-button');
    const ended = getLedger()
      .events.filter(event => event.type === 'run/end' && event.data.cause)
      .at(-1);
    assert.equal(ended.data.status, 'aborted');
    assert.equal(ended.data.cause.kind, 'user_stop');
    const { messages } = await getChatRepository().getMessages(chatId);
    const answer = messages.find(message => message.role === 'assistant');
    assert.equal(answer.error.code, 'ABORTED');
    assert.equal(answer.error.message, 'Stopped from the chat');
    assert.equal(answer.error.cause.actor.id, 'user-ada');
    await cleanup(user);
  });

  it('an abort without a cause is recorded as unknown, not as nothing', async () => {
    const user = ada();
    const { chatId, finished } = await startBlockedRun(user);

    abortChatRequest(chatId);
    const run = await finished;

    assert.equal(run.status, 'cancelled');
    assert.equal(run.reason.cause.kind, 'unknown');
    await cleanup(user);
  });

  it('names an administrator who disabled the task', async () => {
    const user = ada();
    const { task, finished } = await startBlockedRun(user);

    await tasks.adminSetTaskStatus({ id: 'user-root', username: 'root' }, task.id, 'disabled');
    const run = await finished;

    assert.equal(run.status, 'cancelled');
    assert.equal(run.reason.cause.kind, 'task_disabled');
    assert.equal(run.reason.cause.actor.type, 'admin');
    await cleanup(user);
  });
});

describe('opening and leaving the chat of a running scheduled run (#2830)', () => {
  it('does not cancel it when the browser disconnects', async () => {
    const user = ada();
    const { chatId, finished, release } = await startBlockedRun(user);

    // What the SSE close handler of the chat stream does.
    const applied = abortChatRequestOnDisconnect(chatId);
    assert.equal(applied, false, 'a durable turn keeps running');
    release();
    const run = await finished;

    assert.equal(run.status, 'succeeded');
    await cleanup(user);
  });

  it('does not cancel it when an evicted or failed stream is torn down', async () => {
    const user = ada();
    const { chatId, finished, release } = await startBlockedRun(user);

    abortChatRequestOnDisconnect(
      chatId,
      abortCause('client_evicted', { via: 'inactive SSE client sweep' })
    );
    release();

    assert.equal((await finished).status, 'succeeded');
    await cleanup(user);
  });
});
