// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * Background chat titles (#2314): the repository half — when a chat is due a
 * generated title, and the write that puts it into the same `title` field a
 * rename and the first-message title use, never over one the user set.
 *
 * Driven against a real filesystem storage provider, like
 * `chat-persistence-repository.test.js`.
 */
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { FilesystemStorageProvider } from '../storage/providers/filesystem/index.js';
import { ChatRepository } from '../services/chat/ChatRepository.js';

const OWNER = 'user-1';
const CHAT_ID = 'chat-1';
const quietLogger = { debug() {}, info() {}, warn() {}, error() {} };

async function openRepository(baseDir) {
  const dir = baseDir || (await fs.mkdtemp(path.join(os.tmpdir(), 'ihub-chat-title-')));
  const provider = new FilesystemStorageProvider({ baseDir: dir, flushIntervalMs: 25 });
  await provider.initialize();
  const repository = new ChatRepository({
    documents: provider.documents,
    locks: provider.locks,
    logger: quietLogger
  });
  return { baseDir: dir, provider, repository };
}

async function withRepository(fn) {
  const ctx = await openRepository();
  try {
    await fn(ctx);
  } finally {
    await ctx.provider.shutdown();
    await fs.rm(ctx.baseDir, { recursive: true, force: true });
  }
}

/** A chat with one answered turn, ready to be claimed. */
async function seedAnsweredChat(repository, overrides = {}) {
  await repository.ensureChat({
    chatId: CHAT_ID,
    ownerId: OWNER,
    modelId: 'gpt-4o',
    ...overrides
  });
  await repository.appendMessage(CHAT_ID, {
    role: 'user',
    content: 'Can you help me with the following email from my landlord about the heating?',
    runId: 'run-1'
  });
  await repository.appendMessage(CHAT_ID, {
    role: 'assistant',
    content: 'Sure. The landlord asks you to allow an inspection of the heating.',
    runId: 'run-1'
  });
}

describe('ChatRepository: getFirstExchangeForTitle', () => {
  it('hands back the first user message and the first answer', async () => {
    await withRepository(async ({ repository }) => {
      await seedAnsweredChat(repository);
      const exchange = await repository.getFirstExchangeForTitle(CHAT_ID);
      assert.match(exchange.userText, /landlord/);
      assert.match(exchange.assistantText, /inspection/);
    });
  });

  it('is not due for a missing chat, a chat without an answer or a failed answer', async () => {
    await withRepository(async ({ repository }) => {
      assert.equal(await repository.getFirstExchangeForTitle('chat-missing'), null);

      await repository.ensureChat({ chatId: CHAT_ID, ownerId: OWNER });
      await repository.appendMessage(CHAT_ID, { role: 'user', content: 'Hi', runId: 'r' });
      assert.equal(await repository.getFirstExchangeForTitle(CHAT_ID), null, 'no answer yet');

      await repository.appendMessage(CHAT_ID, {
        role: 'assistant',
        content: 'partial',
        runId: 'r',
        error: { code: 'X', message: 'boom' }
      });
      assert.equal(await repository.getFirstExchangeForTitle(CHAT_ID), null, 'a failed answer');
    });
  });

  it('is not due once the user has named the chat', async () => {
    await withRepository(async ({ repository }) => {
      await seedAnsweredChat(repository);
      await repository.renameChat(CHAT_ID, 'Mine');
      assert.equal(await repository.getFirstExchangeForTitle(CHAT_ID), null);
      // Clearing the title hands the naming back.
      await repository.renameChat(CHAT_ID, '');
      assert.ok(await repository.getFirstExchangeForTitle(CHAT_ID));
    });
  });

  it('with firstAnswerOnly is due for the first answer and for no later one', async () => {
    await withRepository(async ({ repository }) => {
      await seedAnsweredChat(repository);
      assert.ok(await repository.getFirstExchangeForTitle(CHAT_ID, { firstAnswerOnly: true }));

      await repository.appendMessage(CHAT_ID, { role: 'user', content: 'And then?', runId: 'r2' });
      await repository.appendMessage(CHAT_ID, { role: 'assistant', content: 'More.', runId: 'r2' });
      assert.equal(
        await repository.getFirstExchangeForTitle(CHAT_ID, { firstAnswerOnly: true }),
        null,
        'the second answer never asks for a title'
      );
      // Without the flag — a chat being kept — a chat with several answers is still due.
      const kept = await repository.getFirstExchangeForTitle(CHAT_ID);
      assert.match(kept.assistantText, /inspection/, 'made from the first answer');
    });
  });

  it('is not due for a temporary chat, and is once the chat is kept', async () => {
    await withRepository(async ({ repository }) => {
      await seedAnsweredChat(repository, { temporary: true });
      assert.equal(await repository.getFirstExchangeForTitle(CHAT_ID), null);
      await repository.keepChat(CHAT_ID);
      assert.ok(await repository.getFirstExchangeForTitle(CHAT_ID));
    });
  });

  it('is not due for chats opened by a task, the Responses API or a project test', async () => {
    for (const createdVia of ['scheduled-task', 'responses-api', 'project-test']) {
      await withRepository(async ({ repository }) => {
        await seedAnsweredChat(repository, { origin: { createdVia } });
        assert.equal(await repository.getFirstExchangeForTitle(CHAT_ID), null, createdVia);
      });
    }
    await withRepository(async ({ repository }) => {
      await seedAnsweredChat(repository, { origin: { createdVia: 'ui' } });
      assert.ok(await repository.getFirstExchangeForTitle(CHAT_ID));
    });
  });
});

describe('ChatRepository: setGeneratedTitle', () => {
  it('writes into the title field and leaves the rest of the chat alone', async () => {
    await withRepository(async ({ repository }) => {
      await seedAnsweredChat(repository);
      const before = await repository.getChat(CHAT_ID);
      assert.equal(await repository.setGeneratedTitle(CHAT_ID, 'Heating inspection'), true);
      const after = await repository.getChat(CHAT_ID);
      assert.equal(after.title, 'Heating inspection');
      assert.equal(after.titleSetByUser, false, 'a generated title is not a user title');
      assert.equal(after.lastMessageAt, before.lastMessageAt);
      assert.equal(after.hasUnseenActivity, before.hasUnseenActivity);
      assert.equal(after.messageCount, before.messageCount);
      assert.deepEqual(
        Object.keys(after)
          .filter(key => /title/i.test(key))
          .sort(),
        ['title', 'titleSetByUser'],
        'no second title field'
      );
    });
  });

  it('never replaces a title the user set', async () => {
    await withRepository(async ({ repository }) => {
      await seedAnsweredChat(repository);
      await repository.renameChat(CHAT_ID, 'My heating mail');
      assert.equal(await repository.setGeneratedTitle(CHAT_ID, 'Generated'), false);
      assert.equal((await repository.getChat(CHAT_ID)).title, 'My heating mail');
    });
  });

  it('a rename after a generated title still sets it as the user title', async () => {
    await withRepository(async ({ repository }) => {
      await seedAnsweredChat(repository);
      await repository.setGeneratedTitle(CHAT_ID, 'Generated');
      const renamed = await repository.renameChat(CHAT_ID, 'Mine');
      assert.equal(renamed.title, 'Mine');
      assert.equal(renamed.titleSetByUser, true);
    });
  });

  it('keeps a title to one line of at most 60 characters, and refuses an empty one', async () => {
    await withRepository(async ({ repository }) => {
      await seedAnsweredChat(repository);
      assert.equal(await repository.setGeneratedTitle(CHAT_ID, '   '), false);
      assert.equal(await repository.setGeneratedTitle(CHAT_ID, `a\n${'b'.repeat(200)}`), true);
      const { title } = await repository.getChat(CHAT_ID);
      assert.ok(title.length <= 60);
      assert.ok(!title.includes('\n'));
    });
  });

  it('writes to nothing when the chat is gone', async () => {
    await withRepository(async ({ repository }) => {
      assert.equal(await repository.setGeneratedTitle('chat-missing', 'X'), false);
    });
  });
});
