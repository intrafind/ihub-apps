/**
 * The `/api/chats` handlers, driven through the real route chain.
 *
 * `authorizeChat` has its own suite and so does `ChatRepository.deleteChat`.
 * Neither sees the wiring that joins them, and the wiring is where the two
 * things that matter live: the ownership check that keeps one user's
 * conversation out of another's browser, and the cascade that makes "removed
 * for good" true. Chat ids are client-minted and enumerable, which is exactly
 * why a chat that is not yours answers 404 rather than 403.
 *
 * The route chain is driven from the handler onwards; the authentication
 * middleware in front of it has its own suite, so `req.user` is injected here
 * the way that middleware would have left it. Everything below is real: a
 * filesystem storage provider over `mkdtemp`, the real repository, the real
 * access check.
 */
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { after, before, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';

import configCache from '../configCache.js';
import { bootstrapStorage, shutdownStorageBootstrap } from '../storage/bootstrap.js';
import { getChatRepository } from '../services/chat/ChatRepository.js';
import runLog from '../services/loop/RunLog.js';
import { getWorkflowStateRepository } from '../services/workflow/WorkflowStateRepository.js';
import { activeRequests } from '../sse.js';
import registerChatRoutes from '../routes/chats.js';

const ADA = { id: 'user-ada', name: 'Ada' };
const GRACE = { id: 'user-grace', name: 'Grace' };

let baseDir;

/**
 * Every route `registerChatRoutes` registers. It only ever calls
 * `app.<method>(path, ...handlers)`, so a recorder gets at the real handlers
 * without an HTTP server.
 *
 * @returns {Array<{method: string, routePath: string, handlers: Function[]}>}
 */
function captureRoutes() {
  const routes = [];
  const record =
    method =>
    (routePath, ...handlers) =>
      routes.push({ method, routePath, handlers });
  registerChatRoutes({
    get: record('get'),
    post: record('post'),
    put: record('put'),
    patch: record('patch'),
    delete: record('delete'),
    use: () => {}
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

/**
 * A response double that records what the handler answered.
 *
 * @returns {Object}
 */
function makeResponse() {
  const res = { statusCode: 200, body: null };
  res.status = code => {
    res.statusCode = code;
    return res;
  };
  res.json = value => {
    res.body = value;
    return res;
  };
  res.setHeader = () => res;
  return res;
}

/**
 * Drive a captured handler chain, skipping the authentication middleware at
 * its head.
 *
 * @param {Function[]} handlers - Chain as registered.
 * @param {Object} params
 * @param {Object} [params.params] - Route params.
 * @param {Object} [params.query] - Query string.
 * @param {Object} [params.body] - Request body.
 * @param {Object} params.user - Authenticated caller.
 * @returns {Promise<Object>} The response double.
 */
async function drive(handlers, { params = {}, query = {}, body = {}, user }) {
  const req = { params, query, body, headers: {}, user };
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

const listHandlers = handlersFor('get', '/api/chats');
const getHandlers = handlersFor('get', '/api/chats/:chatId');
const patchHandlers = handlersFor('patch', '/api/chats/:chatId');
const deleteHandlers = handlersFor('delete', '/api/chats/:chatId');

/**
 * Store one chat with a turn in it, owned by `user`.
 *
 * @param {Object} user - Owner.
 * @param {string} chatId - Chat id.
 * @param {Object} [options]
 * @param {string[]} [options.runIds] - Runs to record against the chat.
 * @returns {Promise<void>}
 */
async function seedChat(user, chatId, { runIds = [] } = {}) {
  const repository = getChatRepository();
  await repository.ensureChat({ chatId, ownerId: user.id, appId: 'chat' });
  for (const runId of runIds) {
    await repository.appendMessage(chatId, {
      role: 'user',
      content: `a question recorded against ${runId}`,
      runId
    });
  }
  // A turn is what sets this; nothing here ran one, so it is set directly.
  await repository.updateChat(chatId, { hasUnseenActivity: true });
}

before(async () => {
  baseDir = await fs.mkdtemp(path.join(os.tmpdir(), 'ihub-chat-routes-'));
  await bootstrapStorage({
    storage: { provider: 'filesystem', filesystem: { baseDir, flushIntervalMs: 25 } }
  });
  configCache.setCacheEntry('config/features.json', { chatPersistence: true });
  configCache.setCacheEntry('config/platform.json', { chats: { enabled: true } });
});

after(async () => {
  await shutdownStorageBootstrap();
  await fs.rm(baseDir, { recursive: true, force: true });
});

describe('GET /api/chats/:chatId is scoped to its owner', () => {
  it("answers 404 for someone else's chat, and does not clear their unseen flag", async () => {
    // 404 rather than 403: ids are client-minted and enumerable, so a 403
    // would confirm which ones exist. And the read that is refused must not
    // have the side effect of the read that is allowed — marking the chat seen
    // is how the owner would otherwise never learn it had been opened.
    await seedChat(ADA, 'chat-ada-private');
    const before = await getChatRepository().getChat('chat-ada-private');
    assert.equal(before.hasUnseenActivity, true);

    const res = await drive(getHandlers, {
      params: { chatId: 'chat-ada-private' },
      user: GRACE
    });

    assert.equal(res.statusCode, 404);
    const after = await getChatRepository().getChat('chat-ada-private');
    assert.equal(after.hasUnseenActivity, true, "the owner's unseen flag survived");
  });

  it('answers the owner with the transcript, and marks it seen', async () => {
    await seedChat(ADA, 'chat-ada-own', { runIds: ['run-own-1'] });

    const res = await drive(getHandlers, {
      params: { chatId: 'chat-ada-own' },
      user: ADA
    });

    assert.equal(res.statusCode, 200);
    assert.equal(res.body.chat.id, 'chat-ada-own');
    assert.equal(res.body.messages.length, 1);
    const stored = await getChatRepository().getChat('chat-ada-own');
    assert.equal(stored.hasUnseenActivity, false);
  });
});

describe('GET /api/chats lists only the caller', () => {
  it("does not page another owner's chats into the caller's list", async () => {
    await seedChat(ADA, 'chat-list-ada');
    await seedChat(GRACE, 'chat-list-grace');

    const res = await drive(listHandlers, { user: GRACE });

    assert.equal(res.statusCode, 200);
    const ids = res.body.items.map(chat => chat.id);
    assert.ok(ids.includes('chat-list-grace'));
    assert.ok(!ids.includes('chat-list-ada'), "Ada's chat stayed out of Grace's list");
  });
});

describe('PATCH /api/chats/:chatId', () => {
  it('refuses a title that is not a string', async () => {
    await seedChat(ADA, 'chat-patch-type');

    const res = await drive(patchHandlers, {
      params: { chatId: 'chat-patch-type' },
      body: { title: { en: 'an object' } },
      user: ADA
    });

    assert.equal(res.statusCode, 400);
  });

  it("refuses to rename someone else's chat", async () => {
    await seedChat(ADA, 'chat-patch-owner');

    const res = await drive(patchHandlers, {
      params: { chatId: 'chat-patch-owner' },
      body: { title: 'renamed by a stranger' },
      user: GRACE
    });

    assert.equal(res.statusCode, 404);
    const stored = await getChatRepository().getChat('chat-patch-owner');
    assert.notEqual(stored.title, 'renamed by a stranger');
  });
});

describe('DELETE /api/chats/:chatId cascades', () => {
  const deleted = { runs: [], states: [] };
  let restore;

  beforeEach(() => {
    deleted.runs = [];
    deleted.states = [];
  });

  before(() => {
    const originalDeleteRun = runLog.deleteRun;
    const stateRepository = getWorkflowStateRepository();
    const originalRemove = stateRepository.remove;
    runLog.deleteRun = async runId => {
      deleted.runs.push(runId);
      // The middle run refuses, so the isolation the handler claims is
      // actually exercised: one stubborn run must not strand the rest.
      if (runId.endsWith('-boom')) throw new Error('ledger is wedged');
      return true;
    };
    stateRepository.remove = async executionId => {
      deleted.states.push(executionId);
      return true;
    };
    restore = () => {
      runLog.deleteRun = originalDeleteRun;
      stateRepository.remove = originalRemove;
    };
  });

  after(() => restore?.());

  it("refuses to delete someone else's chat", async () => {
    await seedChat(ADA, 'chat-delete-owner', { runIds: ['run-not-yours'] });

    const res = await drive(deleteHandlers, {
      params: { chatId: 'chat-delete-owner' },
      user: GRACE
    });

    assert.equal(res.statusCode, 404);
    assert.deepEqual(deleted.runs, [], 'nothing cascaded');
    assert.ok(await getChatRepository().getChat('chat-delete-owner'), 'the chat is still there');
  });

  it('removes every run of the chat, and the workflow state of each', async () => {
    // The confirmation says the conversation is removed for good. The run
    // ledger holds the prompt and the answer; an `@mention` turn additionally
    // left a workflow state document carrying the chat history it was launched
    // with, and nothing used to take that.
    await seedChat(ADA, 'chat-delete-cascade', {
      runIds: ['run-cascade-1', 'run-cascade-boom', 'run-cascade-3']
    });

    const res = await drive(deleteHandlers, {
      params: { chatId: 'chat-delete-cascade' },
      user: ADA
    });

    assert.equal(res.statusCode, 200);
    assert.deepEqual(res.body, { deleted: true });
    assert.deepEqual(deleted.runs.sort(), ['run-cascade-1', 'run-cascade-3', 'run-cascade-boom']);
    assert.deepEqual(deleted.states.sort(), ['run-cascade-1', 'run-cascade-3', 'run-cascade-boom']);
    assert.equal(await getChatRepository().getChat('chat-delete-cascade'), null);
  });

  it('stops the turn that is still generating before erasing what records it', async () => {
    // The sidebar deletes without stopping first. Left running, the model call
    // kept billing and its next ledger append re-created the very stream the
    // cascade had just deleted — appending to an unknown stream creates it —
    // leaving an event stream full of the conversation with no run summary to
    // find it by.
    await seedChat(ADA, 'chat-delete-running', { runIds: ['run-still-going'] });
    await getChatRepository().updateChat('chat-delete-running', {
      status: 'running',
      activeRunId: 'run-still-going'
    });

    let aborted = false;
    activeRequests.set('chat-delete-running', {
      abort: () => {
        aborted = true;
      }
    });
    try {
      const res = await drive(deleteHandlers, {
        params: { chatId: 'chat-delete-running' },
        user: ADA
      });
      assert.equal(res.statusCode, 200);
      assert.equal(aborted, true, 'the in-flight turn was aborted');
    } finally {
      activeRequests.delete('chat-delete-running');
    }
  });

  it('leaves an unrelated chat that is generating alone', async () => {
    await seedChat(ADA, 'chat-delete-settled', { runIds: ['run-settled'] });

    let aborted = false;
    activeRequests.set('chat-delete-settled', {
      abort: () => {
        aborted = true;
      }
    });
    try {
      await drive(deleteHandlers, { params: { chatId: 'chat-delete-settled' }, user: ADA });
      assert.equal(aborted, false, 'a chat with no running turn is not aborted');
    } finally {
      activeRequests.delete('chat-delete-settled');
    }
  });

  it('a run that refuses to go does not strand the workflow state of the rest', async () => {
    await seedChat(ADA, 'chat-delete-isolation', {
      runIds: ['run-iso-boom', 'run-iso-after']
    });

    const res = await drive(deleteHandlers, {
      params: { chatId: 'chat-delete-isolation' },
      user: ADA
    });

    assert.equal(res.statusCode, 200);
    assert.ok(deleted.states.includes('run-iso-boom'), 'the failing run still lost its state');
    assert.ok(deleted.states.includes('run-iso-after'), 'the run after it was reached');
  });
});
