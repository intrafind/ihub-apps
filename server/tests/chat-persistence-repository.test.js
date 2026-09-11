/**
 * `ChatRepository` driven against a real filesystem storage provider.
 *
 * Nothing here is stubbed below the repository: every test builds a
 * `FilesystemStorageProvider` over its own `mkdtemp` directory, so the
 * document layout, the owner index and — crucially — the advisory file lease
 * that serializes two writers are the real ones. A test double for the store
 * would pass while the thing that actually loses a message (an unlocked
 * read-append-write against a shared directory) went unnoticed.
 *
 * The lock is exercised twice over: once with two callers inside one
 * repository, and once with two provider instances over the same directory,
 * which is what two cluster workers on a shared volume look like.
 *
 * Contract: `CHAT_PERSISTENCE_CONTRACT.md` §4 and §12.
 */
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { FilesystemStorageProvider } from '../storage/providers/filesystem/index.js';
import { StorageError } from '../storage/errors.js';
import {
  ChatRepository,
  MAX_MESSAGE_CHARS,
  MAX_TRACKED_RUN_IDS
} from '../services/chat/ChatRepository.js';

/** Namespace holding the chat metadata documents, as the contract names it. */
const CHATS_NS = 'chats';

/** Namespace holding the chat transcript documents, as the contract names it. */
const CHAT_MESSAGES_NS = 'chat-messages';

const OWNER = 'user-1';
const OTHER_OWNER = 'user-2';
const CHAT_ID = 'chat-1';

/** One day, for building `lastMessageAt` values that sort predictably. */
const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * A logger that records instead of printing. The repository takes one as a
 * dependency, so the deliberate-failure tests can assert on what was logged
 * without a wall of JSON in the runner output.
 *
 * @returns {{lines: Array<{level: string, message: string}>, logger: Object}}
 */
function recordingLogger() {
  const lines = [];
  const at = level => (message, meta) => lines.push({ level, message, meta });
  return {
    lines,
    logger: { debug: at('debug'), info: at('info'), warn: at('warn'), error: at('error') }
  };
}

/**
 * Bring up a provider and a repository over `baseDir`, creating a scratch
 * directory when none is given.
 *
 * @param {string} [baseDir] - Existing directory to re-open, for the
 *   two-writers-one-volume case.
 * @returns {Promise<Object>} Provider, repository, captured log lines and the
 *   directory they all share.
 */
async function openRepository(baseDir) {
  const dir = baseDir || (await fs.mkdtemp(path.join(os.tmpdir(), 'ihub-chat-repo-')));
  // A short flush interval keeps the append-log honest without any test ever
  // waiting on a timer; the document store this suite uses flushes per write.
  const provider = new FilesystemStorageProvider({ baseDir: dir, flushIntervalMs: 25 });
  await provider.initialize();
  const { lines, logger } = recordingLogger();
  const repository = new ChatRepository({
    documents: provider.documents,
    locks: provider.locks,
    logger
  });
  return { baseDir: dir, provider, repository, lines };
}

/**
 * Run `fn` with a repository over a directory of its own, torn down after.
 *
 * @param {(ctx: Object) => Promise<void>} fn - The test body.
 * @returns {Promise<void>}
 */
async function withRepository(fn) {
  const ctx = await openRepository();
  try {
    await fn(ctx);
  } finally {
    await ctx.provider.shutdown();
    await fs.rm(ctx.baseDir, { recursive: true, force: true });
  }
}

/**
 * Run `fn` with two independent providers over one directory — the shape two
 * cluster workers sharing a volume have.
 *
 * @param {(first: Object, second: Object) => Promise<void>} fn - The test body.
 * @returns {Promise<void>}
 */
async function withTwoRepositories(fn) {
  const first = await openRepository();
  const second = await openRepository(first.baseDir);
  try {
    await fn(first, second);
  } finally {
    await second.provider.shutdown();
    await first.provider.shutdown();
    await fs.rm(first.baseDir, { recursive: true, force: true });
  }
}

/**
 * Create the chat the tests operate on.
 *
 * @param {ChatRepository} repository - Repository under test.
 * @param {Object} [overrides] - Fields to override on the creation call.
 * @returns {Promise<Object>} The stored chat.
 */
function seedChat(repository, overrides = {}) {
  return repository.ensureChat({
    chatId: CHAT_ID,
    ownerId: OWNER,
    identityMode: 'default',
    appId: 'chat',
    modelId: 'gpt-4o',
    ...overrides
  });
}

/**
 * Append one message and hand back the stored form.
 *
 * @param {ChatRepository} repository - Repository under test.
 * @param {string} role - Message role.
 * @param {string} content - Message text.
 * @param {Object} [extra] - Further message fields.
 * @returns {Promise<Object>} The stored message.
 */
async function append(repository, role, content, extra = {}) {
  const result = await repository.appendMessage(CHAT_ID, {
    role,
    content,
    runId: 'run-1',
    ...extra
  });
  return result.message;
}

describe('ChatRepository: chat documents', () => {
  it('creates the documented chat document, owned by the run principal', async () => {
    await withRepository(async ({ repository, provider }) => {
      const chat = await seedChat(repository);

      assert.equal(chat.id, CHAT_ID);
      assert.equal(chat.ownerId, OWNER);
      assert.equal(chat.identityMode, 'default');
      assert.equal(chat.appId, 'chat');
      assert.equal(chat.modelId, 'gpt-4o');
      assert.equal(chat.title, '');
      assert.equal(chat.messageCount, 0);
      assert.equal(chat.activeRunId, null);
      assert.equal(chat.hasUnseenActivity, false);
      assert.equal(chat.status, 'active');
      assert.deepEqual(chat.runIds, []);
      assert.ok(Number.isFinite(Date.parse(chat.createdAt)));
      assert.equal(chat.lastMessageAt, chat.createdAt);

      // The owner has to be on the *document*, not only in its body: the
      // owner-scoped list is served from the store's index, not from a scan.
      const doc = await provider.documents.get(CHATS_NS, CHAT_ID);
      assert.equal(doc.ownerId, OWNER);
      assert.ok(await repository.getChat(CHAT_ID), 'the chat reads back through the repository');
    });
  });

  it('returns an existing chat untouched and never re-owns it', async () => {
    await withRepository(async ({ repository }) => {
      const created = await seedChat(repository);
      const again = await repository.ensureChat({
        chatId: CHAT_ID,
        ownerId: OTHER_OWNER,
        identityMode: 'full',
        appId: 'other-app'
      });

      assert.equal(again.ownerId, OWNER, 'ensureChat must not hand a chat to a new owner');
      assert.equal(again.identityMode, 'default');
      assert.equal(again.appId, 'chat');
      assert.equal(again.createdAt, created.createdAt);
    });
  });

  it('patches metadata while protecting identity and the owner index', async () => {
    await withRepository(async ({ repository }) => {
      const created = await seedChat(repository);
      const patched = await repository.updateChat(CHAT_ID, {
        id: 'chat-hijacked',
        ownerId: OTHER_OWNER,
        identityMode: 'full',
        createdAt: '1999-01-01T00:00:00.000Z',
        modelId: 'gpt-4o-mini',
        status: 'running',
        activeRunId: 'run-7'
      });

      assert.equal(patched.id, CHAT_ID);
      assert.equal(patched.ownerId, OWNER);
      assert.equal(patched.identityMode, 'default');
      assert.equal(patched.createdAt, created.createdAt);
      assert.equal(patched.modelId, 'gpt-4o-mini');
      assert.equal(patched.status, 'running');
      // A run that was ever active is a run the delete cascade owes the ledger,
      // whether or not it produced a message.
      assert.deepEqual(patched.runIds, ['run-7']);
    });
  });

  it('clears the unseen mark', async () => {
    await withRepository(async ({ repository }) => {
      await seedChat(repository);
      await repository.updateChat(CHAT_ID, { hasUnseenActivity: true });
      assert.equal((await repository.getChat(CHAT_ID)).hasUnseenActivity, true);

      const cleared = await repository.clearUnseen(CHAT_ID);
      assert.equal(cleared.hasUnseenActivity, false);
      assert.equal((await repository.getChat(CHAT_ID)).hasUnseenActivity, false);
    });
  });

  it('updates and clears nothing for a chat that does not exist', async () => {
    await withRepository(async ({ repository }) => {
      assert.equal(await repository.getChat('chat-missing'), null);
      assert.equal(await repository.updateChat('chat-missing', { status: 'error' }), null);
      assert.equal(await repository.clearUnseen('chat-missing'), null);
    });
  });
});

describe('ChatRepository: messages', () => {
  it('mints a server id, keeps the client exchange id and updates the chat', async () => {
    await withRepository(async ({ repository, provider }) => {
      await seedChat(repository);
      const { message, messages } = await repository.appendMessage(CHAT_ID, {
        role: 'user',
        content: 'Hello',
        runId: 'run-1',
        messageId: 'client-7'
      });

      assert.match(message.id, /^[0-9a-f]{8}-[0-9a-f]{4}-/, 'the id is server-minted');
      assert.notEqual(message.id, 'client-7');
      assert.equal(message.clientMessageId, 'client-7', 'an optimistic render can be reconciled');
      assert.equal(message.role, 'user');
      assert.equal(message.content, 'Hello');
      assert.equal(message.runId, 'run-1');
      assert.ok(Number.isFinite(Date.parse(message.ts)));
      assert.deepEqual(messages, [message]);

      const stored = await repository.getMessages(CHAT_ID);
      assert.equal(stored.version, 1);
      assert.deepEqual(stored.messages, [message]);

      const doc = await provider.documents.get(CHAT_MESSAGES_NS, CHAT_ID);
      assert.equal(doc.ownerId, OWNER, 'the transcript carries the chat owner');

      const chat = await repository.getChat(CHAT_ID);
      assert.equal(chat.messageCount, 1);
      assert.equal(chat.lastMessageAt, message.ts);
      assert.deepEqual(chat.runIds, ['run-1']);
    });
  });

  it('carries usage, an error and attachments through unchanged', async () => {
    await withRepository(async ({ repository }) => {
      await seedChat(repository);
      const usage = { promptTokens: 12, completionTokens: 4, totalTokens: 16 };
      const error = { code: 'ABORTED', message: 'Turn stopped before it finished.' };
      const attachments = [{ type: 'image/png', name: 'chart.png', bytes: 900 }];
      const message = await append(repository, 'assistant', 'Partial', {
        usage,
        error,
        attachments,
        finishReason: 'connection_closed'
      });

      const [stored] = (await repository.getMessages(CHAT_ID)).messages;
      assert.deepEqual(stored.usage, usage);
      assert.deepEqual(stored.error, error);
      assert.deepEqual(stored.attachments, attachments);
      assert.equal(stored.finishReason, 'connection_closed');
      assert.equal(message.id, stored.id);
    });
  });

  it('refuses to append to a chat that was never created', async () => {
    await withRepository(async ({ repository, lines }) => {
      const result = await repository.appendMessage('chat-missing', {
        role: 'user',
        content: 'Hello'
      });

      assert.equal(result, null);
      assert.ok(
        lines.some(line => line.level === 'warn'),
        'an orphan append must be loud, not silent'
      );
    });
  });

  it('reads an empty transcript for a chat with no messages', async () => {
    await withRepository(async ({ repository }) => {
      await seedChat(repository);
      assert.deepEqual(await repository.getMessages(CHAT_ID), { version: 1, messages: [] });
    });
  });
});

describe('ChatRepository: the message cap', () => {
  it('drops the oldest messages once a chat is over its cap', async () => {
    // A transcript is one document: every append rewrites, re-serializes and
    // re-hashes the whole thing, and opening the chat ships all of it back.
    // Prompt replay usually makes a chat unusable long before that matters —
    // but an app with `sendChatHistory: false` has no such backstop, so its
    // chats grow for as long as somebody keeps typing, with nothing pushing
    // back.
    await withRepository(async ({ provider }) => {
      const { logger } = recordingLogger();
      const repository = new ChatRepository({
        documents: provider.documents,
        locks: provider.locks,
        logger,
        maxMessages: 3
      });
      await seedChat(repository);

      for (const n of [1, 2, 3, 4, 5]) {
        await repository.appendMessage(CHAT_ID, { role: 'user', content: `m${n}` });
      }

      const stored = await repository.getMessages(CHAT_ID);
      assert.deepEqual(
        stored.messages.map(entry => entry.content),
        ['m3', 'm4', 'm5'],
        'the oldest go, so the conversation stays readable from where the reader is'
      );
      // The trim happens after the insert, so the message being written is
      // never the one dropped — a cap of 1 would otherwise store nothing.
      assert.equal(stored.messages.at(-1).content, 'm5');
    });
  });

  it('caps how long one stored message may be, and says it did', async () => {
    // The other user-controlled quantity on this path, and the one with no
    // bound. A transcript is a single document, so one oversized message makes
    // every later turn on that chat read, re-serialize and re-hash it under the
    // chat's lock — and nothing reclaims it, because retention is age and chat
    // count, and `microcompactMessages` deliberately skips user messages.
    await withRepository(async ({ repository }) => {
      await seedChat(repository);
      const huge = 'x'.repeat(MAX_MESSAGE_CHARS + 500);

      const { message } = await repository.appendMessage(CHAT_ID, {
        role: 'user',
        content: huge
      });

      assert.equal(message.content.length, MAX_MESSAGE_CHARS);
      assert.deepEqual(message.truncated, {
        at: MAX_MESSAGE_CHARS,
        originalLength: huge.length
      });

      const stored = await repository.getMessages(CHAT_ID);
      assert.equal(stored.messages.at(-1).content.length, MAX_MESSAGE_CHARS);
    });
  });

  it('leaves an ordinary message alone, and says nothing about it', async () => {
    await withRepository(async ({ repository }) => {
      await seedChat(repository);

      const { message } = await repository.appendMessage(CHAT_ID, {
        role: 'user',
        content: 'a question of a normal size'
      });

      assert.equal(message.content, 'a question of a normal size');
      assert.equal(message.truncated, undefined);
    });
  });

  it('keeps everything when the cap is disabled', async () => {
    await withRepository(async ({ provider }) => {
      const { logger } = recordingLogger();
      const repository = new ChatRepository({
        documents: provider.documents,
        locks: provider.locks,
        logger,
        maxMessages: 0
      });
      await seedChat(repository);
      for (const n of [1, 2, 3, 4]) {
        await repository.appendMessage(CHAT_ID, { role: 'user', content: `m${n}` });
      }

      assert.equal(
        (await repository.getMessages(CHAT_ID)).messages.length,
        4,
        'zero means "no cap", the same as every other retention rule'
      );
    });
  });
});

describe('ChatRepository: title derivation', () => {
  it('names the chat after its first user message, whitespace collapsed', async () => {
    await withRepository(async ({ repository }) => {
      await seedChat(repository);
      await append(repository, 'user', '  Plan\n\tthe   offsite  ');

      assert.equal((await repository.getChat(CHAT_ID)).title, 'Plan the offsite');
    });
  });

  it('cuts a long first message to 80 characters with an ellipsis', async () => {
    await withRepository(async ({ repository }) => {
      await seedChat(repository);
      await append(repository, 'user', 'w'.repeat(500));

      const { title } = await repository.getChat(CHAT_ID);
      assert.equal(title.length, 80);
      assert.ok(title.endsWith('…'));
    });
  });

  it('does not rename the chat on every later message', async () => {
    await withRepository(async ({ repository }) => {
      await seedChat(repository);
      await append(repository, 'user', 'First question');
      await append(repository, 'assistant', 'First answer');
      await append(repository, 'user', 'Second question');

      assert.equal((await repository.getChat(CHAT_ID)).title, 'First question');
    });
  });

  it('never derives over a title the user set', async () => {
    await withRepository(async ({ repository }) => {
      await seedChat(repository);
      const renamed = await repository.renameChat(CHAT_ID, 'Quarterly planning');
      assert.equal(renamed.title, 'Quarterly planning');
      assert.equal(renamed.titleSetByUser, true);

      await append(repository, 'user', 'Something else entirely');
      assert.equal((await repository.getChat(CHAT_ID)).title, 'Quarterly planning');
    });
  });

  it('caps a rename at 200 characters and leaves a missing chat alone', async () => {
    await withRepository(async ({ repository }) => {
      await seedChat(repository);
      const renamed = await repository.renameChat(CHAT_ID, 'y'.repeat(900));

      assert.equal(renamed.title.length, 200);
      assert.equal(await repository.renameChat('chat-missing', 'Nope'), null);
    });
  });

  it('leaves an assistant-only chat untitled', async () => {
    await withRepository(async ({ repository }) => {
      await seedChat(repository);
      await append(repository, 'assistant', 'Unprompted greeting');

      assert.equal((await repository.getChat(CHAT_ID)).title, '');
    });
  });
});

describe('ChatRepository: replaceFromMessageId truncates and forks', () => {
  it('drops the named message and everything after it before appending', async () => {
    await withRepository(async ({ repository }) => {
      await seedChat(repository);
      const first = await append(repository, 'user', 'first');
      const firstAnswer = await append(repository, 'assistant', 'first answer');
      const second = await append(repository, 'user', 'second');
      const secondAnswer = await append(repository, 'assistant', 'second answer');

      const forked = await repository.appendMessage(
        CHAT_ID,
        { role: 'user', content: 'second, rephrased', runId: 'run-2' },
        { replaceFromMessageId: second.id }
      );

      assert.deepEqual(
        forked.messages.map(entry => entry.content),
        ['first', 'first answer', 'second, rephrased']
      );
      assert.notEqual(forked.message.id, second.id, 'the fork is a new message, not an edit');

      // The truncation is durable, not just a shape in the return value.
      const stored = await repository.getMessages(CHAT_ID);
      assert.deepEqual(
        stored.messages.map(entry => entry.id),
        [first.id, firstAnswer.id, forked.message.id]
      );
      assert.equal(
        stored.messages.some(entry => entry.id === second.id),
        false
      );
      assert.equal(
        stored.messages.some(entry => entry.id === secondAnswer.id),
        false
      );

      const chat = await repository.getChat(CHAT_ID);
      assert.equal(chat.messageCount, 3);
      assert.equal(chat.lastMessageAt, forked.message.ts);
      assert.deepEqual(chat.runIds, ['run-1', 'run-2']);
    });
  });

  it('forking from the very first message leaves only the new one', async () => {
    await withRepository(async ({ repository }) => {
      await seedChat(repository);
      const first = await append(repository, 'user', 'first');
      await append(repository, 'assistant', 'first answer');

      const forked = await repository.appendMessage(
        CHAT_ID,
        { role: 'user', content: 'let us start over', runId: 'run-2' },
        { replaceFromMessageId: first.id }
      );

      assert.equal(forked.messages.length, 1);
      assert.equal(forked.messages[0].content, 'let us start over');
      assert.equal((await repository.getChat(CHAT_ID)).messageCount, 1);
    });
  });

  it('keeps appending onto the forked history afterwards', async () => {
    await withRepository(async ({ repository }) => {
      await seedChat(repository);
      await append(repository, 'user', 'first');
      const answer = await append(repository, 'assistant', 'first answer');
      await repository.appendMessage(
        CHAT_ID,
        { role: 'user', content: 'first, rephrased', runId: 'run-2' },
        { replaceFromMessageId: answer.id }
      );
      await append(repository, 'assistant', 'better answer', { runId: 'run-2' });

      const stored = await repository.getMessages(CHAT_ID);
      assert.deepEqual(
        stored.messages.map(entry => entry.content),
        ['first', 'first, rephrased', 'better answer']
      );
    });
  });

  it('rejects an unknown id instead of appending onto the full history', async () => {
    await withRepository(async ({ repository }) => {
      await seedChat(repository);
      await append(repository, 'user', 'first');
      await append(repository, 'assistant', 'first answer');

      await assert.rejects(
        () =>
          repository.appendMessage(
            CHAT_ID,
            { role: 'user', content: 'fork me', runId: 'run-2' },
            { replaceFromMessageId: 'no-such-message' }
          ),
        error => error instanceof StorageError && error.code === 'UNKNOWN_MESSAGE'
      );

      const stored = await repository.getMessages(CHAT_ID);
      assert.equal(stored.messages.length, 2, 'a rejected fork writes nothing at all');
      assert.equal((await repository.getChat(CHAT_ID)).messageCount, 2);
    });
  });

  it('treats a client exchange id as unknown — only stored ids can be forked', async () => {
    await withRepository(async ({ repository }) => {
      await seedChat(repository);
      await append(repository, 'user', 'first', { messageId: 'client-7' });

      await assert.rejects(
        () =>
          repository.appendMessage(
            CHAT_ID,
            { role: 'user', content: 'fork me', runId: 'run-2' },
            { replaceFromMessageId: 'client-7' }
          ),
        error => error instanceof StorageError && error.code === 'UNKNOWN_MESSAGE'
      );
    });
  });
});

describe('ChatRepository: concurrent appends', () => {
  it('loses no message when one repository appends five times at once', async () => {
    await withRepository(async ({ repository }) => {
      await seedChat(repository);
      const sent = ['m1', 'm2', 'm3', 'm4', 'm5'];

      await Promise.all(
        sent.map(content =>
          repository.appendMessage(CHAT_ID, { role: 'user', content, runId: 'run-1' })
        )
      );

      const stored = await repository.getMessages(CHAT_ID);
      assert.deepEqual([...stored.messages.map(entry => entry.content)].sort(), sent);
      assert.equal(new Set(stored.messages.map(entry => entry.id)).size, sent.length);
      assert.equal((await repository.getChat(CHAT_ID)).messageCount, sent.length);
    });
  });

  it('loses no message when two workers share one volume', async () => {
    await withTwoRepositories(async (first, second) => {
      await seedChat(first.repository);

      await Promise.all([
        first.repository.appendMessage(CHAT_ID, { role: 'user', content: 'a', runId: 'run-1' }),
        second.repository.appendMessage(CHAT_ID, { role: 'user', content: 'b', runId: 'run-2' }),
        first.repository.appendMessage(CHAT_ID, { role: 'user', content: 'c', runId: 'run-1' }),
        second.repository.appendMessage(CHAT_ID, { role: 'user', content: 'd', runId: 'run-2' })
      ]);

      const stored = await second.repository.getMessages(CHAT_ID);
      assert.deepEqual([...stored.messages.map(entry => entry.content)].sort(), [
        'a',
        'b',
        'c',
        'd'
      ]);
      const chat = await first.repository.getChat(CHAT_ID);
      assert.equal(chat.messageCount, 4);
      assert.deepEqual([...chat.runIds].sort(), ['run-1', 'run-2']);
    });
  });
});

describe('ChatRepository: delete', () => {
  it('removes both documents and reports the runs to cascade into', async () => {
    await withRepository(async ({ repository, provider }) => {
      await seedChat(repository);
      await repository.updateChat(CHAT_ID, { activeRunId: 'run-a' });
      await append(repository, 'user', 'hello', { runId: 'run-b' });

      const result = await repository.deleteChat(CHAT_ID);
      assert.equal(result.deleted, true);
      assert.deepEqual([...result.runIds].sort(), ['run-a', 'run-b']);

      assert.equal(await provider.documents.get(CHATS_NS, CHAT_ID), null);
      assert.equal(await provider.documents.get(CHAT_MESSAGES_NS, CHAT_ID), null);
      assert.equal(await repository.getChat(CHAT_ID), null);
      assert.deepEqual(await repository.getMessages(CHAT_ID), { version: 1, messages: [] });
    });
  });

  it('a delete that fails partway leaves the chat findable, not an invisible transcript', async () => {
    // Two non-transactional writes. Removing the index first meant a failure
    // between them stranded the full verbatim transcript with nothing
    // pointing at it: `chat-messages` is never enumerated anywhere, so the
    // list, the retention sweep and a retried delete all missed it — while
    // the user had been told the chat was erased.
    await withRepository(async ({ repository, provider }) => {
      await seedChat(repository);
      // A transcript to orphan: without one the assertion below is vacuous,
      // which is exactly how the first version of this test passed against
      // the order it was written to reject.
      await repository.appendMessage(CHAT_ID, {
        role: 'user',
        content: 'something worth not losing',
        runId: 'run-a'
      });
      assert.equal((await repository.getMessages(CHAT_ID)).messages.length, 1);

      const realDelete = provider.documents.delete.bind(provider.documents);
      provider.documents.delete = async (ns, key) => {
        if (ns === CHATS_NS) throw new Error('storage went away mid-delete');
        return realDelete(ns, key);
      };
      try {
        await assert.rejects(() => repository.deleteChat(CHAT_ID));
      } finally {
        provider.documents.delete = realDelete;
      }

      assert.ok(
        await repository.getChat(CHAT_ID),
        'the chat is still listable, so the delete can be retried'
      );
      assert.deepEqual(
        (await repository.getMessages(CHAT_ID)).messages,
        [],
        'and the transcript is already gone rather than orphaned'
      );
      assert.equal((await repository.deleteChat(CHAT_ID)).deleted, true, 'the retry finishes it');
    });
  });

  it('deleting twice is not an error and reports nothing to cascade', async () => {
    await withRepository(async ({ repository }) => {
      await seedChat(repository);
      await repository.deleteChat(CHAT_ID);

      assert.deepEqual(await repository.deleteChat(CHAT_ID), { deleted: false, runIds: [] });
    });
  });
});

describe('ChatRepository: listing', () => {
  /**
   * Create `count` chats for `ownerId`, each one day older than the last.
   *
   * @param {ChatRepository} repository - Repository under test.
   * @param {string} ownerId - Owning principal.
   * @param {number} count - How many chats to create.
   * @param {string} prefix - Chat id prefix.
   * @returns {Promise<string[]>} The ids, newest first.
   */
  async function seedTimeline(repository, ownerId, count, prefix) {
    const ids = [];
    for (let index = 0; index < count; index += 1) {
      const chatId = `${prefix}-${index}`;
      await repository.ensureChat({ chatId, ownerId, identityMode: 'default' });
      await repository.updateChat(chatId, {
        lastMessageAt: new Date(Date.UTC(2026, 0, 1) + index * DAY_MS).toISOString()
      });
      ids.unshift(chatId);
    }
    return ids;
  }

  it('lists an owner in last-activity order and never shows another owner', async () => {
    await withRepository(async ({ repository }) => {
      const mine = await seedTimeline(repository, OWNER, 3, 'mine');
      await seedTimeline(repository, OTHER_OWNER, 2, 'theirs');

      const page = await repository.listChats(OWNER);
      assert.deepEqual(
        page.items.map(chat => chat.id),
        mine
      );
      assert.equal(page.nextCursor, null);
      assert.equal(await repository.countChats(OWNER), 3);
      assert.equal(await repository.countChats(OTHER_OWNER), 2);
    });
  });

  it('pages without gaps or repeats', async () => {
    await withRepository(async ({ repository }) => {
      const mine = await seedTimeline(repository, OWNER, 5, 'mine');

      const first = await repository.listChats(OWNER, { limit: 2 });
      assert.equal(first.items.length, 2);
      assert.ok(first.nextCursor);

      const second = await repository.listChats(OWNER, { limit: 2, cursor: first.nextCursor });
      const third = await repository.listChats(OWNER, { limit: 2, cursor: second.nextCursor });

      const seen = [...first.items, ...second.items, ...third.items].map(chat => chat.id);
      assert.deepEqual(seen, mine);
      assert.equal(third.nextCursor, null);
    });
  });

  it('rejects a cursor it did not issue rather than restarting the listing', async () => {
    await withRepository(async ({ repository }) => {
      await seedTimeline(repository, OWNER, 2, 'mine');

      await assert.rejects(
        () => repository.listChats(OWNER, { cursor: 'not-a-cursor' }),
        error => error instanceof StorageError && error.code === 'INVALID_CURSOR'
      );
    });
  });

  it('lists nothing for an owner with no chats and for a missing owner', async () => {
    await withRepository(async ({ repository }) => {
      await seedTimeline(repository, OWNER, 1, 'mine');

      assert.deepEqual(await repository.listChats('nobody'), { items: [], nextCursor: null });
      assert.deepEqual(await repository.listChats(''), { items: [], nextCursor: null });
      assert.equal(await repository.countChats('nobody'), 0);
    });
  });

  it('past the owner ceiling it loads the lowest keys, which is not the newest', async () => {
    // The documented behaviour, pinned so the docs and the code cannot drift
    // apart again: `DocumentStore.list` is ascending by key and the walk stops
    // at 1000, so an owner over the ceiling loses an arbitrary uuid-ordered
    // slice — NOT their oldest chats. A stub store stands in for 1100 real
    // documents; what is under test is the repository's paging loop, not the
    // provider, which the conformance suite covers.
    const total = 1100;
    const docs = Array.from({ length: total }, (_, index) => ({
      key: `chat-${String(index).padStart(4, '0')}`,
      ownerId: OWNER,
      // Newest activity on the HIGHEST keys, so a listing that respected
      // recency and one that respects key order cannot be confused.
      data: {
        ownerId: OWNER,
        lastMessageAt: new Date(Date.UTC(2026, 0, 1) + index * DAY_MS).toISOString()
      }
    }));
    const documents = {
      async list(_namespace, { limit = 200, cursor = null } = {}) {
        const from = cursor ? Number(cursor) : 0;
        const items = docs.slice(from, from + limit);
        const next = from + items.length;
        return { items, nextCursor: next < docs.length ? String(next) : null };
      }
    };
    const { logger } = recordingLogger();
    const repository = new ChatRepository({ documents, locks: {}, logger });

    const page = await repository.listChats(OWNER, { limit: 100 });

    assert.equal(page.items[0].id, 'chat-0999', 'the newest chat the walk reached, not chat-1099');
    const loaded = new Set(page.items.map(chat => chat.id));
    assert.equal(loaded.has('chat-1099'), false, 'the genuinely newest chat is invisible');
  });
});

describe('ChatRepository: releasing a run', () => {
  it('applies the patch while the run still owns the chat', async () => {
    await withRepository(async ({ repository }) => {
      await repository.ensureChat({ chatId: CHAT_ID, ownerId: OWNER, identityMode: 'default' });
      await repository.updateChat(CHAT_ID, { activeRunId: 'run-1', status: 'running' });

      const { chat, released } = await repository.releaseRun(CHAT_ID, 'run-1', {
        activeRunId: null,
        status: 'active'
      });

      assert.equal(released, true);
      assert.equal(chat.activeRunId, null);
      assert.equal(chat.status, 'active');
    });
  });

  it('leaves the chat alone when another run has taken it over', async () => {
    await withRepository(async ({ repository }) => {
      // Turn 2 superseded turn 1 and is still generating; turn 1's teardown
      // must not announce the chat idle underneath it.
      await repository.ensureChat({ chatId: CHAT_ID, ownerId: OWNER, identityMode: 'default' });
      await repository.updateChat(CHAT_ID, { activeRunId: 'run-2', status: 'running' });

      const { chat, released } = await repository.releaseRun(CHAT_ID, 'run-1', {
        activeRunId: null,
        status: 'error',
        hasUnseenActivity: true
      });

      assert.equal(released, false);
      assert.equal(chat.activeRunId, 'run-2');
      assert.equal(chat.status, 'running');
      assert.equal((await repository.getChat(CHAT_ID)).activeRunId, 'run-2');
    });
  });

  it('reports a missing chat the same way updateChat does', async () => {
    await withRepository(async ({ repository }) => {
      assert.deepEqual(await repository.releaseRun('chat-gone', 'run-1', { status: 'active' }), {
        chat: null,
        released: false
      });
    });

    const { logger } = recordingLogger();
    const unavailable = new ChatRepository({ logger });
    assert.deepEqual(await unavailable.releaseRun(CHAT_ID, 'run-1', {}), {
      chat: null,
      released: false
    });
  });
});

describe('ChatRepository: insertAfterRunId', () => {
  it('is a plain append when the run wrote the last message', async () => {
    await withRepository(async ({ repository }) => {
      await repository.ensureChat({ chatId: CHAT_ID, ownerId: OWNER, identityMode: 'default' });
      await repository.appendMessage(CHAT_ID, { role: 'user', content: 'q', runId: 'run-1' });

      const { messages } = await repository.appendMessage(
        CHAT_ID,
        { role: 'assistant', content: 'a', runId: 'run-1' },
        { insertAfterRunId: 'run-1' }
      );

      assert.deepEqual(
        messages.map(entry => entry.content),
        ['q', 'a']
      );
    });
  });

  it('places the answer of a superseded run with its own question, not at the end', async () => {
    await withRepository(async ({ repository }) => {
      await repository.ensureChat({ chatId: CHAT_ID, ownerId: OWNER, identityMode: 'default' });
      await repository.appendMessage(CHAT_ID, { role: 'user', content: 'q1', runId: 'run-1' });
      await repository.appendMessage(CHAT_ID, { role: 'user', content: 'q2', runId: 'run-2' });

      const { messages } = await repository.appendMessage(
        CHAT_ID,
        { role: 'assistant', content: 'a1', runId: 'run-1' },
        { insertAfterRunId: 'run-1' }
      );

      assert.deepEqual(
        messages.map(entry => entry.content),
        ['q1', 'a1', 'q2'],
        'appending would interleave the two exchanges for good'
      );
      assert.equal((await repository.getChat(CHAT_ID)).messageCount, 3);
    });
  });

  it('appends when the run has no message to sit behind', async () => {
    await withRepository(async ({ repository }) => {
      await repository.ensureChat({ chatId: CHAT_ID, ownerId: OWNER, identityMode: 'default' });
      await repository.appendMessage(CHAT_ID, { role: 'user', content: 'q1', runId: 'run-1' });

      const { messages } = await repository.appendMessage(
        CHAT_ID,
        { role: 'assistant', content: 'orphan', runId: 'run-9' },
        { insertAfterRunId: 'run-9' }
      );

      assert.deepEqual(
        messages.map(entry => entry.content),
        ['q1', 'orphan']
      );
    });
  });
});

describe('ChatRepository: degraded modes', () => {
  it('is a no-op in every method when storage is unavailable', async () => {
    const { logger } = recordingLogger();
    const repository = new ChatRepository({ logger });

    assert.equal(repository.isAvailable(), false);
    assert.equal(await repository.getChat(CHAT_ID), null);
    assert.equal(await repository.ensureChat({ chatId: CHAT_ID, ownerId: OWNER }), null);
    assert.equal(await repository.updateChat(CHAT_ID, { status: 'error' }), null);
    assert.equal(await repository.renameChat(CHAT_ID, 'Nope'), null);
    assert.equal(await repository.clearUnseen(CHAT_ID), null);
    assert.equal(await repository.appendMessage(CHAT_ID, { role: 'user', content: 'x' }), null);
    assert.deepEqual(await repository.getMessages(CHAT_ID), { version: 1, messages: [] });
    assert.deepEqual(await repository.listChats(OWNER), { items: [], nextCursor: null });
    assert.equal(await repository.countChats(OWNER), 0);
    assert.deepEqual(await repository.deleteChat(CHAT_ID), { deleted: false, runIds: [] });
  });

  it('a document facet on its own is not enough — an unlocked write is data loss', async () => {
    await withRepository(async ({ provider }) => {
      const { logger } = recordingLogger();
      const halfWired = new ChatRepository({ documents: provider.documents, logger });

      assert.equal(halfWired.isAvailable(), false);
      assert.equal(await halfWired.ensureChat({ chatId: CHAT_ID, ownerId: OWNER }), null);
    });
  });

  it('skips a chat id the store cannot key, without writing anything', async () => {
    await withRepository(async ({ repository, provider }) => {
      // Headless invocations mint `agent:<parentRunId>:<hex>`; a colon is not a
      // usable document key, so such a chat is legal but has no durable form.
      const agentChatId = 'agent:run-9:ab12';

      assert.equal(await repository.ensureChat({ chatId: agentChatId, ownerId: OWNER }), null);
      assert.equal(await repository.getChat(agentChatId), null);
      assert.equal(await repository.appendMessage(agentChatId, { role: 'user' }), null);
      assert.deepEqual(await repository.deleteChat(agentChatId), { deleted: false, runIds: [] });
      assert.deepEqual(await provider.documents.list(CHATS_NS), { items: [], nextCursor: null });
    });
  });
});

describe('ChatRepository: what a listing costs', () => {
  it('does not reload the owner every page, but does after a write', async () => {
    // `listChats` has no stored order by `lastMessageAt`, so it loads the
    // owner's chats and sorts in memory — and its cursor is a position in that
    // sort, not a store cursor, so every page repeated the whole load. Page
    // seven of a 200-chat owner cost 1400 document reads, and the sidebar
    // invalidates its list after every completed turn.
    await withRepository(async ({ provider }) => {
      let listCalls = 0;
      const documents = Object.create(provider.documents);
      documents.list = (...args) => {
        listCalls += 1;
        return provider.documents.list(...args);
      };
      const repository = new ChatRepository({
        documents,
        locks: provider.locks,
        logger: recordingLogger().logger
      });

      for (const n of [1, 2, 3, 4]) {
        await repository.ensureChat({ chatId: `chat-page-${n}`, ownerId: OWNER, appId: 'chat' });
      }

      listCalls = 0;
      const first = await repository.listChats(OWNER, { limit: 2 });
      const afterFirst = listCalls;
      assert.ok(afterFirst > 0, 'the first page loads the owner');

      await repository.listChats(OWNER, { limit: 2, cursor: first.nextCursor });
      assert.equal(listCalls, afterFirst, 'the next page is served from what the first loaded');

      // A write this process made has to be visible to its own next read: the
      // client sends a turn and reloads the list, and answering that from the
      // snapshot would show a chat under its old title or one it just deleted.
      await repository.renameChat('chat-page-1', 'renamed');
      const renamed = await repository.listChats(OWNER, { limit: 10 });
      assert.ok(listCalls > afterFirst, 'the memo was dropped by the write');
      assert.ok(
        renamed.items.some(chat => chat.title === 'renamed'),
        'and the listing shows it'
      );
    });
  });
});

describe('ChatRepository: the delete cascade of a long chat', () => {
  it('reports every run, not just the newest the chat document can hold', async () => {
    // One run is minted per turn and the chat document keeps only the newest
    // `MAX_TRACKED_RUN_IDS`. The overflow used to be dropped, so a chat with
    // more turns than that left ledger runs behind — each holding the verbatim
    // question and the streamed answer — while the UI said the conversation
    // was removed for good. "They age out of the ledger's own retention" is not
    // an answer either: `runLog.cleanupEnabled: false` is supported, and the
    // two retentions are deliberately independent.
    await withRepository(async ({ repository }) => {
      await seedChat(repository);

      const turns = MAX_TRACKED_RUN_IDS + 25;
      for (let n = 0; n < turns; n += 1) {
        await repository.appendMessage(CHAT_ID, {
          role: 'user',
          content: `turn ${n}`,
          runId: `run-${String(n).padStart(4, '0')}`
        });
      }

      const chat = await repository.getChat(CHAT_ID);
      assert.equal(chat.runIds.length, MAX_TRACKED_RUN_IDS, 'the chat document stays capped');
      assert.ok(!chat.runIds.includes('run-0000'), 'and the oldest is no longer on it');

      const { runIds } = await repository.deleteChat(CHAT_ID);
      assert.equal(runIds.length, turns, 'but the cascade is owed all of them');
      assert.ok(runIds.includes('run-0000'), 'including the very first');
      assert.ok(runIds.includes(`run-${String(turns - 1).padStart(4, '0')}`), 'and the last');
      assert.equal(new Set(runIds).size, runIds.length, 'with no id reported twice');
    });
  });

  it('keeps the overflow out of what a client reads back', async () => {
    await withRepository(async ({ repository }) => {
      await seedChat(repository);
      for (let n = 0; n < MAX_TRACKED_RUN_IDS + 2; n += 1) {
        await repository.appendMessage(CHAT_ID, {
          role: 'user',
          content: `turn ${n}`,
          runId: `run-${String(n).padStart(4, '0')}`
        });
      }

      const stored = await repository.getMessages(CHAT_ID);
      assert.deepEqual(Object.keys(stored).sort(), ['messages', 'version']);
    });
  });
});
