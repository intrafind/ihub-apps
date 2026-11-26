// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * A question an MCP server asks mid-call is answered through the real answer
 * path — InteractionService with the startup hooks registered (workflow
 * checkpoint resume, chat clarification lifecycle) — and neither hook takes
 * it for its own.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { startTestStorage } from '../helpers/testStorage.js';
import { RunLog } from '../../services/loop/RunLog.js';
import { InteractionService } from '../../services/loop/InteractionService.js';
import { registerCheckpointResume } from '../../services/workflow/checkpointResume.js';
import { registerChatClarificationLifecycle } from '../../services/chat/chatClarificationLifecycle.js';
import { setEnvelopeDelivery } from '../../services/loop/RunStream.js';
import {
  createElicitationHandler,
  runWithElicitationScope
} from '../../services/mcp/mcpElicitation.js';

const user = { id: 'alice', groups: ['users'] };

/** A workflow engine that must not be touched: no execution waits on these questions. */
const untouchedEngine = new Proxy(
  {},
  {
    get: (_target, name) => () => {
      throw new Error(`the workflow engine was asked to ${String(name)}`);
    }
  }
);

async function setup() {
  await startTestStorage({ prefix: 'mcp-elicitation-answer-' });
  const runLog = new RunLog({ forceEnabled: true, getPlatformConfig: () => ({}) });
  const svc = new InteractionService({ runLog });
  const unregister = [
    registerCheckpointResume(svc, { engine: untouchedEngine, runLog }),
    registerChatClarificationLifecycle(svc, { runLog })
  ];
  setEnvelopeDelivery(() => {});
  const handler = createElicitationHandler({
    serverId: 'billing',
    serverName: 'Billing',
    interactionService: svc,
    runLog,
    getStreamRun: () => ({ runId: 'chat-parent' })
  });
  const ask = request =>
    runWithElicitationScope({ chatId: 'chat-1', user, toolId: 'billing__pay' }, () =>
      handler(request)
    );
  const pendingQuestion = async () => {
    for (let i = 0; i < 100; i++) {
      const [question] = await svc.listPending({ chatId: 'chat-1' });
      if (question) return question;
      await new Promise(resolve => setTimeout(resolve, 10));
    }
    throw new Error('no question was raised');
  };
  const teardown = () => {
    unregister.forEach(fn => fn());
    setEnvelopeDelivery(null);
  };
  return { svc, ask, pendingQuestion, teardown };
}

const FORM = {
  params: {
    message: 'Name the project',
    requestedSchema: {
      type: 'object',
      properties: { name: { type: 'string' } },
      required: ['name']
    }
  }
};

test('Submit reaches the server through the real answer path', async () => {
  const { svc, ask, pendingQuestion, teardown } = await setup();
  try {
    const result = ask(FORM);
    const question = await pendingQuestion();
    const answered = await svc.answer(
      question.id,
      { value: 'accept', data: { name: 'Billing' } },
      { user, channel: 'chat' }
    );
    assert.equal(answered.status, 'answered');
    assert.deepEqual(await result, { action: 'accept', content: { name: 'Billing' } });
  } finally {
    teardown();
  }
});

test('Decline and Done on a page reach the server the same way', async () => {
  const { svc, ask, pendingQuestion, teardown } = await setup();
  try {
    const declined = ask(FORM);
    await svc.answer((await pendingQuestion()).id, { skipped: true }, { user, channel: 'chat' });
    assert.deepEqual(await declined, { action: 'decline' });

    const page = ask({
      params: { mode: 'url', message: 'Sign in', url: 'https://billing.example.com/sign-in' }
    });
    await svc.answer((await pendingQuestion()).id, { value: 'accept' }, { user, channel: 'chat' });
    assert.deepEqual(await page, { action: 'accept' });
  } finally {
    teardown();
  }
});

test('an expired question touches no workflow execution', async () => {
  const { svc, ask, pendingQuestion, teardown } = await setup();
  try {
    const result = ask(FORM);
    const question = await pendingQuestion();
    // The expiry listener would cancel an execution through the engine,
    // which throws here if it is asked.
    await svc.expire(question.id);
    assert.deepEqual(await result, { action: 'cancel' });
  } finally {
    teardown();
  }
});
