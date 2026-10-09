/**
 * `tryHandleMentionWorkflow` — the `@workflow` branch of the chat POST,
 * called directly instead of through the route handler.
 *
 * The end-to-end behaviour of a stored @mention turn (both halves written,
 * chat named after the question) is pinned by `chat-persistence-protocol.test.js`
 * against the real handler. This suite covers what that one cannot reach
 * cheaply: every way the mention is *not* started, and what each of them tells
 * the client — without Express and without persistence.
 */
import { after, afterEach, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';

import configCache from '../configCache.js';
import { clients } from '../sse.js';
import { observeEmittedEnvelopes } from '../services/loop/RunStream.js';
import { SSE_V2_EVENTS } from '../../shared/runEvents.js';
import { tryHandleMentionWorkflow } from '../services/workflow/mentionWorkflow.js';

const APP_ID = 'chat';
const WORKFLOW_ID = 'summarize-report';

/** Runnable from chat as far as the config goes; it fails to start (no nodes), which is all a test needs. */
const WORKFLOW = {
  id: WORKFLOW_ID,
  name: { en: 'Summarize report' },
  enabled: true,
  chatIntegration: { enabled: true },
  nodes: [],
  edges: []
};

const PERMITTED = { id: 'user-1', permissions: { workflows: new Set([WORKFLOW_ID]) } };
const NOT_PERMITTED = { id: 'user-2' };

const envelopes = [];
let stopObserving = null;
let chatSeq = 0;

function nextChatId() {
  chatSeq += 1;
  return `mention-chat-${chatSeq}`;
}

/**
 * Serve `workflow` and an app listing `appWorkflows` for the duration of `fn`.
 *
 * @param {Object} workflow - Workflow definition to serve.
 * @param {() => Promise<void>} fn - Test body.
 * @param {string[]} [appWorkflows] - The app's `workflows`.
 */
async function withConfig(workflow, fn, appWorkflows = [WORKFLOW_ID]) {
  configCache.setCacheEntry('config/workflows.json', [workflow]);
  configCache.setCacheEntry('config/apps.json', [{ id: APP_ID, workflows: appWorkflows }]);
  try {
    await fn();
  } finally {
    configCache.setCacheEntry('config/workflows.json', []);
    configCache.setCacheEntry('config/apps.json', []);
  }
}

/**
 * Mention the workflow in a message as `user` and return what the handler decided.
 *
 * @param {Object} params
 * @param {string} params.chatId - Chat id.
 * @param {string} [params.content] - The message.
 * @param {Object} [params.user] - Caller.
 * @returns {Promise<Object>}
 */
function mention({ chatId, content = `@${WORKFLOW_ID} Q3 numbers`, user = PERMITTED }) {
  const messages = [{ role: 'user', content, messageId: 'msg-1' }];
  return tryHandleMentionWorkflow({
    messages,
    conversation: messages,
    chatId,
    appId: APP_ID,
    messageId: 'msg-1',
    modelId: 'gpt-4o',
    user,
    clientLanguage: 'en',
    persistence: null
  });
}

/** Register a stream for `chatId`, as an open SSE connection would. */
function connectClient(chatId) {
  const response = {
    ended: false,
    write: () => true,
    end() {
      this.ended = true;
    }
  };
  clients.set(chatId, { response, lastActivity: new Date() });
}

async function waitFor(probe, what) {
  const deadline = Date.now() + 4000;
  while (Date.now() < deadline) {
    const value = probe();
    if (value) return value;
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  throw new Error(`Timed out waiting for ${what}`);
}

before(() => {
  stopObserving = observeEmittedEnvelopes(envelope => envelopes.push(envelope));
});

afterEach(() => {
  envelopes.length = 0;
  clients.clear();
});

after(() => {
  stopObserving?.();
  configCache.setCacheEntry('config/workflows.json', []);
  configCache.setCacheEntry('config/apps.json', []);
});

describe('tryHandleMentionWorkflow: leaves the message to the chat', () => {
  it('when the message mentions nobody', async () => {
    await withConfig(WORKFLOW, async () => {
      const result = await mention({ chatId: nextChatId(), content: 'summarize the report' });
      assert.deepEqual(result, { handled: false });
      assert.equal(envelopes.length, 0);
    });
  });

  it('when the mention names no workflow', async () => {
    await withConfig(WORKFLOW, async () => {
      const result = await mention({ chatId: nextChatId(), content: '@someone hello' });
      assert.deepEqual(result, { handled: false });
      assert.equal(envelopes.length, 0);
    });
  });

  it('when the caller may not run the workflow, without confirming that it exists', async () => {
    await withConfig(WORKFLOW, async () => {
      // Neither a refusal naming the workflow nor a stream frame: the mention
      // is ordinary text to this caller.
      connectClient('mention-chat-denied');
      const result = await mention({ chatId: 'mention-chat-denied', user: NOT_PERMITTED });
      assert.deepEqual(result, { handled: false });
      assert.equal(envelopes.length, 0);
    });
  });
});

describe('tryHandleMentionWorkflow: refuses a workflow that cannot run from this chat', () => {
  const cases = [
    {
      name: 'a disabled workflow',
      workflow: { ...WORKFLOW, enabled: false },
      appWorkflows: [WORKFLOW_ID],
      message: 'Workflow "Summarize report" is disabled.'
    },
    {
      name: 'a workflow without chat integration',
      workflow: { ...WORKFLOW, chatIntegration: { enabled: false } },
      appWorkflows: [WORKFLOW_ID],
      message:
        'Workflow "Summarize report" is not configured for chat (chatIntegration.enabled is false).'
    },
    {
      name: 'a workflow the app does not list',
      workflow: WORKFLOW,
      appWorkflows: [],
      message: 'Workflow "Summarize report" is not available in this app.'
    }
  ];

  for (const { name, workflow, appWorkflows, message } of cases) {
    it(`${name}: a 400 on the POST when no stream is open`, async () => {
      await withConfig(
        workflow,
        async () => {
          const result = await mention({ chatId: nextChatId() });
          assert.deepEqual(result, {
            handled: true,
            statusCode: 400,
            response: { status: 'error', message }
          });
          assert.equal(envelopes.length, 0, 'nothing is streamed to nobody');
        },
        appWorkflows
      );
    });

    it(`${name}: a failed run on the stream when one is open`, async () => {
      await withConfig(
        workflow,
        async () => {
          const chatId = nextChatId();
          connectClient(chatId);
          const result = await mention({ chatId });
          assert.deepEqual(result, { handled: true, response: { status: 'streaming', chatId } });

          assert.deepEqual(
            envelopes.map(entry => entry.type),
            [SSE_V2_EVENTS.RUN_STARTED, SSE_V2_EVENTS.STREAM_ERROR, SSE_V2_EVENTS.RUN_ENDED]
          );
          const [started, failed, ended] = envelopes;
          assert.equal(started.data.kind, 'workflow');
          assert.equal(started.data.refs.chatId, chatId);
          assert.equal(started.data.refs.messageId, 'msg-1');
          assert.equal(started.data.refs.workflowId, WORKFLOW_ID);
          assert.equal(failed.data.code, 'WORKFLOW_UNAVAILABLE');
          assert.equal(failed.data.message, message);
          assert.equal(ended.data.status, 'error');
        },
        appWorkflows
      );
    });
  }
});

describe('tryHandleMentionWorkflow: starts a runnable workflow', () => {
  it('answers at once and leaves the run to the stream', async () => {
    await withConfig(WORKFLOW, async () => {
      const chatId = nextChatId();
      connectClient(chatId);
      const result = await mention({ chatId });
      assert.deepEqual(result, { handled: true, response: { status: 'streaming', chatId } });

      // The run is announced under its own id before the workflow is launched...
      const started = envelopes.find(entry => entry.type === SSE_V2_EVENTS.RUN_STARTED);
      assert.ok(started, 'the run is announced');
      assert.equal(started.data.kind, 'workflow');
      assert.deepEqual(started.data.refs, {
        chatId,
        appId: APP_ID,
        messageId: 'msg-1',
        workflowId: WORKFLOW_ID
      });

      // ...and a workflow that cannot start ends it, or the chat's placeholder
      // would spin until the page is reloaded.
      const ended = await waitFor(
        () =>
          envelopes.find(
            entry => entry.type === SSE_V2_EVENTS.RUN_ENDED && entry.runId === started.runId
          ),
        'the failed launch to end the run'
      );
      assert.equal(ended.data.status, 'error');
    });
  });

  it('accepts a bare mention', async () => {
    await withConfig(WORKFLOW, async () => {
      const chatId = nextChatId();
      const result = await mention({ chatId, content: `@${WORKFLOW_ID}` });
      assert.deepEqual(result, { handled: true, response: { status: 'streaming', chatId } });
      await waitFor(
        () => envelopes.find(entry => entry.type === SSE_V2_EVENTS.RUN_ENDED),
        'the failed launch to end the run'
      );
    });
  });
});
