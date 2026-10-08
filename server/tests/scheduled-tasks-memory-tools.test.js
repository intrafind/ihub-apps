/**
 * `list_task_runs` and `get_task_run`: what a run can read about the earlier
 * runs of its own task, and everything it must not be able to read.
 *
 * The earlier runs are real: executed through the real ChatService, so their
 * chats and ledger ids are what the product stores. The owner's follow-ups in
 * a run chat are appended the way a continued chat stores them.
 */
import { randomUUID } from 'node:crypto';
import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  cleanup,
  principal,
  scriptedChatService,
  setPlatform,
  setupHarness,
  taskInput,
  teardownHarness,
  toolCall,
  APPS,
  DAILY
} from './helpers/scheduledTaskHarness.js';
import configCache from '../configCache.js';
import { openaiText } from './loop/helpers/llmFixtures.js';
import { getToolsForApp, runTool } from '../toolLoader.js';
import { getChatRepository } from '../services/chat/ChatRepository.js';
import * as tasks from '../services/scheduler/tasks/taskService.js';
import { executeTaskRun } from '../services/scheduler/tasks/taskExecution.js';
import {
  getScheduledTaskRepository,
  newRunId
} from '../services/scheduler/tasks/ScheduledTaskRepository.js';
import { RUN_ONLY_TOOLS, filterSchedulingTools } from '../services/scheduler/tasks/toolGate.js';
import { integrationIssueOf } from '../services/scheduler/tasks/runSeams.js';
import {
  clipText,
  conversationWithin,
  pickRunMessages,
  projectRun
} from '../services/scheduler/tasks/runHistory.js';
import { getTaskRun, listTaskRuns } from '../tools/scheduledTaskTools.js';

const MEMORY_TOOLS = ['read_memory', 'write_memory', 'list_task_runs', 'get_task_run'];

before(() => setupHarness({ defaultTools: MEMORY_TOOLS }));
after(() => teardownHarness());

const ada = () => principal({ id: 'user-ada', name: 'Ada' });
const grace = () => principal({ id: 'user-grace', name: 'Grace' });
const stored = id => getScheduledTaskRepository().getTask(id);

async function newTask(extra = {}) {
  return tasks.createTask(ada(), taskInput({ memory: true, ...extra }));
}

/** Execute one run to its end with a scripted answer. */
async function earlierRun(task, answer, { script, options } = {}) {
  const queued = await tasks.requestRun(ada(), task.id);
  const chat = scriptedChatService(script || [openaiText([answer])], options);
  const run = await executeTaskRun({ taskId: task.id, runId: queued.id }, chat.deps);
  return run;
}

/** The principal of a run that is going on right now: the asking run. */
async function asking(task, user = ada()) {
  const current = await tasks.requestRun(user, task.id);
  return { ...user, scheduledRun: { taskId: task.id, runId: current.id } };
}

async function appendToChat(run, message) {
  return getChatRepository().appendMessage(run.chatId, message);
}

/** The owner continued the chat of a run: their message and the model's reply. */
async function ownerFollowUp(run, userText, replyText, runId = `chat-followup-${Date.now()}`) {
  await appendToChat(run, { role: 'user', content: userText, runId });
  await appendToChat(run, { role: 'assistant', content: replyText, runId, finishReason: 'stop' });
}

describe('list_task_runs', () => {
  it('lists the earlier runs newest first, without the run that asks', async () => {
    const task = await newTask();
    await earlierRun(task, 'Report one');
    await earlierRun(task, 'Report two');
    const user = await asking(task);

    const result = await listTaskRuns({ user });
    assert.deepEqual(
      result.runs.map(run => run.runNumber),
      [2, 1]
    );
    assert.equal(result.runs[0].status, 'succeeded');
    assert.equal(result.runs[0].trigger, 'manual');
    assert.equal(result.runs[0].hasChat, true);
    assert.equal(result.runs[0].changed, true, 'the verdict of the run that kept memory');
    assert.ok(result.runs[0].startedAt && result.runs[0].finishedAt);
    await cleanup(ada());
  });

  it('shows only what the model needs: no lease, no ledger ids, no chat ids', async () => {
    const task = await newTask();
    await earlierRun(task, 'x');
    const result = await listTaskRuns({ user: await asking(task) });
    const text = JSON.stringify(result);
    for (const secret of ['execution', 'leaseUntil', 'ledgerRunIds', 'chatId', 'ownerId']) {
      assert.ok(!text.includes(secret), secret);
    }
    assert.deepEqual(Object.keys(result.runs[0]).sort(), [
      'changed',
      'durationMs',
      'finishedAt',
      'hasChat',
      'reason',
      'runNumber',
      'scheduledFor',
      'startedAt',
      'status',
      'trigger'
    ]);
    await cleanup(ada());
  });

  it('honours the limit, with a default of five and a most of twenty', async () => {
    const task = await newTask();
    for (let n = 1; n <= 7; n += 1) await earlierRun(task, `r${n}`);
    const user = await asking(task);
    assert.equal((await listTaskRuns({ user })).runs.length, 5);
    assert.equal((await listTaskRuns({ user, limit: 2 })).runs.length, 2);
    assert.equal((await listTaskRuns({ user, limit: '3' })).runs.length, 3);
    assert.equal((await listTaskRuns({ user, limit: 500 })).runs.length, 7);
    assert.equal((await listTaskRuns({ user, limit: 0 })).runs.length, 1);
    assert.equal((await listTaskRuns({ user, limit: 'many' })).runs.length, 5);
    await cleanup(ada());
  });

  it('has an empty list on the first run', async () => {
    const task = await newTask();
    assert.deepEqual(await listTaskRuns({ user: await asking(task) }), { runs: [] });
    await cleanup(ada());
  });

  it('shows runs that were skipped, failed or cancelled, with their reasons', async () => {
    const task = await newTask();
    await earlierRun(task, 'fine');
    const failed = await earlierRun(task, null, { script: [] });
    assert.equal(failed.status, 'failed');
    const result = await listTaskRuns({ user: await asking(task) });
    assert.equal(result.runs[0].status, 'failed');
    assert.ok(result.runs[0].reason.message);
    assert.equal(result.runs[1].status, 'succeeded');
    await cleanup(ada());
  });
});

describe('get_task_run', () => {
  it('returns the answer of an earlier run', async () => {
    const task = await newTask();
    await earlierRun(task, 'Release v1.2 adds dark mode.');
    const result = await getTaskRun({ user: await asking(task), runNumber: 1 });
    assert.equal(result.found, true);
    assert.equal(result.run.runNumber, 1);
    assert.equal(result.run.status, 'succeeded');
    assert.equal(result.run.answer.content, 'Release v1.2 adds dark mode.');
    assert.equal(result.run.answer.partial, false);
    assert.equal(result.run.answer.truncated, false);
    assert.equal(result.run.uncertain, false);
    assert.equal(result.run.ownerReplies, 0);
    assert.equal(result.run.note, null);
    assert.equal(result.run.conversation, undefined, 'only when asked for');
    await cleanup(ada());
  });

  it("is not fooled by the owner continuing the chat: the answer stays the run's own", async () => {
    const task = await newTask();
    const run = await earlierRun(task, 'The run answer.');
    await ownerFollowUp(run, 'Please leave out the translation changes', 'Understood, I will.');
    // An item added through the Conversations API has no run id at all.
    await appendToChat(run, { role: 'assistant', content: 'Injected later', runId: null });

    const result = await getTaskRun({ user: await asking(task), runNumber: 1 });
    assert.equal(result.run.answer.content, 'The run answer.');
    assert.equal(result.run.ownerReplies, 1, 'the model is told the owner wrote something');
    await cleanup(ada());
  });

  it("shows the owner's replies and the answers to them when asked for the conversation", async () => {
    const task = await newTask();
    const run = await earlierRun(task, 'The run answer.');
    await ownerFollowUp(run, 'Leave out the translation changes next time', 'Understood.');
    const result = await getTaskRun({
      user: await asking(task),
      runNumber: 1,
      include: 'conversation'
    });
    assert.deepEqual(
      result.run.conversation.map(({ role, from, content }) => ({ role, from, content })),
      [
        { role: 'assistant', from: 'run', content: 'The run answer.' },
        { role: 'user', from: 'followup', content: 'Leave out the translation changes next time' },
        { role: 'assistant', from: 'followup', content: 'Understood.' }
      ]
    );
    assert.equal(result.run.omittedMessages, 0);
    // The task's own instructions are not repeated back to it.
    assert.ok(!JSON.stringify(result.run.conversation).includes('Report the latest releases'));
    await cleanup(ada());
  });

  it('finds the answer of the last execution of a run that paused for an approval', async () => {
    const task = await newTask();
    const queued = await tasks.requestRun(ada(), task.id);
    const first = scriptedChatService([toolCall('dangerous')]);
    const paused = await executeTaskRun({ taskId: task.id, runId: queued.id }, first.deps);
    assert.equal(paused.status, 'awaiting_approval');
    await tasks.answerApproval(ada(), task.id, queued.id, { decision: 'approve' });
    const second = scriptedChatService([
      toolCall('dangerous'),
      openaiText(['Done after approval.'])
    ]);
    const done = await executeTaskRun({ taskId: task.id, runId: queued.id }, second.deps);
    assert.equal(done.ledgerRunIds.length, 2, 'one ledger id per execution');

    const user = await asking(task);
    const result = await getTaskRun({ user, runNumber: 1 });
    assert.equal(result.run.answer.content, 'Done after approval.');
    assert.equal(result.run.answer.partial, false);
    const conversation = await getTaskRun({ user, runNumber: 1, include: 'conversation' });
    // The approval note is the run's own, not something the owner said.
    assert.ok(conversation.run.conversation.every(message => message.from === 'run'));
    await cleanup(ada());
  });

  it('falls back to the first message when the run document has no ledger ids, and says so', async () => {
    const task = await newTask();
    const run = await earlierRun(task, 'Answer from a crashed run');
    await getScheduledTaskRepository().mutateRun(task.id, run.id, document => {
      delete document.ledgerRunIds;
      return document;
    });
    const result = await getTaskRun({ user: await asking(task), runNumber: 1 });
    assert.equal(result.run.answer.content, 'Answer from a crashed run');
    assert.equal(result.run.uncertain, true);
    await cleanup(ada());
  });

  it('says why there is no answer when the chat is gone', async () => {
    const task = await newTask();
    const trimmed = await earlierRun(task, 'trimmed away');
    await getScheduledTaskRepository().mutateRun(task.id, trimmed.id, document => ({
      ...document,
      chatDeleted: true
    }));
    const deleted = await earlierRun(task, 'deleted by the owner');
    assert.equal(await tasks.deleteRunChat(deleted.chatId), true);

    const user = await asking(task);
    const first = await getTaskRun({ user, runNumber: 1 });
    assert.equal(first.found, true);
    assert.equal(first.run.answer, null);
    assert.equal(first.run.note, 'NO_CHAT');
    assert.equal(first.run.hasChat, false);
    const second = await getTaskRun({ user, runNumber: 2 });
    assert.equal(second.run.answer, null);
    assert.equal(second.run.note, 'CHAT_DELETED');
    assert.equal(second.run.status, 'succeeded', 'the run itself is still known');
    await cleanup(ada());
  });

  it('says when the answer is no longer stored although the chat is', async () => {
    const task = await newTask();
    const run = await earlierRun(task, 'will be edited away');
    const { messages } = await getChatRepository().getMessages(run.chatId);
    const answer = messages.find(message => message.role === 'assistant');
    // The owner edited the first message and regenerated: history is cut from it.
    await getChatRepository().appendMessage(
      run.chatId,
      { role: 'user', content: 'a different question', runId: 'chat-edited' },
      { replaceFromMessageId: messages[0].id }
    );
    assert.ok(answer);
    const result = await getTaskRun({ user: await asking(task), runNumber: 1 });
    assert.equal(result.found, true);
    assert.equal(result.run.answer, null);
    assert.equal(result.run.note, 'ANSWER_NOT_STORED');
    await cleanup(ada());
  });

  it('cuts a long answer to the limit and says it was cut', async () => {
    const task = await newTask();
    await earlierRun(task, 'L'.repeat(3000));
    setPlatform({ scheduledTasks: { maxHistoryReadChars: 1000 } });
    try {
      const result = await getTaskRun({ user: await asking(task), runNumber: 1 });
      assert.equal(result.run.answer.truncated, true);
      assert.ok(result.run.answer.content.startsWith('L'.repeat(1000)));
      assert.match(result.run.answer.content, /\[cut: 2000 more characters\]$/);
    } finally {
      setPlatform();
    }
    await cleanup(ada());
  });

  it('keeps the answer and drops the oldest messages when the conversation is too long', async () => {
    const task = await newTask();
    const run = await earlierRun(task, 'The answer');
    await ownerFollowUp(
      run,
      'first long question '.repeat(40),
      'first long reply '.repeat(40),
      'chat-f1'
    );
    await ownerFollowUp(run, 'the latest question', 'the latest reply', 'chat-f2');
    setPlatform({ scheduledTasks: { maxHistoryReadChars: 1000 } });
    try {
      const result = await getTaskRun({
        user: await asking(task),
        runNumber: 1,
        include: 'conversation'
      });
      const contents = result.run.conversation.map(message => message.content);
      assert.ok(contents.includes('The answer'));
      assert.ok(contents.includes('the latest reply'));
      assert.ok(result.run.omittedMessages >= 1);
      assert.ok(contents.join('').length <= 1000);
    } finally {
      setPlatform();
    }
    await cleanup(ada());
  });

  it("does not mark the owner's unread chat as seen by reading it", async () => {
    const task = await newTask();
    const run = await earlierRun(task, 'unread answer');
    const chats = getChatRepository();
    await chats.updateChat(run.chatId, { hasUnseenActivity: true });
    const user = await asking(task);
    await getTaskRun({ user, runNumber: 1, include: 'conversation' });
    assert.equal((await chats.getChat(run.chatId)).hasUnseenActivity, true);
    const unseenBefore = (await stored(task.id)).unseenRuns.length;
    await getTaskRun({ user, runNumber: 1 });
    assert.equal((await stored(task.id)).unseenRuns.length, unseenBefore);
    await cleanup(ada());
  });

  it('refuses the run that is asking, a number nobody has, and a bad number', async () => {
    const task = await newTask();
    await earlierRun(task, 'one');
    const user = await asking(task);
    const own = await getTaskRun({ user, runNumber: 2 });
    assert.equal(own.found, false);
    assert.equal(own.code, 'CURRENT_RUN');
    const missing = await getTaskRun({ user, runNumber: 99 });
    assert.equal(missing.found, false);
    assert.equal(missing.code, 'RUN_NOT_FOUND');
    for (const runNumber of [0, -1, 1.5, 'x', undefined, null]) {
      const bad = await getTaskRun({ user, runNumber });
      assert.equal(bad.error, true, String(runNumber));
      assert.equal(bad.code, 'INVALID_ARGUMENT');
    }
    await cleanup(ada());
  });

  it('finds an old run among many without reading every page', async () => {
    const task = await newTask();
    const repository = getScheduledTaskRepository();
    const record = await stored(task.id);
    const base = Date.now() - 400 * 60_000;
    for (let number = 1; number <= 250; number += 1) {
      await repository.putRun({
        id: newRunId(base + number * 60_000),
        taskId: task.id,
        ownerId: record.ownerId,
        taskName: record.name,
        runNumber: number,
        trigger: 'schedule',
        status: 'succeeded',
        scheduledFor: new Date(base + number * 60_000).toISOString(),
        queuedAt: new Date(base + number * 60_000).toISOString(),
        startedAt: new Date(base + number * 60_000).toISOString(),
        finishedAt: new Date(base + number * 60_000).toISOString(),
        chatId: null
      });
    }
    await repository.mutateTask(task.id, document => ({ ...document, runNumber: 250 }));
    const user = await asking(task);
    const old = await getTaskRun({ user, runNumber: 5 });
    assert.equal(old.found, true);
    assert.equal(old.run.runNumber, 5);
    assert.equal(old.run.note, 'NO_CHAT');
    const ahead = await getTaskRun({ user, runNumber: 100000 });
    assert.equal(ahead.code, 'RUN_NOT_FOUND');
    await cleanup(ada());
  });
});

describe('who may use them', () => {
  it('refuses them outside a scheduled run', async () => {
    const task = await newTask();
    for (const result of [
      await listTaskRuns({ user: ada() }),
      await getTaskRun({ user: ada(), runNumber: 1 }),
      await listTaskRuns({}),
      await getTaskRun({})
    ]) {
      assert.equal(result.error, true);
      assert.equal(result.code, 'NOT_AVAILABLE');
    }
    assert.ok(task);
    await cleanup(ada());
  });

  it('refuses them for a task that does not keep memory', async () => {
    const task = await newTask({ memory: false });
    await earlierRun(task, 'x');
    const user = await asking(task);
    assert.equal((await listTaskRuns({ user })).code, 'NOT_AVAILABLE');
    assert.equal((await getTaskRun({ user, runNumber: 1 })).code, 'NOT_AVAILABLE');
    await cleanup(ada());
  });

  it('refuses them while the installation has memory switched off', async () => {
    const task = await newTask();
    await earlierRun(task, 'x');
    const user = await asking(task);
    setPlatform({ scheduledTasks: { memoryEnabled: false } });
    try {
      assert.equal((await listTaskRuns({ user })).code, 'NOT_AVAILABLE');
    } finally {
      setPlatform();
    }
    await cleanup(ada());
  });

  it('ignore a task id in the arguments: a run only ever reads its own task', async () => {
    const mine = await newTask({ name: 'mine' });
    const other = await newTask({ name: 'other' });
    await earlierRun(mine, 'my answer');
    await earlierRun(other, 'the other task answer');
    const user = await asking(mine);
    const result = await getTaskRun({
      user,
      runNumber: 1,
      taskId: other.id,
      chatId: 'whatever',
      ownerId: 'someone'
    });
    assert.equal(result.run.answer.content, 'my answer');
    const list = await listTaskRuns({ user, taskId: other.id });
    assert.equal(list.runs.length, 1);
    await cleanup(ada());
  });

  it('refuse a principal that is not the owner of the task it names', async () => {
    const task = await newTask();
    await earlierRun(task, 'private to Ada');
    const forged = { ...grace(), scheduledRun: { taskId: task.id, runId: 'r-forged' } };
    const list = await listTaskRuns({ user: forged });
    const read = await getTaskRun({ user: forged, runNumber: 1 });
    for (const result of [list, read]) {
      assert.equal(result.error, true);
      assert.equal(result.code, 'TASK_NOT_FOUND');
      assert.ok(!JSON.stringify(result).includes('private to Ada'));
    }
    await cleanup(ada());
  });

  it('refuse a chat that does not belong to the task and run the document names', async () => {
    const mine = await newTask({ name: 'mine' });
    const other = await newTask({ name: 'other' });
    const myRun = await earlierRun(mine, 'my answer');
    const otherRun = await earlierRun(other, 'secret of the other task');
    // A run document that points at another task's chat.
    await getScheduledTaskRepository().mutateRun(mine.id, myRun.id, document => ({
      ...document,
      chatId: otherRun.chatId
    }));
    const result = await getTaskRun({ user: await asking(mine), runNumber: 1 });
    assert.equal(result.found, false);
    assert.equal(result.code, 'RUN_NOT_FOUND');
    assert.ok(!JSON.stringify(result).includes('secret of the other task'));
    await cleanup(ada());
  });

  describe('a chat is read only when every part of its identity agrees', () => {
    /** A chat that differs from the real run chat in one respect, and says it holds a secret. */
    async function craftedChat(task, run, { ownerId, origin }) {
      const record = await stored(task.id);
      const chatId = randomUUID();
      await getChatRepository().ensureChat({
        chatId,
        ownerId: ownerId ?? record.ownerId,
        identityMode: 'default',
        origin: { createdVia: 'scheduled-task', taskId: task.id, runId: run.id, ...origin }
      });
      await getChatRepository().appendMessage(chatId, {
        role: 'user',
        content: 'instructions',
        runId: 'chat-crafted'
      });
      await getChatRepository().appendMessage(chatId, {
        role: 'assistant',
        content: 'crafted secret',
        runId: 'chat-crafted'
      });
      await getScheduledTaskRepository().mutateRun(task.id, run.id, document => ({
        ...document,
        chatId,
        ledgerRunIds: ['chat-crafted']
      }));
      return chatId;
    }

    it('reads a chat that agrees on all of it (the control for the cases below)', async () => {
      const task = await newTask();
      const run = await earlierRun(task, 'real');
      await craftedChat(task, run, {});
      const result = await getTaskRun({ user: await asking(task), runNumber: 1 });
      assert.equal(result.found, true);
      assert.equal(result.run.answer.content, 'crafted secret');
      await cleanup(ada());
    });

    for (const [name, build] of [
      [
        'another task',
        async () => ({ origin: { taskId: (await newTask({ name: 'elsewhere' })).id } })
      ],
      ['another kind of chat', async () => ({ origin: { createdVia: 'ui' } })],
      ['another run', async () => ({ origin: { runId: 'r0000000000000-deadbeef' } })],
      ['another owner', async () => ({ ownerId: 'someone-else' })]
    ]) {
      it(`refuses a chat that is ${name}`, async () => {
        const task = await newTask();
        const run = await earlierRun(task, 'real');
        await craftedChat(task, run, await build());
        const result = await getTaskRun({ user: await asking(task), runNumber: 1 });
        assert.equal(result.found, false);
        assert.equal(result.code, 'RUN_NOT_FOUND');
        assert.ok(!JSON.stringify(result).includes('crafted secret'));
        await cleanup(ada());
      });
    }
  });

  it('work in pseudonymized identity mode, where the user id is not the owner id', async () => {
    setPlatform({ runLog: { identityMode: 'pseudonymized' } });
    try {
      const task = await newTask({ name: 'pseudonymous' });
      const record = await stored(task.id);
      assert.notEqual(record.ownerId, 'user-ada', 'the owner is a fingerprint, not the user id');
      await earlierRun(task, 'answer in pseudonymized mode');
      const user = await asking(task);
      const list = await listTaskRuns({ user });
      assert.equal(list.runs.length, 1);
      const read = await getTaskRun({ user, runNumber: 1 });
      assert.equal(read.found, true);
      assert.equal(read.run.answer.content, 'answer in pseudonymized mode');
      // Another user still cannot.
      const forged = { ...grace(), scheduledRun: user.scheduledRun };
      assert.equal((await getTaskRun({ user: forged, runNumber: 1 })).code, 'TASK_NOT_FOUND');
    } finally {
      setPlatform();
    }
    await cleanup(ada());
  });
});

describe('nothing an app or a task can do offers them', () => {
  it('the gate removes them from every tool list, even in a run of a permitted user', () => {
    const tools = [
      { id: 'lookup' },
      { id: 'list_task_runs' },
      { id: 'get_task_run' },
      { id: 'list_scheduled_tasks' }
    ];
    const user = { ...ada(), scheduledRun: { taskId: 't', runId: 'r' } };
    const kept = filterSchedulingTools(tools, user, { configured: () => true }).map(
      tool => tool.id
    );
    assert.deepEqual(kept, ['lookup', 'list_scheduled_tasks']);
    assert.deepEqual([...RUN_ONLY_TOOLS].sort(), ['get_task_run', 'list_task_runs']);
    // Not even when the feature is off or the caller is anonymous.
    assert.deepEqual(
      filterSchedulingTools(tools, null, { configured: () => false }).map(tool => tool.id),
      ['lookup']
    );
  });

  it('an app that lists them does not get them', async () => {
    const greedy = {
      id: 'greedy',
      name: { en: 'Greedy' },
      system: { en: 'x' },
      preferredModel: 'oa',
      enabled: true,
      tools: ['lookup', 'list_task_runs', 'get_task_run']
    };
    const offered = await getToolsForApp(greedy, 'en', { user: ada() });
    assert.deepEqual(
      offered.map(tool => tool.id),
      ['lookup']
    );
  });

  it('a task cannot pick them, and they are not among the tools an app offers a task', async () => {
    const app = configCache.getApps().data.find(entry => entry.id === 'digest');
    const offered = (await tasks.toolsOfferedByApp(app, ada(), 'en')).map(tool => tool.id);
    assert.ok(!offered.includes('list_task_runs'));
    assert.ok(!offered.includes('get_task_run'));
    await assert.rejects(
      tasks.createTask(ada(), taskInput({ enabledTools: ['list_task_runs'] })),
      error => error.status === 400
    );
  });

  it('refuse a direct call that did not come from a run (the tool route, the MCP gateway)', async () => {
    const task = await newTask();
    await earlierRun(task, 'x');
    const viaTool = await runTool('get_task_run', { user: ada(), runNumber: 1 });
    assert.equal(viaTool.code, 'NOT_AVAILABLE');
    const viaToolList = await runTool('list_task_runs', { user: ada() });
    assert.equal(viaToolList.code, 'NOT_AVAILABLE');
    await cleanup(ada());
  });
});

describe('reading the past cannot fail the run that reads it', () => {
  const kinds = [
    {
      found: true,
      run: {
        status: 'failed',
        reason: {
          code: 'INTEGRATION_RECONNECT_REQUIRED',
          message: 'Reconnect Jira: the connection has expired'
        }
      }
    },
    { runs: [{ reason: { message: 'Reconnect Jira, please sign in again' } }] },
    {
      found: false,
      code: 'RUN_NOT_FOUND',
      message: 'No earlier run of this task has that number, or it was removed.'
    },
    {
      found: false,
      code: 'CURRENT_RUN',
      message: 'That is the run you are in. Ask for an earlier one.'
    }
  ];

  it('no result shape looks like an integration problem to the run', () => {
    for (const result of kinds) {
      assert.equal(integrationIssueOf('get_task_run', result), null, JSON.stringify(result));
    }
  });

  it('no refusal or failure does either', async () => {
    const task = await newTask();
    const user = await asking(task);
    for (const result of [
      await listTaskRuns({ user: ada() }),
      await getTaskRun({ user, runNumber: 'x' }),
      await getTaskRun({ user: { ...grace(), scheduledRun: user.scheduledRun }, runNumber: 1 }),
      await getTaskRun({ user, runNumber: 99 })
    ]) {
      assert.equal(integrationIssueOf('get_task_run', result), null, JSON.stringify(result));
    }
    await cleanup(ada());
  });

  it('a run that reads an earlier run which failed on a reconnect still succeeds', async () => {
    const task = await newTask();
    await earlierRun(task, 'fine');
    const failed = await earlierRun(task, null, { script: [] });
    await getScheduledTaskRepository().mutateRun(task.id, failed.id, document => ({
      ...document,
      reason: {
        code: 'INTEGRATION_RECONNECT_REQUIRED',
        message: 'Reconnect Jira: the connection is missing or has expired'
      }
    }));
    const queued = await tasks.requestRun(ada(), task.id);
    const chat = scriptedChatService(
      [
        toolCall('list_task_runs'),
        toolCall('get_task_run', { runNumber: 1 }, 'call_2'),
        openaiText(['Done.'])
      ],
      { runTool }
    );
    const run = await executeTaskRun({ taskId: task.id, runId: queued.id }, chat.deps);
    assert.equal(run.status, 'succeeded', JSON.stringify(run.reason));
    const toolReplies = chat.requests[2].body.messages.filter(message => message.role === 'tool');
    assert.equal(toolReplies.length, 2);
    assert.match(toolReplies[0].content, /Reconnect Jira/, 'the model does see what happened');
    assert.match(toolReplies[1].content, /"answer":\{"content":"fine"/);
    await cleanup(ada());
  });
});

describe('the pure parts', () => {
  const message = (role, runId, content, extra = {}) => ({
    id: `${role}-${runId}-${content}`,
    role,
    runId,
    content,
    ...extra
  });

  it('clipText says how much was cut', () => {
    assert.deepEqual(clipText('short', 10), { text: 'short', truncated: false });
    assert.deepEqual(clipText(null, 10), { text: '', truncated: false });
    const clipped = clipText('x'.repeat(30), 10);
    assert.equal(clipped.truncated, true);
    assert.equal(clipped.text, `${'x'.repeat(10)}\n[cut: 20 more characters]`);
  });

  it('projectRun keeps a run number only for runs that executed', () => {
    assert.equal(projectRun({ runNumber: null, status: 'skipped' }).runNumber, null);
    assert.equal(projectRun({ runNumber: 3, status: 'succeeded' }).runNumber, 3);
    assert.equal(
      projectRun({ runNumber: 3, chatId: 'c', startedAt: 't', chatDeleted: true }).hasChat,
      false
    );
    assert.equal(projectRun({ runNumber: 3, memory: { changed: false } }).changed, false);
    assert.equal(projectRun({ runNumber: 3, memory: { changed: null } }).changed, null);
  });

  it('pickRunMessages takes the last assistant message of the last ledger id', () => {
    const messages = [
      message('user', 'L1', 'instructions'),
      message('assistant', 'L1', 'prose before the tool call', { finishReason: 'clarification' }),
      message('user', 'L2', 'Approved by Ada'),
      message('assistant', 'L2', 'final answer', { finishReason: 'stop' }),
      message('user', 'F1', 'owner question'),
      message('assistant', 'F1', 'reply to owner')
    ];
    const picked = pickRunMessages(messages, { ledgerRunIds: ['L1', 'L2'] });
    assert.equal(picked.answer.content, 'final answer');
    assert.equal(picked.partial, false);
    assert.deepEqual([...picked.own].sort(), ['L1', 'L2']);
    assert.equal(picked.uncertain, false);
  });

  it('pickRunMessages falls back to an earlier execution and calls that partial', () => {
    const messages = [
      message('user', 'L1', 'instructions'),
      message('assistant', 'L1', 'only a clarification', { finishReason: 'clarification' }),
      message('user', 'L2', 'Approved by Ada')
    ];
    const picked = pickRunMessages(messages, { ledgerRunIds: ['L1', 'L2'] });
    assert.equal(picked.answer.content, 'only a clarification');
    assert.equal(picked.partial, true);
  });

  it('pickRunMessages ignores empty assistant messages and ones of other runs', () => {
    const messages = [
      message('user', 'L1', 'instructions'),
      message('assistant', 'L1', '   '),
      message('assistant', 'X', 'someone else')
    ];
    assert.equal(pickRunMessages(messages, { ledgerRunIds: ['L1'] }).answer, null);
  });

  it("pickRunMessages stands in the first message's id when there are no ledger ids", () => {
    const messages = [message('user', 'L9', 'instructions'), message('assistant', 'L9', 'answer')];
    const picked = pickRunMessages(messages, {});
    assert.equal(picked.answer.content, 'answer');
    assert.equal(picked.uncertain, true);
    assert.equal(pickRunMessages([], {}).answer, null);
    assert.equal(pickRunMessages([message('assistant', null, 'x')], {}).uncertain, false);
  });

  it('conversationWithin labels the run and what came after, and trims oldest first', () => {
    const messages = [
      message('user', 'L1', 'instructions'),
      message('assistant', 'L1', 'A'.repeat(10)),
      message('user', 'F1', 'B'.repeat(10)),
      message('assistant', 'F1', 'C'.repeat(10))
    ];
    const picked = pickRunMessages(messages, { ledgerRunIds: ['L1'] });
    const all = conversationWithin(messages, picked, 1000);
    assert.deepEqual(
      all.messages.map(entry => [entry.role, entry.from]),
      [
        ['assistant', 'run'],
        ['user', 'followup'],
        ['assistant', 'followup']
      ]
    );
    const trimmed = conversationWithin(messages, picked, 20);
    assert.deepEqual(
      trimmed.messages.map(entry => entry.content),
      ['A'.repeat(10), 'C'.repeat(10)].slice(0, 2)
    );
    assert.equal(trimmed.omitted, 1);
    const single = conversationWithin(messages, picked, 5);
    assert.equal(single.messages.length, 1);
    assert.equal(single.messages[0].content.startsWith('AAAAA'), true);
    assert.equal(single.truncated, true);
  });
});

describe('the apps the harness knows', () => {
  it('has the app these tests rely on', () => {
    assert.ok(APPS.some(app => app.id === 'digest'));
    assert.equal(DAILY.type, 'daily');
  });
});
