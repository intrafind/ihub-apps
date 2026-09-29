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

describe('importChat does not leave half a conversation behind', () => {
  it('removes the chat when a message cannot be written', async () => {
    const deleted = [];
    let appended = 0;
    const repository = {
      ensureChat: async ({ chatId }) => ({ id: chatId }),
      appendMessage: async () => {
        appended += 1;
        return appended < 3 ? { message: {} } : null;
      },
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
    assert.equal(deleted.length, 1, 'the partial chat was removed');
    assert.match(deleted[0], /^chat-/);
  });
});
