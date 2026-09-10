/**
 * The POST protocol of a durable chat, driven through the real route handler.
 *
 * Contract §7 moves the source of truth for a conversation from the client to
 * the server: a persisted chat posts exactly one message and the server reads
 * the rest back out of the store. That is the single most important claim of
 * the feature, and it lives entirely in `sessionRoutes.js` — the policy
 * helpers it branches on can all be perfect while the handler ignores them.
 * So this suite registers the real routes and calls the real handler.
 *
 * The route chain is driven from `validate()` onwards; the authentication
 * middleware in front of it needs a booted auth configuration and has its own
 * suite (`authentication-security.test.js`), so `req.user` is injected here
 * the way that middleware would have left it. Everything below the handler is
 * real: a filesystem storage provider over `mkdtemp`, the real repository, the
 * real validator. `prepareChatRequest` is the one seam — it is stubbed to fail
 * so no model is ever called, and it doubles as the probe for what the handler
 * decided the conversation was.
 *
 * Contract: `CHAT_PERSISTENCE_CONTRACT.md` §7 and §12.
 */
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';

import configCache from '../configCache.js';
import { bootstrapStorage, shutdownStorageBootstrap } from '../storage/bootstrap.js';
import { getChatRepository } from '../services/chat/ChatRepository.js';
import ChatService from '../services/chat/ChatService.js';
import { RunLog } from '../services/loop/RunLog.js';
import {
  abortChatRequest,
  activeRequests,
  clearChatDurable,
  clients,
  hasActiveChatRequest,
  markChatDurable
} from '../sse.js';
import registerSessionRoutes, {
  messageAttachments,
  workflowSummary
} from '../routes/chat/sessionRoutes.js';

const USER = { id: 'user-1', name: 'Ada' };
const APP_ID = 'chat';

/** A workflow the @mention branch will accept and then fail to start. */
const BROKEN_WORKFLOW = {
  id: 'summarize-report',
  name: { en: 'Summarize report' },
  enabled: true,
  chatIntegration: { enabled: true },
  // No nodes means no start node, which `WorkflowEngine.start` rejects
  // synchronously — a launch failure with no model call and no waiting.
  nodes: [],
  edges: []
};

let baseDir;

/**
 * Every route `registerSessionRoutes` registers.
 *
 * It only ever calls `app.<method>(path, ...handlers)`, so a recorder is
 * enough to get at the real handlers without an HTTP server — and without the
 * socket plumbing an SSE route would otherwise need.
 *
 * @returns {Array<{method: string, routePath: string, handlers: Function[]}>}
 */
function captureRoutes() {
  const routes = [];
  const record =
    method =>
    (routePath, ...handlers) =>
      routes.push({ method, routePath, handlers });
  const app = {
    get: record('get'),
    post: record('post'),
    put: record('put'),
    patch: record('patch'),
    delete: record('delete'),
    use: () => {}
  };
  registerSessionRoutes(app, {
    getLocalizedError: async code => `localized:${code}`,
    DEFAULT_TIMEOUT: 5000
  });
  return routes;
}

const routes = captureRoutes();

/**
 * The handler chain of one registered route.
 *
 * @param {string} method - HTTP method.
 * @param {string} suffix - Path suffix, without the deployment base path.
 * @returns {Function[]}
 */
function handlersFor(method, suffix) {
  const route = routes.find(entry => entry.method === method && entry.routePath.endsWith(suffix));
  assert.ok(route, `${method.toUpperCase()} ${suffix} must be registered`);
  return route.handlers;
}

const chatPostHandlers = handlersFor('post', '/api/apps/:appId/chat/:chatId');
const chatStopHandlers = handlersFor('post', '/api/apps/:appId/chat/:chatId/stop');

/**
 * A response double that records what the handler answered.
 *
 * @returns {Object}
 */
function makeResponse() {
  const res = { statusCode: 200, body: null, headersSent: false, frames: [] };
  res.status = code => {
    res.statusCode = code;
    return res;
  };
  res.json = value => {
    res.body = value;
    return res;
  };
  res.setHeader = () => res;
  res.flushHeaders = () => res;
  res.write = chunk => {
    res.frames.push(String(chunk));
    return true;
  };
  res.end = () => res;
  return res;
}

/**
 * POST a chat message through the real handler chain.
 *
 * @param {Object} params
 * @param {string} params.chatId - Chat id in the path.
 * @param {Object} params.body - Request body, before validation.
 * @param {Object} [params.user] - Authenticated caller.
 * @returns {Promise<Object>} The response double.
 */
async function postChat({ chatId, body, user = USER }) {
  return drive(chatPostHandlers, { chatId, body, user });
}

/**
 * Drive a captured handler chain, skipping the authentication middleware at
 * its head.
 *
 * @param {Function[]} handlers - Chain as registered.
 * @param {Object} params
 * @param {string} params.chatId - Chat id in the path.
 * @param {Object} [params.body] - Request body, before validation.
 * @param {Object} params.user - Authenticated caller.
 * @returns {Promise<Object>} The response double.
 */
async function drive(handlers, { chatId, body = {}, user }) {
  const req = { params: { appId: APP_ID, chatId }, body, headers: {}, query: {}, user };
  const res = makeResponse();
  for (let index = 1; index < handlers.length; index += 1) {
    let advanced = false;
    await handlers[index](req, res, () => {
      advanced = true;
    });
    if (index < handlers.length - 1 && !advanced) break;
  }
  return res;
}

/**
 * Run `fn` with `prepareChatRequest` replaced by a recorder that refuses the
 * turn, so the handler stops one step short of calling a model.
 *
 * @param {(calls: Object[]) => Promise<void>} fn - Test body; receives the
 *   arguments the handler passed, one entry per call.
 * @returns {Promise<void>}
 */
async function withPreparedRequests(fn) {
  const original = ChatService.prototype.prepareChatRequest;
  const calls = [];
  ChatService.prototype.prepareChatRequest = async params => {
    calls.push(params);
    return { success: false, error: { code: 'APP_NOT_FOUND' } };
  };
  try {
    await fn(calls);
  } finally {
    ChatService.prototype.prepareChatRequest = original;
  }
}

/**
 * Run `fn` with `runTurn` replaced by a recorder, so a test can assert what
 * the *route* resolved without running a model.
 *
 * `withPreparedRequests` stops one step earlier — at `prepareChatRequest` —
 * which is why it cannot see anything the route computes for the store.
 *
 * @param {(calls: Object[]) => Promise<void>} fn - Test body; receives one
 *   entry per `runTurn` call.
 * @returns {Promise<void>}
 */
async function withRecordedTurns(fn) {
  const originalPrepare = ChatService.prototype.prepareChatRequest;
  const originalRun = ChatService.prototype.runTurn;
  const calls = [];
  ChatService.prototype.prepareChatRequest = async () => ({
    success: true,
    data: {
      app: { id: APP_ID },
      model: { id: 'gpt-4o' },
      llmMessages: [{ role: 'user', content: 'x' }],
      tools: []
    }
  });
  ChatService.prototype.runTurn = async params => {
    calls.push(params);
    return { status: 'success', content: '', finishReason: 'stop' };
  };
  try {
    await fn(calls);
  } finally {
    ChatService.prototype.prepareChatRequest = originalPrepare;
    ChatService.prototype.runTurn = originalRun;
  }
}

/**
 * Replace the cached feature flags for the duration of `fn`.
 *
 * @param {Object} features - Feature flags to serve.
 * @param {() => Promise<void>} fn - Test body.
 * @returns {Promise<void>}
 */
async function withFeatures(features, fn) {
  configCache.setCacheEntry('config/features.json', features);
  try {
    await fn();
  } finally {
    configCache.setCacheEntry('config/features.json', { chatPersistence: true });
  }
}

/**
 * Register a local SSE client for `chatId` so the handler takes its streaming
 * branch, and drop it again afterwards.
 *
 * @param {string} chatId - Chat id.
 * @param {() => Promise<void>} fn - Test body.
 * @returns {Promise<void>}
 */
async function withStreamingClient(chatId, fn) {
  clients.set(chatId, { response: makeResponse(), lastActivity: new Date() });
  try {
    await fn();
  } finally {
    clients.delete(chatId);
  }
}

/**
 * Seed a stored chat owned by `USER` with a finished exchange in it.
 *
 * @param {string} chatId - Chat id.
 * @returns {Promise<{messages: Object[]}>} The stored transcript.
 */
async function seedChat(chatId) {
  const repository = getChatRepository();
  await repository.ensureChat({ chatId, ownerId: USER.id, identityMode: 'default' });
  await repository.appendMessage(chatId, {
    role: 'user',
    content: 'what is the retention default?',
    runId: 'chat-run-1'
  });
  await repository.appendMessage(chatId, {
    role: 'assistant',
    content: 'ninety days',
    runId: 'chat-run-1'
  });
  return repository.getMessages(chatId);
}

/**
 * Poll `probe` until it returns something truthy.
 *
 * @param {() => Promise<*>} probe - Condition to evaluate.
 * @param {string} what - What is being waited for, for the failure message.
 * @returns {Promise<*>} The first truthy value.
 */
async function waitFor(probe, what) {
  const deadline = Date.now() + 4000;
  while (Date.now() < deadline) {
    const value = await probe();
    if (value) return value;
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  throw new Error(`Timed out waiting for ${what}`);
}

before(async () => {
  baseDir = await fs.mkdtemp(path.join(os.tmpdir(), 'ihub-chat-protocol-'));
  await bootstrapStorage({
    storage: { provider: 'filesystem', filesystem: { baseDir, flushIntervalMs: 25 } }
  });
  configCache.setCacheEntry('config/features.json', { chatPersistence: true });
  configCache.setCacheEntry('config/platform.json', { chats: { enabled: true } });
  configCache.setCacheEntry('config/workflows.json', [BROKEN_WORKFLOW]);
});

after(async () => {
  await shutdownStorageBootstrap();
  await fs.rm(baseDir, { recursive: true, force: true });
});

describe('POST /api/apps/:appId/chat/:chatId: the server owns the history', () => {
  it('refuses a client-supplied history when the turn is persisted', async () => {
    await withPreparedRequests(async calls => {
      const res = await postChat({
        chatId: 'chat-refuse-history',
        body: {
          messages: [
            { role: 'user', content: 'a turn the client made up' },
            { role: 'user', content: 'the new message' }
          ]
        }
      });

      assert.equal(res.statusCode, 400);
      assert.deepEqual(res.body, { error: 'CLIENT_HISTORY_NOT_ALLOWED' });
      assert.equal(calls.length, 0, 'nothing reached the request builder');
    });
  });

  it('still accepts a full array when persistence is off', async () => {
    // The dual mode is permanent by design: anonymous callers, ephemeral turns
    // and installations with the feature off keep posting their whole array.
    await withFeatures({ chatPersistence: false }, async () => {
      await withPreparedRequests(async calls => {
        const res = await postChat({
          chatId: 'chat-flag-off',
          body: {
            messages: [
              { role: 'user', content: 'first' },
              { role: 'user', content: 'second' }
            ]
          }
        });

        assert.notEqual(res.statusCode, 400);
        assert.equal(calls.length, 1);
        assert.deepEqual(
          calls[0].messages.map(entry => entry.content),
          ['first', 'second'],
          'the client array is the conversation when nothing is stored'
        );
      });
    });
  });

  it('accepts a full array from an ephemeral turn', async () => {
    await withPreparedRequests(async calls => {
      const res = await postChat({
        chatId: 'chat-ephemeral',
        body: {
          ephemeral: true,
          messages: [
            { role: 'user', content: 'first' },
            { role: 'user', content: 'second' }
          ]
        }
      });

      assert.notEqual(res.statusCode, 400);
      assert.equal(calls.length, 1);
    });
  });

  it('hands the model the stored transcript, not just the posted message', async () => {
    const chatId = 'chat-assembled';
    await seedChat(chatId);

    await withPreparedRequests(async calls => {
      await postChat({
        chatId,
        body: { messages: [{ role: 'user', content: 'and the maximum per user?' }] }
      });

      assert.equal(calls.length, 1);
      assert.deepEqual(calls[0].messages, [
        { role: 'user', content: 'what is the retention default?' },
        { role: 'assistant', content: 'ninety days' },
        { role: 'user', content: 'and the maximum per user?' }
      ]);
    });
  });

  it('assembles the same history on the streaming path', async () => {
    // Both branches of the handler build their own `prepareChatRequest` call;
    // the substitution has to be on each of them.
    const chatId = 'chat-assembled-streaming';
    await seedChat(chatId);

    await withStreamingClient(chatId, async () => {
      await withPreparedRequests(async calls => {
        await postChat({
          chatId,
          body: { messages: [{ role: 'user', content: 'streamed follow-up' }] }
        });

        assert.equal(calls.length, 1);
        assert.deepEqual(
          calls[0].messages.map(entry => entry.content),
          ['what is the retention default?', 'ninety days', 'streamed follow-up']
        );
      });
    });
  });

  it('truncates the stored history at replaceFromMessageId before appending', async () => {
    const chatId = 'chat-fork';
    const { messages } = await seedChat(chatId);

    await withPreparedRequests(async calls => {
      await postChat({
        chatId,
        body: {
          replaceFromMessageId: messages[1].id,
          messages: [{ role: 'user', content: 'let me rephrase' }]
        }
      });

      assert.deepEqual(
        calls[0].messages.map(entry => entry.content),
        ['what is the retention default?', 'let me rephrase'],
        'the forked-off answer is gone from the prompt'
      );
    });
  });

  it('forks at the client exchange id a same-session turn was stored under', async () => {
    // A turn made in the session that is still open never learns the id the
    // store minted for it — nothing on the stream reports it. What it does
    // know is the exchange id it sent, which the store kept as
    // `clientMessageId`, so an edit or a regenerate of that turn addresses the
    // history by that. Without this the fork id would be absent and the retry
    // would be appended to the untouched history, duplicating the exchange.
    const chatId = 'chat-fork-client-id';
    const repository = getChatRepository();
    await repository.ensureChat({ chatId, ownerId: USER.id, identityMode: 'default' });
    await repository.appendMessage(chatId, {
      role: 'user',
      content: 'what is the retention default?',
      runId: 'chat-run-1',
      clientMessageId: 'msg-1700000000000-1'
    });
    await repository.appendMessage(chatId, {
      role: 'assistant',
      content: 'ninety days',
      runId: 'chat-run-1'
    });

    await withPreparedRequests(async calls => {
      const res = await postChat({
        chatId,
        body: {
          replaceFromMessageId: 'msg-1700000000000-1',
          messages: [{ role: 'user', content: 'let me rephrase' }]
        }
      });

      assert.notEqual(res.statusCode, 400);
      assert.deepEqual(
        calls[0].messages.map(entry => entry.content),
        ['let me rephrase'],
        'the forked-off exchange is gone from the prompt, not duplicated'
      );
    });
  });

  it('resolves the fork point to the stored id before handing it to the store', async () => {
    // The regression guard for the route half. The store matches on `id`
    // alone, so a client exchange id forwarded verbatim forks the prompt and
    // not the transcript — silently, because `materializeUserTurn` swallows
    // the UNKNOWN_MESSAGE it gets back.
    const chatId = 'chat-fork-resolves-id';
    const repository = getChatRepository();
    await repository.ensureChat({ chatId, ownerId: USER.id, identityMode: 'default' });
    await repository.appendMessage(chatId, {
      role: 'user',
      content: 'what is the retention default?',
      runId: 'chat-run-1',
      clientMessageId: 'msg-1700000000000-1'
    });
    await repository.appendMessage(chatId, {
      role: 'assistant',
      content: 'ninety days',
      runId: 'chat-run-1'
    });
    const storedUserId = (await repository.getMessages(chatId)).messages[0].id;
    assert.notEqual(storedUserId, 'msg-1700000000000-1', 'the two ids really do differ');

    await withRecordedTurns(async calls => {
      await withStreamingClient(chatId, async () => {
        await postChat({
          chatId,
          body: {
            replaceFromMessageId: 'msg-1700000000000-1',
            messages: [{ role: 'user', content: 'let me rephrase' }]
          }
        });
      });

      assert.equal(calls.length, 1, 'the turn ran');
      assert.equal(
        calls[0].persistence?.replaceFromMessageId,
        storedUserId,
        'the store is handed the id it can actually match on'
      );
    });
  });

  it('forking by client exchange id truncates the stored transcript, not just the prompt', async () => {
    // The route resolves the fork point against both the stored id and the
    // client exchange id, but the store matches on `id` alone. Forwarding the
    // client's value forked the prompt and left the transcript intact:
    // `appendMessage` threw UNKNOWN_MESSAGE, `materializeUserTurn` logged and
    // returned null, and the answer landed at the end of an untruncated
    // history — so the replaced exchange survived and, for an edit, the
    // edited question was never stored at all.
    //
    // The tests above stub `prepareChatRequest` to fail, so they stop before
    // the store is ever touched. This one drives the turn to completion and
    // asserts the transcript.
    const chatId = 'chat-fork-stored-transcript';
    const repository = getChatRepository();
    await repository.ensureChat({ chatId, ownerId: USER.id, identityMode: 'default' });
    await repository.appendMessage(chatId, {
      role: 'user',
      content: 'what is the retention default?',
      runId: 'chat-run-1',
      clientMessageId: 'msg-1700000000000-1'
    });
    await repository.appendMessage(chatId, {
      role: 'assistant',
      content: 'ninety days',
      runId: 'chat-run-1'
    });

    const runLog = new RunLog({
      baseDir: path.join(baseDir, 'fork-run-log'),
      forceEnabled: false,
      getPlatformConfig: () => ({})
    });
    const service = new ChatService({
      agentLoop: {
        run: async () => ({
          status: 'success',
          content: 'ninety days, regenerated',
          finishReason: 'stop',
          messages: []
        })
      },
      runLog,
      logInteraction: async () => {},
      telemetry: { recordChatCallStart: async () => {}, recordChatCallEnd: async () => {} }
    });

    try {
      await service.runTurn({
        prep: {
          app: { id: APP_ID },
          model: { id: 'gpt-4o' },
          llmMessages: [{ role: 'user', content: 'let me rephrase' }],
          tools: []
        },
        chatId,
        messageId: 'msg-1700000000000-2',
        streaming: false,
        buildLogData: () => ({}),
        getLocalizedError: async code => code,
        user: USER,
        persistence: {
          repository,
          ownerId: USER.id,
          identityMode: 'default',
          content: 'let me rephrase',
          clientMessageId: 'msg-1700000000000-2',
          attachments: [],
          // What the route now resolves and forwards: the *stored* id of the
          // message the client addressed by its exchange id.
          replaceFromMessageId: (await repository.getMessages(chatId)).messages[0].id
        }
      });
    } finally {
      await runLog.stop();
      activeRequests.delete(chatId);
    }

    const { messages } = await repository.getMessages(chatId);
    assert.deepEqual(
      messages.map(m => [m.role, m.content]),
      [
        ['user', 'let me rephrase'],
        ['assistant', 'ninety days, regenerated']
      ],
      'the replaced exchange is gone from the store and the new question is in it'
    );
  });

  it('honours the caller opting out of chat history for one turn', async () => {
    // With the client posting exactly one message either way, this field is
    // the only channel the viewer's "Include chat history in requests" toggle
    // has left; truncating the array no longer says anything.
    const chatId = 'chat-no-history';
    await seedChat(chatId);

    await withPreparedRequests(async calls => {
      await postChat({
        chatId,
        body: { sendChatHistory: false, messages: [{ role: 'user', content: 'standalone' }] }
      });

      assert.deepEqual(
        calls[0].messages.map(entry => entry.content),
        ['standalone']
      );
    });
  });

  it('still assembles the stored transcript when the caller says nothing', async () => {
    const chatId = 'chat-history-default';
    await seedChat(chatId);

    await withPreparedRequests(async calls => {
      await postChat({
        chatId,
        body: { sendChatHistory: true, messages: [{ role: 'user', content: 'follow-up' }] }
      });

      assert.deepEqual(
        calls[0].messages.map(entry => entry.content),
        ['what is the retention default?', 'ninety days', 'follow-up']
      );
    });
  });

  it('rejects an unknown replaceFromMessageId instead of replaying everything', async () => {
    const chatId = 'chat-fork-unknown';
    await seedChat(chatId);

    await withPreparedRequests(async calls => {
      const res = await postChat({
        chatId,
        body: {
          replaceFromMessageId: 'msg-that-was-never-stored',
          messages: [{ role: 'user', content: 'rephrased' }]
        }
      });

      assert.equal(res.statusCode, 400);
      assert.deepEqual(res.body, { error: 'UNKNOWN_MESSAGE' });
      assert.equal(calls.length, 0);
    });
  });

  it('answers 404 for a chat that belongs to someone else', async () => {
    const chatId = 'chat-someone-elses';
    await seedChat(chatId);

    await withPreparedRequests(async calls => {
      const res = await postChat({
        chatId,
        body: { messages: [{ role: 'user', content: 'let me in' }] },
        user: { id: 'user-2' }
      });

      assert.equal(res.statusCode, 404);
      assert.equal(calls.length, 0);
    });
  });
});

describe('POST: an @mention workflow turn is a turn', () => {
  it('stores both halves of a workflow exchange', async () => {
    const chatId = 'chat-workflow';
    const repository = getChatRepository();

    const res = await postChat({
      chatId,
      body: { messages: [{ role: 'user', content: '@summarize-report Q3 numbers' }] }
    });
    // The launch is fire-and-forget, so the POST answers before the workflow
    // has failed to start; the store is what has to catch up.
    assert.deepEqual(res.body, { status: 'streaming', chatId });

    // The user half is written before the launch, the assistant half when the
    // run settles — without either, the exchange the user just had would be
    // missing from the transcript and from every later prompt.
    const stored = await waitFor(async () => {
      const { messages } = await repository.getMessages(chatId);
      return messages.length === 2 ? messages : null;
    }, 'the workflow turn to be materialized');

    assert.deepEqual(
      stored.map(entry => entry.role),
      ['user', 'assistant']
    );
    assert.equal(stored[0].content, '@summarize-report Q3 numbers');
    assert.equal(stored[1].error.code, 'WORKFLOW_FAILED');
    assert.equal(stored[0].runId, stored[1].runId, 'both halves belong to the workflow run');

    const chat = await waitFor(async () => {
      const current = await repository.getChat(chatId);
      return current && current.activeRunId === null ? current : null;
    }, 'the chat to be released');
    assert.equal(chat.status, 'error');
    assert.equal(chat.title, '@summarize-report Q3 numbers');
    assert.equal(chat.messageCount, 2);
  });

  it('maps what a workflow resolved with onto a turn outcome', () => {
    assert.deepEqual(workflowSummary({ status: 'completed', outputText: 'the summary' }), {
      status: 'success',
      content: 'the summary',
      finishReason: 'stop'
    });
    assert.deepEqual(
      workflowSummary({ status: 'cancelled', outputText: 'Workflow cancelled: stopped' }),
      { status: 'aborted', content: 'Workflow cancelled: stopped', finishReason: 'cancelled' }
    );
    const failed = workflowSummary({ status: 'failed', error: 'node blew up' });
    assert.equal(failed.status, 'error');
    assert.deepEqual(failed.errorInfo, { code: 'WORKFLOW_FAILED', message: 'node blew up' });
  });
});

describe('Stop reaches a durable turn that never streamed', () => {
  it('registers the abort controller of a persisted non-streaming turn', async () => {
    // Such a turn is started by a caller with no SSE stream — an integration,
    // or a client whose stream has not come up yet. Left out of
    // `activeRequests` it is the one turn Stop can never reach: the endpoint
    // answers "stopped" while the model runs on and bills the tokens.
    const chatId = 'chat-durable-nostream';
    const repository = getChatRepository();
    const runLog = new RunLog({
      baseDir: path.join(baseDir, 'stop-run-log'),
      forceEnabled: false,
      getPlatformConfig: () => ({})
    });
    const observed = [];
    const agentLoop = {
      run: async ({ signal }) => {
        // Exactly what the stop endpoint does, while the turn is in flight.
        const tracked = hasActiveChatRequest(chatId);
        const stopped = abortChatRequest(chatId);
        observed.push({ tracked, stopped, reachedTheTurn: signal.aborted });
        return { status: 'aborted', content: '', finishReason: 'aborted', messages: [] };
      }
    };
    const service = new ChatService({
      agentLoop,
      runLog,
      logInteraction: async () => {},
      telemetry: { recordChatCallStart: async () => {}, recordChatCallEnd: async () => {} }
    });

    try {
      await service.runTurn({
        prep: {
          app: { id: APP_ID },
          model: { id: 'gpt-4o' },
          llmMessages: [{ role: 'user', content: 'slow question' }],
          tools: []
        },
        chatId,
        messageId: 'msg-durable',
        streaming: false,
        buildLogData: () => ({}),
        getLocalizedError: async code => code,
        user: USER,
        persistence: {
          repository,
          ownerId: USER.id,
          identityMode: 'default',
          content: 'slow question',
          clientMessageId: 'msg-durable',
          attachments: [],
          replaceFromMessageId: null
        }
      });
    } finally {
      await runLog.stop();
      activeRequests.delete(chatId);
    }

    assert.deepEqual(observed, [{ tracked: true, stopped: true, reachedTheTurn: true }]);
  });

  it('leaves a non-streaming turn that is not persisted untracked, as before', async () => {
    const chatId = 'chat-plain-nostream';
    const runLog = new RunLog({
      baseDir: path.join(baseDir, 'plain-run-log'),
      forceEnabled: false,
      getPlatformConfig: () => ({})
    });
    let tracked = null;
    const service = new ChatService({
      agentLoop: {
        run: async () => {
          tracked = hasActiveChatRequest(chatId);
          return { status: 'success', content: 'done', finishReason: 'stop', messages: [] };
        }
      },
      runLog,
      logInteraction: async () => {},
      telemetry: { recordChatCallStart: async () => {}, recordChatCallEnd: async () => {} }
    });

    try {
      await service.runTurn({
        prep: {
          app: { id: APP_ID },
          model: { id: 'gpt-4o' },
          llmMessages: [{ role: 'user', content: 'hi' }],
          tools: []
        },
        chatId,
        streaming: false,
        buildLogData: () => ({}),
        getLocalizedError: async code => code,
        user: USER
      });
    } finally {
      await runLog.stop();
      activeRequests.delete(chatId);
    }

    assert.equal(tracked, false);
  });

  it('does not report success when the stop found nothing in flight', async () => {
    // The endpoint's guard passes on the durable mark alone, and a mark can
    // outlive the turn it marks by the width of the handler. Answering
    // `success: true` there tells the user a turn was stopped when none was.
    const chatId = 'chat-stop-stale';
    markChatDurable(chatId);
    try {
      const res = await drive(chatStopHandlers, { chatId, user: USER });

      assert.equal(res.statusCode, 404);
      assert.equal(res.body.success, undefined);
    } finally {
      clearChatDurable(chatId);
    }
  });

  it('reports success when it did abort a durable turn with no stream', async () => {
    const chatId = 'chat-stop-durable';
    let aborted = false;
    markChatDurable(chatId);
    activeRequests.set(chatId, {
      abort() {
        aborted = true;
      }
    });
    try {
      const res = await drive(chatStopHandlers, { chatId, user: USER });

      assert.equal(res.statusCode, 200);
      assert.deepEqual(res.body, { success: true, message: 'Chat stream stopped' });
      assert.equal(aborted, true);
    } finally {
      activeRequests.delete(chatId);
      clearChatDurable(chatId);
    }
  });
});

describe('POST: upload descriptors on the stored message', () => {
  it('flattens the array shape the client sends for several files', () => {
    // The client sends a single object for one upload and an array for
    // several. An array is `typeof 'object'`, so without flattening three
    // files collapse into one nameless descriptor.
    const attachments = messageAttachments({
      fileData: [
        { type: 'document', fileName: 'a.pdf', fileSize: 1, fileType: 'application/pdf' },
        { type: 'document', fileName: 'b.pdf', fileSize: 2, fileType: 'application/pdf' },
        { type: 'document', fileName: 'c.pdf', fileSize: 3, fileType: 'application/pdf' }
      ]
    });

    assert.equal(attachments.length, 3);
    assert.deepEqual(
      attachments.map(entry => entry.fileName),
      ['a.pdf', 'b.pdf', 'c.pdf']
    );
  });

  it('keeps the single-object shape and mixes the three kinds', () => {
    const attachments = messageAttachments({
      fileData: { type: 'document', fileName: 'spec.pdf' },
      imageData: [
        { type: 'image', fileName: 'one.png' },
        { type: 'image', fileName: 'two.png' }
      ],
      audioData: { type: 'audio', fileName: 'note.m4a' }
    });

    assert.deepEqual(
      attachments.map(entry => entry.fileName),
      ['spec.pdf', 'one.png', 'two.png', 'note.m4a']
    );
  });

  it('is empty for a message with no uploads', () => {
    assert.deepEqual(messageAttachments({}), []);
    assert.deepEqual(messageAttachments({ fileData: null, imageData: [] }), []);
    assert.deepEqual(messageAttachments(undefined), []);
  });
});
