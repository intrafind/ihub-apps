// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * Background chat titles (#2314): the repository half — where a title came
 * from (`titleSource`), the once-only claim and the compare-and-set write that
 * lets a manual rename always win.
 *
 * Driven against a real filesystem storage provider, like
 * `chat-persistence-repository.test.js`: the claim's guarantee is only as good
 * as the lock and the etag-conditional write underneath it.
 */
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { FilesystemStorageProvider } from '../storage/providers/filesystem/index.js';
import { ChatRepository, titleSourceOf } from '../services/chat/ChatRepository.js';

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

describe('ChatRepository: title source', () => {
  it('a new chat starts derived and the first user message names it', async () => {
    await withRepository(async ({ repository }) => {
      const created = await repository.ensureChat({ chatId: CHAT_ID, ownerId: OWNER });
      assert.equal(created.titleSource, 'derived');
      await repository.appendMessage(CHAT_ID, { role: 'user', content: 'Hello there', runId: 'r' });
      const chat = await repository.getChat(CHAT_ID);
      assert.equal(chat.title, 'Hello there');
      assert.equal(titleSourceOf(chat), 'derived');
    });
  });

  it('a rename is a user title, and clearing it resets to derived', async () => {
    await withRepository(async ({ repository }) => {
      await seedAnsweredChat(repository);
      const renamed = await repository.renameChat(CHAT_ID, 'My heating mail');
      assert.equal(renamed.titleSource, 'user');
      assert.equal(renamed.titleSetByUser, true);
      const cleared = await repository.renameChat(CHAT_ID, '');
      assert.equal(cleared.titleSource, 'derived');
      assert.equal(cleared.titleSetByUser, false);
    });
  });

  it('reads a chat stored before the field existed', () => {
    assert.equal(titleSourceOf({ titleSetByUser: true, title: 'x' }), 'user');
    assert.equal(titleSourceOf({ titleSetByUser: false, title: 'x' }), 'derived');
    assert.equal(titleSourceOf({ title: 'x' }), 'derived');
    assert.equal(titleSourceOf({ title: 'x', titleSource: 'llm' }), 'llm');
    assert.equal(titleSourceOf(null), 'derived');
  });
});

describe('ChatRepository: claimGeneratedTitle', () => {
  it('hands back the first exchange once', async () => {
    await withRepository(async ({ repository }) => {
      await seedAnsweredChat(repository);
      const claim = await repository.claimGeneratedTitle(CHAT_ID);
      assert.ok(claim);
      assert.match(claim.userText, /landlord/);
      assert.match(claim.assistantText, /inspection/);
      assert.equal(claim.title, (await repository.getChat(CHAT_ID)).title);
      assert.equal(await repository.claimGeneratedTitle(CHAT_ID), null, 'second claim is refused');
    });
  });

  it('of concurrent claims exactly one wins', async () => {
    await withRepository(async ({ repository }) => {
      await seedAnsweredChat(repository);
      const claims = await Promise.all(
        Array.from({ length: 5 }, () => repository.claimGeneratedTitle(CHAT_ID))
      );
      assert.equal(claims.filter(Boolean).length, 1);
    });
  });

  it('of two workers on one volume exactly one wins', async () => {
    const first = await openRepository();
    const second = await openRepository(first.baseDir);
    try {
      await seedAnsweredChat(first.repository);
      const claims = await Promise.all([
        first.repository.claimGeneratedTitle(CHAT_ID),
        second.repository.claimGeneratedTitle(CHAT_ID)
      ]);
      assert.equal(claims.filter(Boolean).length, 1);
    } finally {
      await first.provider.shutdown();
      await second.provider.shutdown();
      await fs.rm(first.baseDir, { recursive: true, force: true });
    }
  });

  it('is refused for a missing chat, a user title and a chat without an answer', async () => {
    await withRepository(async ({ repository }) => {
      assert.equal(await repository.claimGeneratedTitle('chat-missing'), null);

      await repository.ensureChat({ chatId: CHAT_ID, ownerId: OWNER });
      await repository.appendMessage(CHAT_ID, { role: 'user', content: 'Hi', runId: 'r' });
      assert.equal(await repository.claimGeneratedTitle(CHAT_ID), null, 'no answer yet');

      await repository.appendMessage(CHAT_ID, {
        role: 'assistant',
        content: 'partial',
        runId: 'r',
        error: { code: 'X', message: 'boom' }
      });
      assert.equal(await repository.claimGeneratedTitle(CHAT_ID), null, 'a failed answer');

      await repository.appendMessage(CHAT_ID, { role: 'assistant', content: 'ok', runId: 'r2' });
      await repository.renameChat(CHAT_ID, 'Mine');
      assert.equal(await repository.claimGeneratedTitle(CHAT_ID), null, 'user-set title');
    });
  });

  it('is refused for temporary chats, and allowed once the chat is kept', async () => {
    await withRepository(async ({ repository }) => {
      await seedAnsweredChat(repository, { temporary: true });
      assert.equal(await repository.claimGeneratedTitle(CHAT_ID), null);
      await repository.keepChat(CHAT_ID);
      assert.ok(await repository.claimGeneratedTitle(CHAT_ID));
    });
  });

  it('is refused for chats opened by a task, the Responses API or a project test', async () => {
    for (const createdVia of ['scheduled-task', 'responses-api', 'project-test']) {
      await withRepository(async ({ repository }) => {
        await seedAnsweredChat(repository, { origin: { createdVia } });
        assert.equal(await repository.claimGeneratedTitle(CHAT_ID), null, createdVia);
      });
    }
    await withRepository(async ({ repository }) => {
      await seedAnsweredChat(repository, { origin: { createdVia: 'ui' } });
      assert.ok(await repository.claimGeneratedTitle(CHAT_ID));
    });
  });
});

describe('ChatRepository: setGeneratedTitle', () => {
  it('replaces the derived title and leaves the rest of the chat alone', async () => {
    await withRepository(async ({ repository }) => {
      await seedAnsweredChat(repository);
      const before = await repository.getChat(CHAT_ID);
      const claim = await repository.claimGeneratedTitle(CHAT_ID);
      const { applied, chat } = await repository.setGeneratedTitle(CHAT_ID, 'Heating inspection', {
        expectedTitle: claim.title
      });
      assert.equal(applied, true);
      assert.equal(chat.title, 'Heating inspection');
      assert.equal(chat.titleSource, 'llm');
      assert.equal(chat.titleSetByUser, false);
      assert.equal(chat.lastMessageAt, before.lastMessageAt);
      assert.equal(chat.hasUnseenActivity, before.hasUnseenActivity);
      assert.equal(chat.messageCount, before.messageCount);
    });
  });

  it('loses to a rename that happened while the model was answering', async () => {
    await withRepository(async ({ repository }) => {
      await seedAnsweredChat(repository);
      const claim = await repository.claimGeneratedTitle(CHAT_ID);
      // The user renames to exactly the derived text: only the source tells
      // the two apart, which is why the check is not on the title alone.
      await repository.renameChat(CHAT_ID, claim.title);
      const { applied, chat } = await repository.setGeneratedTitle(CHAT_ID, 'Generated', {
        expectedTitle: claim.title
      });
      assert.equal(applied, false);
      assert.equal(chat.title, claim.title);
      assert.equal(chat.titleSource, 'user');
    });
  });

  it('loses to a reset, and a reset never earns another generation', async () => {
    await withRepository(async ({ repository }) => {
      await seedAnsweredChat(repository);
      const claim = await repository.claimGeneratedTitle(CHAT_ID);
      await repository.renameChat(CHAT_ID, '');
      const { applied } = await repository.setGeneratedTitle(CHAT_ID, 'Generated', {
        expectedTitle: claim.title
      });
      assert.equal(applied, false);
      // The next user message derives a fresh title, but no claim is left.
      await repository.appendMessage(CHAT_ID, { role: 'user', content: 'Next', runId: 'r3' });
      assert.equal(await repository.claimGeneratedTitle(CHAT_ID), null);
    });
  });

  it('does not store an empty title or write to a missing chat', async () => {
    await withRepository(async ({ repository }) => {
      await seedAnsweredChat(repository);
      const claim = await repository.claimGeneratedTitle(CHAT_ID);
      const empty = await repository.setGeneratedTitle(CHAT_ID, '  ', {
        expectedTitle: claim.title
      });
      assert.equal(empty.applied, false);
      const missing = await repository.setGeneratedTitle('chat-missing', 'X', {
        expectedTitle: 'y'
      });
      assert.deepEqual(missing, { applied: false, chat: null });
    });
  });
});
