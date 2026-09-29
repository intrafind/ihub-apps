/**
 * `POST /api/chats/import` — "Open in web" for surfaces that keep their
 * conversation client-side (the Outlook task pane).
 *
 * What has to hold is small and easy to get subtly wrong: the chat belongs to
 * the caller and to nobody else, it is stored under an id the caller cannot
 * choose, only apps the caller may use can be imported into (the web app will
 * answer follow-ups with that app), and a transcript that cannot be stored in
 * full is not stored in part.
 *
 * Driven the way `chat-persistence-routes.test.js` drives the other chat
 * routes: the real handler chain from the handler onwards, over a filesystem
 * storage provider in a temp directory, with `req.user` left as the
 * authentication middleware would have left it.
 */
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { after, before, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';

import configCache from '../configCache.js';
import { bootstrapStorage, shutdownStorageBootstrap } from '../storage/bootstrap.js';
import { getChatRepository } from '../services/chat/ChatRepository.js';
import { importChat, MAX_IMPORT_MESSAGES } from '../services/chat/chatImport.js';
import registerChatRoutes from '../routes/chats.js';

const APPS = [
  { id: 'outlook-reply', name: { en: 'Reply' } },
  { id: 'translator', name: { en: 'Translator' } }
];

/** A signed-in caller allowed to use the given apps (`'*'` for all). */
function userWith(id, apps) {
  return { id, name: id, permissions: { apps: new Set(apps) } };
}

const ADA = userWith('user-ada', ['outlook-reply', 'translator']);
const GRACE = userWith('user-grace', ['translator']);

const transcript = [
  { role: 'user', content: 'Reply that we accept the offer.' },
  { role: 'assistant', content: 'Dear Mara, we gladly accept your offer.' },
  { role: 'user', content: 'Shorter, please.' },
  { role: 'assistant', content: 'Dear Mara, we accept.' }
];

let baseDir;

/** Every route the router registers, via a recorder (no HTTP server needed). */
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

function handlersFor(method, suffix) {
  const route = routes.find(entry => entry.method === method && entry.routePath.endsWith(suffix));
  assert.ok(route, `${method.toUpperCase()} ${suffix} must be registered`);
  return route.handlers;
}

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
  return res;
}

/** Run a chain from the handler onwards, skipping the auth middleware at its head. */
async function drive(handlers, { params = {}, body = {}, user }) {
  const req = { params, query: {}, body, headers: {}, user };
  const res = makeResponse();
  await handlers[handlers.length - 1](req, res, () => {});
  return res;
}

const importHandlers = handlersFor('post', '/api/chats/import');
const getHandlers = handlersFor('get', '/api/chats/:chatId');

const importAs = (user, body) => drive(importHandlers, { user, body });

before(async () => {
  baseDir = await fs.mkdtemp(path.join(os.tmpdir(), 'ihub-chat-import-'));
  await bootstrapStorage({
    storage: { provider: 'filesystem', filesystem: { baseDir, flushIntervalMs: 25 } }
  });
});

after(async () => {
  await shutdownStorageBootstrap();
  await fs.rm(baseDir, { recursive: true, force: true });
});

beforeEach(() => {
  configCache.setCacheEntry('config/features.json', { chatPersistence: true });
  configCache.setCacheEntry('config/platform.json', { chats: { enabled: true } });
  // Raw data: the cache wraps it into `{ data, etag }` itself.
  configCache.setCacheEntry('config/apps.json', APPS);
});

describe('POST /api/chats/import stores the conversation for the caller', () => {
  it('creates a chat the caller owns, with the transcript in order', async () => {
    const res = await importAs(ADA, {
      appId: 'outlook-reply',
      modelId: 'gpt-4',
      messages: transcript
    });

    assert.equal(res.statusCode, 201);
    const { chat } = res.body;
    assert.match(chat.id, /^chat-[0-9a-f-]{36}$/);
    assert.equal(chat.ownerId, 'user-ada');
    assert.equal(chat.appId, 'outlook-reply');
    assert.equal(chat.modelId, 'gpt-4');
    assert.equal(chat.messageCount, 4);
    assert.equal(chat.hasUnseenActivity, false, 'the user is about to open it');
    assert.equal(chat.title, 'Reply that we accept the offer.', 'named after the first message');

    const stored = await getChatRepository().getMessages(chat.id);
    assert.deepEqual(
      stored.messages.map(m => [m.role, m.content]),
      transcript.map(m => [m.role, m.content])
    );
  });

  it('is what the web app then opens: the owner reads it, nobody else does', async () => {
    const { body } = await importAs(ADA, { appId: 'outlook-reply', messages: transcript });

    const own = await drive(getHandlers, { params: { chatId: body.chat.id }, user: ADA });
    assert.equal(own.statusCode, 200);
    assert.equal(own.body.messages.length, 4);

    const other = await drive(getHandlers, { params: { chatId: body.chat.id }, user: GRACE });
    assert.equal(other.statusCode, 404, 'a chat that is not yours does not exist');
  });

  it('mints the chat id itself, whatever the caller asks for', async () => {
    // An import that honoured `chatId` could overwrite or append to somebody's
    // existing chat, or squat on an id the web app is about to mint.
    await getChatRepository().ensureChat({
      chatId: 'chat-existing',
      ownerId: 'user-grace',
      appId: 'translator'
    });

    const res = await importAs(ADA, {
      appId: 'outlook-reply',
      chatId: 'chat-existing',
      messages: transcript
    });

    assert.equal(res.statusCode, 201);
    assert.notEqual(res.body.chat.id, 'chat-existing');
    const untouched = await getChatRepository().getChat('chat-existing');
    assert.equal(untouched.ownerId, 'user-grace');
    assert.equal(untouched.messageCount, 0);
  });

  it('keeps only what a model can be replayed: real user/assistant turns', async () => {
    const res = await importAs(ADA, {
      appId: 'outlook-reply',
      messages: [
        { role: 'system', content: 'Chat cleared.' },
        { role: 'user', content: 'Summarize this.' },
        { role: 'assistant', content: '   ' },
        { role: 'assistant', content: 'A summary.' }
      ]
    });

    assert.equal(res.statusCode, 201);
    const stored = await getChatRepository().getMessages(res.body.chat.id);
    assert.deepEqual(
      stored.messages.map(m => m.role),
      ['user', 'assistant']
    );
  });

  it('records when things were said, but never in the future', async () => {
    const past = '2026-09-01T08:00:00.000Z';
    const future = new Date(Date.now() + 24 * 3600 * 1000).toISOString();
    const res = await importAs(ADA, {
      appId: 'outlook-reply',
      messages: [
        { role: 'user', content: 'Earlier.', ts: past },
        { role: 'assistant', content: 'Answer.', ts: future },
        { role: 'user', content: 'No timestamp at all.' },
        { role: 'assistant', content: 'Garbage.', ts: 'yesterday-ish' }
      ]
    });

    const { messages } = await getChatRepository().getMessages(res.body.chat.id);
    assert.equal(messages[0].ts, past);
    // A future timestamp would pin the chat to the top of the history list.
    for (const message of messages.slice(1)) {
      assert.ok(Date.parse(message.ts) <= Date.now(), `${message.ts} is not in the future`);
    }
  });

  it('resolves the app case-insensitively to its configured id', async () => {
    const res = await importAs(ADA, { appId: 'Outlook-Reply', messages: transcript });

    assert.equal(res.statusCode, 201);
    assert.equal(res.body.chat.appId, 'outlook-reply');
  });
});

describe('POST /api/chats/import authorizes the app', () => {
  it('refuses an app the caller may not use, and stores nothing', async () => {
    const before = await getChatRepository().listChats('user-grace');

    const res = await importAs(GRACE, { appId: 'outlook-reply', messages: transcript });

    assert.equal(res.statusCode, 403);
    assert.equal(res.body.details.code, 'APP_ACCESS_DENIED');
    const after = await getChatRepository().listChats('user-grace');
    assert.equal(after.items.length, before.items.length);
  });

  it('honours the OAuth client narrowing the Outlook token carries', async () => {
    // `enhanceUserWithPermissions` has already intersected the group's apps
    // with the client's allow-list by the time the handler sees `permissions`.
    const narrowed = userWith('user-ada', ['translator']);
    const res = await importAs(narrowed, { appId: 'outlook-reply', messages: transcript });
    assert.equal(res.statusCode, 403);
  });

  it('lets a caller with wildcard access import into any configured app', async () => {
    const res = await importAs(userWith('user-root', ['*']), {
      appId: 'translator',
      messages: transcript
    });
    assert.equal(res.statusCode, 201);
  });

  it('fails closed for a principal whose permissions were never resolved', async () => {
    const res = await importAs(
      { id: 'user-ada' },
      { appId: 'outlook-reply', messages: transcript }
    );
    assert.equal(res.statusCode, 403);
  });

  it('answers 404 for an app that does not exist', async () => {
    const res = await importAs(userWith('user-root', ['*']), {
      appId: 'no-such-app',
      messages: transcript
    });
    assert.equal(res.statusCode, 404);
  });
});

describe('POST /api/chats/import refuses what it cannot store faithfully', () => {
  it('requires an app id, and a safe one', async () => {
    assert.equal((await importAs(ADA, { messages: transcript })).statusCode, 400);
    assert.equal((await importAs(ADA, { appId: '../x', messages: transcript })).statusCode, 400);
  });

  it('rejects a transcript that is not an array of role/content messages', async () => {
    for (const messages of [undefined, 'hi', [null], [{ role: 'user' }], [{ content: 'x' }]]) {
      const res = await importAs(ADA, { appId: 'outlook-reply', messages });
      assert.equal(res.statusCode, 400, JSON.stringify(messages));
      assert.equal(res.body.details.code, 'INVALID_MESSAGES');
    }
  });

  it('rejects a transcript with nothing to continue from', async () => {
    const res = await importAs(ADA, {
      appId: 'outlook-reply',
      messages: [
        { role: 'system', content: 'x' },
        { role: 'user', content: '  ' }
      ]
    });
    assert.equal(res.statusCode, 400);
    assert.equal(res.body.details.code, 'EMPTY_TRANSCRIPT');
  });

  it('rejects an oversized transcript instead of silently dropping the start of it', async () => {
    const messages = Array.from({ length: MAX_IMPORT_MESSAGES + 1 }, (_, index) => ({
      role: index % 2 === 0 ? 'user' : 'assistant',
      content: `message ${index}`
    }));
    const res = await importAs(ADA, { appId: 'outlook-reply', messages });
    assert.equal(res.statusCode, 400);
    assert.equal(res.body.details.code, 'TOO_MANY_MESSAGES');
  });

  it('answers 503 CHAT_PERSISTENCE_UNAVAILABLE when the installation stores no chats', async () => {
    configCache.setCacheEntry('config/platform.json', { chats: { enabled: false } });

    const res = await importAs(ADA, { appId: 'outlook-reply', messages: transcript });

    assert.equal(res.statusCode, 503);
    assert.equal(res.body.details.code, 'CHAT_PERSISTENCE_UNAVAILABLE');
  });
});

describe('an import stores the transcript whole or not at all', () => {
  /** A chat document with no messages, as `importChat` creates before writing. */
  async function newChat(chatId, ownerId = 'user-ada') {
    await getChatRepository().ensureChat({
      chatId,
      ownerId,
      identityMode: 'default',
      appId: 'chat'
    });
  }

  it('writes the transcript in one go: order, count, title and last message time', async () => {
    const repository = getChatRepository();
    await newChat('chat-whole-1');

    const result = await repository.importMessages('chat-whole-1', [
      { role: 'user', content: 'First question', ts: '2026-09-01T08:00:00.000Z' },
      { role: 'assistant', content: 'First answer', ts: '2026-09-01T08:00:05.000Z' },
      { role: 'user', content: 'Second question', ts: '2026-09-01T08:01:00.000Z' }
    ]);

    assert.equal(result.messages.length, 3);
    const chat = await repository.getChat('chat-whole-1');
    assert.equal(chat.messageCount, 3);
    assert.equal(chat.title, 'First question');
    assert.equal(chat.lastMessageAt, '2026-09-01T08:01:00.000Z');
    const stored = await repository.getMessages('chat-whole-1');
    assert.deepEqual(
      stored.messages.map(m => m.content),
      ['First question', 'First answer', 'Second question']
    );
  });

  it('is fast however long the conversation is', async () => {
    // Message by message it rewrote the whole transcript each time — about
    // 1.7 s for 200 messages. One write should not notice the difference.
    await newChat('chat-whole-fast');
    const messages = Array.from({ length: MAX_IMPORT_MESSAGES }, (_, index) => ({
      role: index % 2 === 0 ? 'user' : 'assistant',
      content: `message ${index} ${'lorem ipsum '.repeat(150)}`
    }));

    const started = performance.now();
    await getChatRepository().importMessages('chat-whole-fast', messages);

    assert.ok(performance.now() - started < 800, 'imported without a write per message');
    assert.equal((await getChatRepository().getMessages('chat-whole-fast')).messages.length, 200);
  });

  it('refuses a chat that already has messages, and leaves it alone', async () => {
    // The repository-level half of "an import can never add to somebody's
    // conversation" — the route also mints the id itself.
    const repository = getChatRepository();
    await newChat('chat-whole-busy');
    await repository.appendMessage('chat-whole-busy', { role: 'user', content: 'Already here' });

    await assert.rejects(
      repository.importMessages('chat-whole-busy', [{ role: 'user', content: 'Intruder' }]),
      { code: 'CHAT_NOT_EMPTY' }
    );

    const stored = await repository.getMessages('chat-whole-busy');
    assert.deepEqual(
      stored.messages.map(m => m.content),
      ['Already here']
    );
  });

  it('does nothing for a chat that was never created, or for nothing to store', async () => {
    const repository = getChatRepository();
    assert.equal(
      await repository.importMessages('chat-never-made', [{ role: 'user', content: 'x' }]),
      null
    );
    await newChat('chat-whole-empty');
    assert.equal(await repository.importMessages('chat-whole-empty', []), null);
    assert.equal((await repository.getMessages('chat-whole-empty')).messages.length, 0);
  });

  it('keeps the newest messages when the platform caps a chat lower', async () => {
    configCache.setCacheEntry('config/platform.json', {
      chats: { enabled: true, maxMessagesPerChat: 3 }
    });
    await newChat('chat-whole-cap');

    await getChatRepository().importMessages(
      'chat-whole-cap',
      ['one', 'two', 'three', 'four', 'five'].map(content => ({ role: 'user', content }))
    );

    const stored = await getChatRepository().getMessages('chat-whole-cap');
    assert.deepEqual(
      stored.messages.map(m => m.content),
      ['three', 'four', 'five']
    );
    assert.equal((await getChatRepository().getChat('chat-whole-cap')).messageCount, 3);
  });

  it('a transcript write that fails leaves no chat behind, and the caller is told', async () => {
    // The failure the old per-message loop could turn into half a
    // conversation: the transcript write itself failing.
    const repository = getChatRepository();
    const before = (await repository.listChats('user-ada', { limit: 100 })).items.map(c => c.id);
    const original = repository._writeMessages;
    repository._writeMessages = async () => {
      throw new Error('disk full');
    };
    let res;
    try {
      res = await importAs(ADA, { appId: 'outlook-reply', messages: transcript });
    } finally {
      repository._writeMessages = original;
    }

    assert.equal(res.statusCode, 500);
    const after = (await repository.listChats('user-ada', { limit: 100 })).items.map(c => c.id);
    assert.deepEqual(after, before, 'no empty or partial chat was left in the history');
  });

  it('still removes the chat if it cannot even be cleaned up in the usual way', async () => {
    // Fake repository: the write reports failure, the cleanup is what we watch.
    const deleted = [];
    const repository = {
      ensureChat: async ({ chatId }) => ({ id: chatId }),
      importMessages: async () => null,
      deleteChat: async chatId => {
        deleted.push(chatId);
      },
      getChat: async () => null
    };

    await assert.rejects(
      importChat({
        repository,
        ownerId: 'user-ada',
        identityMode: 'default',
        appId: 'outlook-reply',
        messages: transcript
      }),
      { code: 'STORAGE_UNAVAILABLE' }
    );
    assert.equal(deleted.length, 1, 'the chat created for the import was removed');
    assert.match(deleted[0], /^chat-/);
  });

  it('a cleanup that fails as well does not hide the original failure', async () => {
    const repository = {
      ensureChat: async ({ chatId }) => ({ id: chatId }),
      importMessages: async () => {
        throw new Error('disk full');
      },
      deleteChat: async () => {
        throw new Error('still full');
      },
      getChat: async () => null
    };

    await assert.rejects(
      importChat({
        repository,
        ownerId: 'user-ada',
        identityMode: 'default',
        appId: 'outlook-reply',
        messages: transcript
      }),
      { message: 'disk full' }
    );
  });
});
