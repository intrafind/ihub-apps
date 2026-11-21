// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * A legacy workflow that waits for a person when its server is killed.
 *
 * The golden `legacy-workflow/delivered-after-restart` plays this restart
 * inside one process (`server/tests/golden/surfaces/legacyWorkflow.js`). Here
 * the process is real: a server runs the shipped workflow `approval-workflow`
 * from a chat until it asks its question, is killed with SIGKILL, and another
 * server is started on the same contents directory. The person finds the chat
 * waiting, answers, and reads the result in the chat.
 *
 * The legacy engine is frozen (`workflow-legacy-frozen.test.js`); this test
 * pins what it does and places no kill point in it. The server is killed from
 * outside, once it has stored that the execution waits.
 */
import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { CASE_TIMEOUT_MS, MODELS, SETUP_TIMEOUT_MS, startStack, until } from './harness.mjs';

/**
 * A chat whose turn claimed it less than two minutes ago is presumed alive
 * (`INTERRUPTED_RUN_GRACE_MS`, `server/services/chat/chatRecovery.js`). The
 * person comes back later than that: the second server runs with its clock
 * three minutes ahead.
 */
const LATER_MS = 3 * 60 * 1000;

const WORKFLOW = 'approval-workflow';
const DESK = {
  id: 'desk',
  order: 3,
  name: { en: 'Desk', de: 'Schreibtisch' },
  description: {
    en: 'Starts a workflow from a chat, for the fault tests.',
    de: 'Startet einen Workflow aus einem Chat, für die Fehlertests.'
  },
  color: '#0F766E',
  icon: 'chat-bubbles',
  system: { en: 'You are a helpful assistant.', de: 'Sie sind ein hilfreicher Assistent.' },
  preferredModel: MODELS.default,
  preferredOutputFormat: 'markdown',
  sendChatHistory: true,
  workflows: [WORKFLOW],
  enabled: true
};

describe('a legacy workflow waits for a person when its server is killed', () => {
  /** @type {Awaited<ReturnType<typeof startStack>>} */
  let stack;

  before(
    async () => {
      stack = await startStack({
        seed: {
          features: { workflows: true },
          // The shipped workflow, offered to chats as an admin offers it, on the stub model.
          workflows: {
            [WORKFLOW]: {
              chatIntegration: { enabled: true, outputFormat: 'markdown' },
              config: { defaultModelId: MODELS.default }
            }
          },
          apps: [DESK]
        }
      });
    },
    { timeout: SETUP_TIMEOUT_MS }
  );
  after(async () => {
    await stack?.stop();
  });

  test(
    'after the restart the chat says that it waits, the person answers, and the result is in the chat',
    { timeout: CASE_TIMEOUT_MS },
    async () => {
      const api = await stack.api();
      const chatId = 'fault-legacy-waiting';
      const chatPath = `/api/apps/${DESK.id}/chat/${chatId}`;

      // The browser holds the stream of the chat and posts the mention.
      const stream = await api.stream('GET', chatPath);
      await stream.until(frame => frame.type === 'stream/connected', 'stream/connected');
      const posted = await api.post(chatPath, {
        messages: [{ role: 'user', messageId: 'msg-1', content: `@${WORKFLOW} Record keeping` }],
        modelId: MODELS.default,
        language: 'en'
      });
      assert.equal(posted.status, 200);
      const paused = await stream.until(frame => frame.type === 'run/paused', 'run/paused');
      const runId = paused.runId;
      const interactionId = paused.data.interactionId;
      assert.equal(paused.data.reason, 'interaction');

      // Kill only once the disk says what the stream said: the server writes its
      // execution record and its events a moment after it sends the frame.
      await until(() => stack.stored('runs', runId)?.status === 'paused', {
        what: 'the stored execution to be paused',
        timeoutMs: CASE_TIMEOUT_MS
      });
      const before = (await stack.readLedger(runId, api)).body.items;
      assert.equal(before.at(-1).type, 'run/paused');
      await until(() => stack.journal(runId).some(event => event.type === 'run/paused'), {
        what: 'the events of the run to be on disk',
        timeoutMs: CASE_TIMEOUT_MS
      });
      const lastSeqBeforeRestart = before.at(-1).seq;
      const killedAt = Date.now();

      await stack.kill('SIGKILL');
      assert.ok((await stream.done).error, 'the stream of the chat broke when the server died');

      await stack.restart({ clockAheadMs: LATER_MS });

      // The question outlived the server.
      const pending = await api.get('/api/interactions/pending');
      assert.deepEqual(
        pending.body.items.map(item => ({ id: item.id, status: item.status })),
        [{ id: interactionId, status: 'pending' }]
      );

      // The first read closes the turn of the dead server: the chat waits for the person.
      const firstRead = await stack.readChat(chatId, api);
      assert.equal(firstRead.status, 200);
      assert.equal(firstRead.body.chat.activeRunId, null);
      assert.deepEqual(
        firstRead.body.messages.map(message => [message.role, message.finishReason ?? null]),
        [
          ['user', null],
          ['assistant', 'paused']
        ]
      );
      const waiting = firstRead.body.messages[1];
      assert.equal(waiting.activity.workflowResult.status, 'paused');
      assert.equal(waiting.activity.workflowResult.executionId, runId);

      // The person answers on the page of the execution.
      const answered = await api.post(`/api/runs/${runId}/interactions/${interactionId}/answer`, {
        value: 'approve',
        data: { feedback: 'Keep it short.' }
      });
      assert.equal(answered.status, 200, answered.text);
      assert.equal(answered.body.status, 'answered');
      await until(() => stack.stored('runs', runId)?.status === 'completed', {
        what: 'the execution to end',
        timeoutMs: CASE_TIMEOUT_MS,
        detail: () => stack.logTail()
      });

      // The next read puts the result into the chat, in the place of the waiting answer.
      const secondRead = await stack.readChat(chatId, api);
      assert.equal(secondRead.body.messages.length, 2);
      const result = secondRead.body.messages[1];
      assert.equal(result.role, 'assistant');
      assert.equal(result.finishReason, 'stop');
      assert.equal(result.activity.workflowResult.status, 'completed');
      assert.notEqual(result.id, waiting.id, 'the waiting answer was replaced');
      assert.match(result.content, /Create a concise summary/);
      assert.match(result.content, /User feedback: Keep it short\./);
      // A third read finds nothing left to deliver.
      const thirdRead = await stack.readChat(chatId, api);
      assert.deepEqual(thirdRead.body.messages, secondRead.body.messages);

      // Each step asked the model once: the research before the kill, the summary
      // after the answer. The restart repeated nothing.
      const requests = await stack.stub.requests('Record keeping');
      assert.equal(requests.length, 2);

      // KNOWN DEFECT, pinned and not fixed here (#3875): when an answer continues an
      // execution that the answering server did not start, the legacy engine does not
      // take up the sequence of the run ledger. The events after the restart count
      // from 1 again, so the ledger of the run holds each of these numbers twice.
      // With the fix the first number after the restart is `lastSeqBeforeRestart + 1`.
      const ledger = (await stack.readLedger(runId, api)).body.items;
      const afterRestart = ledger.filter(event => Date.parse(event.ts) > killedAt);
      assert.ok(afterRestart.some(event => event.type === 'run/end'));
      assert.equal(lastSeqBeforeRestart, 7);
      assert.equal(Math.min(...afterRestart.map(event => event.seq)), 1);
      assert.equal(ledger.filter(event => event.seq === 1).length, 2);
    }
  );
});
