/**
 * `chatMaterializer` — the only module that writes chat turns — driven against
 * a real `ChatRepository` over a real filesystem storage provider.
 *
 * A turn is two writes at two moments: the human half when the ledger run
 * starts, the assistant half at the single choke point before it ends. What
 * matters is what is on disk afterwards, so nothing below the materializer is
 * faked. The one exception is the pair of failure tests, which subclass the
 * repository to make a single method throw: the point there is that a storage
 * failure never fails an otherwise fine chat, and there is no portable way to
 * break a real directory (the suite may be running as root).
 *
 * Contract: `CHAT_PERSISTENCE_CONTRACT.md` §6 and §12.
 */
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { FilesystemStorageProvider } from '../storage/providers/filesystem/index.js';
import { ChatRepository } from '../services/chat/ChatRepository.js';
import {
  materializeAssistantTurn,
  materializeUserTurn
} from '../services/chat/chatMaterializer.js';

const OWNER = 'user-1';
const CHAT_ID = 'chat-1';
const RUN_ID = 'chat-run-1';

/**
 * A logger that swallows what it is given, so the repository's own warnings do
 * not drown the runner output.
 *
 * @returns {Object}
 */
function quietLogger() {
  const noop = () => {};
  return { debug: noop, info: noop, warn: noop, error: noop };
}

/**
 * Run `fn` with a repository over a scratch directory of its own.
 *
 * @param {(ctx: {repository: ChatRepository, provider: Object}) => Promise<void>} fn - Test body.
 * @returns {Promise<void>}
 */
async function withRepository(fn) {
  const baseDir = await fs.mkdtemp(path.join(os.tmpdir(), 'ihub-chat-mat-'));
  const provider = new FilesystemStorageProvider({ baseDir, flushIntervalMs: 25 });
  await provider.initialize();
  const repository = new ChatRepository({
    documents: provider.documents,
    locks: provider.locks,
    logger: quietLogger()
  });
  try {
    await fn({ repository, provider });
  } finally {
    await provider.shutdown();
    await fs.rm(baseDir, { recursive: true, force: true });
  }
}

/**
 * Write the human half of a turn with the defaults these tests share.
 *
 * @param {ChatRepository} repository - Repository under test.
 * @param {Object} [overrides] - Fields to override on the call.
 * @returns {Promise<Object|null>} The stored message.
 */
function userTurn(repository, overrides = {}) {
  return materializeUserTurn({
    repository,
    chatId: CHAT_ID,
    ownerId: OWNER,
    identityMode: 'default',
    appId: 'chat',
    modelId: 'gpt-4o',
    runId: RUN_ID,
    content: 'How do I rotate the signing key?',
    ...overrides
  });
}

/**
 * Write the assistant half of a turn with the defaults these tests share.
 *
 * @param {ChatRepository} repository - Repository under test.
 * @param {Object} [summary] - Turn outcome.
 * @param {boolean} [clientConnected=true] - Whether an SSE client was attached.
 * @returns {Promise<Object|null>} The stored message.
 */
function assistantTurn(repository, summary = {}, clientConnected = true) {
  return materializeAssistantTurn({
    repository,
    chatId: CHAT_ID,
    runId: RUN_ID,
    summary: { status: 'success', content: 'Run the rotate script.', ...summary },
    clientConnected
  });
}

describe('chatMaterializer: a complete turn', () => {
  it('the user half creates the chat, marks it busy and stores the message', async () => {
    await withRepository(async ({ repository }) => {
      const message = await userTurn(repository, {
        content: '  Rotate   the\nsigning key  ',
        clientMessageId: 'client-7'
      });

      assert.equal(message.role, 'user');
      assert.equal(message.content, '  Rotate   the\nsigning key  ', 'stored verbatim');
      assert.equal(message.clientMessageId, 'client-7');
      assert.equal(message.runId, RUN_ID);
      assert.ok(Number.isFinite(Date.parse(message.ts)));

      const chat = await repository.getChat(CHAT_ID);
      assert.equal(chat.ownerId, OWNER);
      assert.equal(chat.identityMode, 'default');
      assert.equal(chat.appId, 'chat');
      assert.equal(chat.modelId, 'gpt-4o');
      assert.equal(chat.status, 'running');
      assert.equal(chat.activeRunId, RUN_ID);
      assert.equal(chat.messageCount, 1);
      assert.equal(chat.title, 'Rotate the signing key');
      assert.equal(chat.hasUnseenActivity, false, 'the sender is demonstrably present');
      assert.deepEqual(chat.runIds, [RUN_ID]);
    });
  });

  it('the assistant half stores the answer and releases the chat', async () => {
    await withRepository(async ({ repository }) => {
      await userTurn(repository);
      const answer = await assistantTurn(repository, {
        finishReason: 'stop',
        usage: { promptTokens: 40, completionTokens: 12, totalTokens: 52 }
      });

      assert.equal(answer.role, 'assistant');
      assert.equal(answer.content, 'Run the rotate script.');
      assert.equal(answer.runId, RUN_ID);
      assert.equal(answer.finishReason, 'stop');
      assert.deepEqual(answer.usage, { promptTokens: 40, completionTokens: 12, totalTokens: 52 });
      assert.equal('error' in answer, false);

      const chat = await repository.getChat(CHAT_ID);
      assert.equal(chat.status, 'active');
      assert.equal(chat.activeRunId, null);
      assert.equal(chat.messageCount, 2);
      assert.equal(chat.lastMessageAt, answer.ts);

      const { version, messages } = await repository.getMessages(CHAT_ID);
      assert.equal(version, 1);
      assert.deepEqual(
        messages.map(entry => entry.role),
        ['user', 'assistant']
      );
      assert.deepEqual(
        messages.map(entry => entry.runId),
        [RUN_ID, RUN_ID]
      );
    });
  });

  it('a second turn on the same chat extends the transcript', async () => {
    await withRepository(async ({ repository }) => {
      await userTurn(repository);
      await assistantTurn(repository);
      await userTurn(repository, { runId: 'chat-run-2', content: 'And the old one?' });
      await materializeAssistantTurn({
        repository,
        chatId: CHAT_ID,
        runId: 'chat-run-2',
        summary: { status: 'success', content: 'Revoke it.' },
        clientConnected: true
      });

      const { messages } = await repository.getMessages(CHAT_ID);
      assert.deepEqual(
        messages.map(entry => entry.role),
        ['user', 'assistant', 'user', 'assistant']
      );
      const chat = await repository.getChat(CHAT_ID);
      assert.equal(chat.messageCount, 4);
      assert.deepEqual(chat.runIds, [RUN_ID, 'chat-run-2'], 'both runs are on the cascade list');
      assert.equal(chat.title, 'How do I rotate the signing key?', 'the first message named it');
    });
  });

  it('leaves an auto-started turn untitled and lets the next message name it', async () => {
    await withRepository(async ({ repository }) => {
      await userTurn(repository, { content: '' });
      assert.equal((await repository.getChat(CHAT_ID)).title, '');

      await assistantTurn(repository);
      await userTurn(repository, { runId: 'chat-run-2', content: 'Now a real question' });
      assert.equal((await repository.getChat(CHAT_ID)).title, 'Now a real question');
    });
  });

  it('never derives a title over one the user chose', async () => {
    await withRepository(async ({ repository }) => {
      await userTurn(repository, { content: '' });
      await repository.renameChat(CHAT_ID, 'Key rotation runbook');

      await userTurn(repository, { runId: 'chat-run-2', content: 'Something else' });
      assert.equal((await repository.getChat(CHAT_ID)).title, 'Key rotation runbook');
    });
  });

  it('stores attachment descriptors, never the upload payload', async () => {
    await withRepository(async ({ repository }) => {
      const message = await userTurn(repository, {
        attachments: [
          { type: 'image/png', name: 'chart.png', size: 2048, data: 'AAAAstillbase64AAAA' },
          { fileType: 'application/pdf', fileName: 'spec.pdf', bytes: 9000 },
          null
        ]
      });

      assert.deepEqual(message.attachments, [
        { type: 'image/png', name: 'chart.png', bytes: 2048 },
        { type: 'application/pdf', name: 'spec.pdf', bytes: 9000 }
      ]);
      const serialized = JSON.stringify(await repository.getMessages(CHAT_ID));
      assert.equal(serialized.includes('AAAAstillbase64AAAA'), false);
    });
  });

  it('stores the byte count and mime type of a document upload', async () => {
    await withRepository(async ({ repository }) => {
      // What the chat client actually sends for a file: `type` is the upload
      // kind and the mime type is on `fileType`, with the size on `fileSize`.
      const message = await userTurn(repository, {
        attachments: [
          {
            type: 'document',
            fileName: 'report.pdf',
            fileSize: 4096,
            fileType: 'application/pdf',
            content: 'extracted text'
          }
        ]
      });

      assert.deepEqual(message.attachments, [
        { type: 'application/pdf', name: 'report.pdf', bytes: 4096 }
      ]);
    });
  });

  it('carries a fork through to the stored history', async () => {
    await withRepository(async ({ repository }) => {
      const first = await userTurn(repository, { content: 'first question' });
      const firstAnswer = await assistantTurn(repository, { content: 'first answer' });
      const second = await userTurn(repository, { runId: 'chat-run-2', content: 'second' });
      await materializeAssistantTurn({
        repository,
        chatId: CHAT_ID,
        runId: 'chat-run-2',
        summary: { status: 'success', content: 'second answer' },
        clientConnected: true
      });

      const forked = await userTurn(repository, {
        runId: 'chat-run-3',
        content: 'second, rephrased',
        replaceFromMessageId: second.id
      });

      const { messages } = await repository.getMessages(CHAT_ID);
      assert.deepEqual(
        messages.map(entry => entry.id),
        [first.id, firstAnswer.id, forked.id]
      );
      assert.equal(
        messages.some(entry => entry.id === second.id),
        false
      );
      assert.deepEqual(
        messages.map(entry => entry.content),
        ['first question', 'first answer', 'second, rephrased']
      );
    });
  });
});

describe('chatMaterializer: hasUnseenActivity', () => {
  it('is set when the answer landed with nobody connected', async () => {
    await withRepository(async ({ repository }) => {
      await userTurn(repository);
      // The browser closed while the durable run kept going; the emit result
      // cannot tell you this, so the choke point samples hasChatClient().
      await assistantTurn(repository, {}, false);

      assert.equal((await repository.getChat(CHAT_ID)).hasUnseenActivity, true);
    });
  });

  it('is not set when a client was watching', async () => {
    await withRepository(async ({ repository }) => {
      await userTurn(repository);
      await assistantTurn(repository, {}, true);

      assert.equal((await repository.getChat(CHAT_ID)).hasUnseenActivity, false);
    });
  });

  it('is set for an aborted run too, and cleared when the chat is opened', async () => {
    await withRepository(async ({ repository }) => {
      await userTurn(repository);
      await assistantTurn(repository, { status: 'aborted', content: 'half an ans' }, false);
      assert.equal((await repository.getChat(CHAT_ID)).hasUnseenActivity, true);

      await repository.clearUnseen(CHAT_ID);
      assert.equal((await repository.getChat(CHAT_ID)).hasUnseenActivity, false);
    });
  });

  it('a new user turn on an unseen chat clears the mark', async () => {
    await withRepository(async ({ repository }) => {
      await userTurn(repository);
      await assistantTurn(repository, {}, false);

      await userTurn(repository, { runId: 'chat-run-2', content: 'still here' });
      assert.equal((await repository.getChat(CHAT_ID)).hasUnseenActivity, false);
    });
  });
});

describe('chatMaterializer: turns that did not go well', () => {
  it('records the abort on the message so a cut-off answer does not read as complete', async () => {
    await withRepository(async ({ repository }) => {
      await userTurn(repository);
      const answer = await assistantTurn(repository, {
        status: 'aborted',
        content: 'Start by ',
        finishReason: 'connection_closed'
      });

      assert.equal(answer.content, 'Start by ', 'the partial answer is kept');
      assert.equal(answer.finishReason, 'connection_closed');
      assert.ok(answer.error, 'an aborted run records an error on the message');
      assert.equal(answer.error.code, 'ABORTED');
      assert.equal(typeof answer.error.message, 'string');

      const chat = await repository.getChat(CHAT_ID);
      assert.equal(chat.status, 'active', 'an abort is not a broken chat');
      assert.equal(chat.activeRunId, null);

      const { messages } = await repository.getMessages(CHAT_ID);
      assert.equal(messages.at(-1).error.code, 'ABORTED');
    });
  });

  it('records a failure on the message and marks the chat', async () => {
    await withRepository(async ({ repository }) => {
      await userTurn(repository);
      const answer = await assistantTurn(repository, {
        status: 'error',
        content: '',
        finishReason: 'error',
        errorInfo: { code: 'RATE_LIMIT', message: 'Too many requests' }
      });

      assert.deepEqual(answer.error, { code: 'RATE_LIMIT', message: 'Too many requests' });
      assert.equal(answer.content, '');
      assert.equal((await repository.getChat(CHAT_ID)).status, 'error');
    });
  });

  it('records a failure that arrives on summary.error instead', async () => {
    await withRepository(async ({ repository }) => {
      await userTurn(repository);
      const answer = await assistantTurn(repository, {
        status: 'error',
        content: '',
        error: { code: 'PROVIDER_DOWN', message: 'Upstream unavailable' }
      });

      assert.deepEqual(answer.error, { code: 'PROVIDER_DOWN', message: 'Upstream unavailable' });
    });
  });

  it('records a failure with no detail rather than nothing', async () => {
    await withRepository(async ({ repository }) => {
      await userTurn(repository);
      const answer = await assistantTurn(repository, { status: 'error', content: '' });

      assert.ok(answer.error);
      assert.equal(typeof answer.error.code, 'string');
      assert.equal((await repository.getChat(CHAT_ID)).status, 'error');
    });
  });

  it('writes an empty answer rather than pretending the turn never happened', async () => {
    await withRepository(async ({ repository }) => {
      await userTurn(repository);
      const answer = await assistantTurn(repository, {
        status: 'success',
        content: '',
        finishReason: 'stop'
      });

      assert.equal(answer.content, '');
      assert.equal((await repository.getChat(CHAT_ID)).messageCount, 2);
    });
  });

  it('records nothing for a turn that paused for a clarification', async () => {
    await withRepository(async ({ repository }) => {
      await userTurn(repository);
      // The question is an interaction, not a message; an empty assistant
      // bubble in the transcript would be a visible defect.
      const answer = await assistantTurn(repository, { status: 'paused', content: '' });

      assert.equal(answer, null);
      assert.equal((await repository.getChat(CHAT_ID)).messageCount, 1);
    });
  });

  it('drops usage that carries no counters', async () => {
    await withRepository(async ({ repository }) => {
      await userTurn(repository);
      const answer = await assistantTurn(repository, {
        usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 }
      });

      assert.equal('usage' in answer, false);
    });
  });
});

describe('chatMaterializer: a turn that was superseded', () => {
  /**
   * The interleaving `ChatService.runTurn` produces when a second turn starts
   * on a chat that is still generating: it aborts the first turn's controller
   * and writes its own user message immediately, while the aborted turn is
   * still unwinding towards its assistant half.
   *
   * @param {ChatRepository} repository - Repository under test.
   * @returns {Promise<void>}
   */
  async function supersede(repository) {
    await userTurn(repository, { content: 'first question' });
    await userTurn(repository, { runId: 'chat-run-2', content: 'second question' });
    await assistantTurn(repository, { status: 'aborted', content: 'half an ans' }, false);
  }

  it('does not announce the chat idle while its replacement is still running', async () => {
    await withRepository(async ({ repository }) => {
      await supersede(repository);

      const chat = await repository.getChat(CHAT_ID);
      assert.equal(chat.activeRunId, 'chat-run-2', 'the live run still owns the chat');
      assert.equal(chat.status, 'running');
      assert.equal(chat.hasUnseenActivity, false, 'the live turn decides this, not the dead one');
    });
  });

  it('keeps the partial answer next to the question it answers', async () => {
    await withRepository(async ({ repository }) => {
      await supersede(repository);

      const { messages } = await repository.getMessages(CHAT_ID);
      assert.deepEqual(
        messages.map(entry => entry.content),
        ['first question', 'half an ans', 'second question'],
        'appending would replay [user, user, assistant] to the model on every later turn'
      );
      assert.deepEqual(
        messages.map(entry => entry.runId),
        [RUN_ID, RUN_ID, 'chat-run-2']
      );
      assert.equal(messages[1].error.code, 'ABORTED');
    });
  });

  it('the replacement still releases the chat when it finishes', async () => {
    await withRepository(async ({ repository }) => {
      await supersede(repository);
      await materializeAssistantTurn({
        repository,
        chatId: CHAT_ID,
        runId: 'chat-run-2',
        summary: { status: 'success', content: 'the real answer' },
        clientConnected: true
      });

      const chat = await repository.getChat(CHAT_ID);
      assert.equal(chat.activeRunId, null);
      assert.equal(chat.status, 'active');
      const { messages } = await repository.getMessages(CHAT_ID);
      assert.deepEqual(
        messages.map(entry => entry.content),
        ['first question', 'half an ans', 'second question', 'the real answer']
      );
    });
  });
});

describe('chatMaterializer: nothing to write to', () => {
  it('writes nothing without a repository', async () => {
    assert.equal(await materializeUserTurn({ repository: null, chatId: CHAT_ID }), null);
    assert.equal(await materializeAssistantTurn({ repository: null, chatId: CHAT_ID }), null);
  });

  it('writes nothing when storage is unavailable', async () => {
    const repository = new ChatRepository({ logger: quietLogger() });

    assert.equal(await userTurn(repository), null);
    assert.equal(await assistantTurn(repository), null);
  });

  it('does not orphan an answer whose chat document is gone', async () => {
    await withRepository(async ({ repository }) => {
      await userTurn(repository);
      await repository.deleteChat(CHAT_ID);

      assert.equal(await assistantTurn(repository), null);
      assert.deepEqual(await repository.getMessages(CHAT_ID), { version: 1, messages: [] });
    });
  });

  it('a storage failure never fails the turn', async () => {
    await withRepository(async ({ repository }) => {
      // The seam the materializer talks to is the repository, so that is where
      // the fault goes in; everything below it stays real.
      const broken = Object.create(repository);
      broken.appendMessage = async () => {
        throw new Error('disk is on fire');
      };

      assert.equal(await userTurn(broken), null, 'the user turn resolves instead of rejecting');
      assert.equal(await assistantTurn(broken), null);
      // The chat itself was created before the append failed; the turn that
      // wrapped this call is unaffected either way.
      assert.ok(await repository.getChat(CHAT_ID));
    });
  });

  it('a failure creating the chat is swallowed too', async () => {
    await withRepository(async ({ repository }) => {
      const broken = Object.create(repository);
      broken.ensureChat = async () => {
        throw new Error('lock service unreachable');
      };

      assert.equal(await userTurn(broken), null);
      assert.equal(await repository.getChat(CHAT_ID), null);
    });
  });
});
