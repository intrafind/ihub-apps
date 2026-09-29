/**
 * Per-chat app variables: the values of an app's `variables` are chat state.
 *
 * An app that starts with a form (issue #2581) sends its variables once, with
 * the form's message. Follow-ups carry none, so the chat has to keep them for
 * the system prompt — and a chat reopened later must continue with them rather
 * than with the app's defaults.
 *
 * - **A turn that sends variables replaces the stored set**: it sends all of
 *   them, the way an app's variables panel does on every message.
 * - **A turn that sends none leaves them alone**: that is a follow-up.
 * - **What is stored is bounded**: the values come from a request body and are
 *   read back for the life of the chat.
 */
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { FilesystemStorageProvider } from '../storage/providers/filesystem/index.js';
import {
  ChatRepository,
  MAX_MESSAGE_CHARS,
  normalizeChatVariables
} from '../services/chat/ChatRepository.js';
import { materializeUserTurn } from '../services/chat/chatMaterializer.js';
import PromptService from '../services/PromptService.js';

const OWNER = 'user-1';
const CHAT_ID = 'chat-1';

/**
 * Run `fn` with a repository over a directory of its own.
 *
 * @param {(ctx: {repository: ChatRepository}) => Promise<void>} fn - Test body.
 * @returns {Promise<void>}
 */
async function withRepository(fn) {
  const baseDir = await fs.mkdtemp(path.join(os.tmpdir(), 'ihub-chat-variables-'));
  const provider = new FilesystemStorageProvider({ baseDir, flushIntervalMs: 25 });
  await provider.initialize();
  const repository = new ChatRepository({
    documents: provider.documents,
    locks: provider.locks,
    logger: { info() {}, warn() {}, error() {}, debug() {} }
  });
  try {
    await fn({ repository });
  } finally {
    await provider.shutdown();
    await fs.rm(baseDir, { recursive: true, force: true });
  }
}

/** One user turn on the test chat. */
function turn(repository, runId, content, variables) {
  return materializeUserTurn({
    repository,
    chatId: CHAT_ID,
    ownerId: OWNER,
    identityMode: 'default',
    appId: 'email',
    modelId: 'gpt-4o',
    ...(variables !== undefined ? { variables } : {}),
    runId,
    content
  });
}

describe('normalizeChatVariables', () => {
  it('keeps text values under valid variable names', () => {
    assert.deepEqual(normalizeChatVariables({ recipient: 'Ada', tone_2: '', 'sub-ject': 'Q3' }), {
      recipient: 'Ada',
      tone_2: '',
      'sub-ject': 'Q3'
    });
  });

  it('turns numbers and booleans into text and drops everything else', () => {
    assert.deepEqual(
      normalizeChatVariables({
        count: 3,
        formal: false,
        nested: { a: 1 },
        list: ['a'],
        nothing: null,
        '1bad': 'x',
        'has space': 'x'
      }),
      { count: '3', formal: 'false' }
    );
  });

  it('bounds what one turn can store', () => {
    const many = Object.fromEntries(Array.from({ length: 80 }, (_, i) => [`v${i}`, 'x']));
    assert.equal(Object.keys(normalizeChatVariables(many)).length, 50);
    const long = normalizeChatVariables({ text: 'x'.repeat(MAX_MESSAGE_CHARS + 10) });
    assert.equal(long.text.length, MAX_MESSAGE_CHARS);
  });

  it('answers null for nothing worth storing', () => {
    assert.equal(normalizeChatVariables(undefined), null);
    assert.equal(normalizeChatVariables({}), null);
    assert.equal(normalizeChatVariables(['a']), null);
    assert.equal(normalizeChatVariables({ bad: { x: 1 } }), null);
  });
});

describe('variables on the chat document', () => {
  it('records the variables of the turn that set them', async () => {
    await withRepository(async ({ repository }) => {
      await turn(repository, 'run-1', 'Write to Ada.', { recipient: 'Ada', subject: 'Q3' });
      const chat = await repository.getChat(CHAT_ID);
      assert.deepEqual(chat.variables, { recipient: 'Ada', subject: 'Q3' });
    });
  });

  it('keeps them through a follow-up that carries none', async () => {
    await withRepository(async ({ repository }) => {
      await turn(repository, 'run-1', 'Write to Ada.', { recipient: 'Ada', subject: 'Q3' });
      await turn(repository, 'run-2', 'Make it shorter');
      await turn(repository, 'run-3', 'And friendlier', {});
      const chat = await repository.getChat(CHAT_ID);
      assert.deepEqual(chat.variables, { recipient: 'Ada', subject: 'Q3' });
    });
  });

  it('replaces them with the next set a turn sends', async () => {
    await withRepository(async ({ repository }) => {
      await turn(repository, 'run-1', 'Hi', { recipient: 'Ada', subject: 'Q3' });
      await turn(repository, 'run-2', 'Hi again', { recipient: 'Grace' });
      const chat = await repository.getChat(CHAT_ID);
      assert.deepEqual(chat.variables, { recipient: 'Grace' });
    });
  });

  it('is absent on a chat that never had any', async () => {
    await withRepository(async ({ repository }) => {
      await turn(repository, 'run-1', 'Hello');
      const chat = await repository.getChat(CHAT_ID);
      assert.equal('variables' in chat, false);
    });
  });

  it('refuses variables a caller smuggles in through updateChat', async () => {
    await withRepository(async ({ repository }) => {
      await turn(repository, 'run-1', 'Hello', { recipient: 'Ada' });
      await repository.updateChat(CHAT_ID, { variables: { 'bad name': 'x', obj: { a: 1 } } });
      const chat = await repository.getChat(CHAT_ID);
      assert.deepEqual(chat.variables, { recipient: 'Ada' });
    });
  });
});

describe('the system prompt of a follow-up', () => {
  const app = {
    id: 'email',
    system: { en: 'You write to {{recipient}}.' },
    prompt: { en: 'Write to {{recipient}}. {{content}}' }
  };

  it('uses the newest variables the conversation carried', async () => {
    const messages = [
      { role: 'user', content: 'Write to Ada.', variables: { recipient: 'Ada' } },
      { role: 'assistant', content: 'Dear Ada, …' },
      { role: 'user', content: 'Make it shorter', variables: {} }
    ];
    const out = await PromptService.processMessageTemplates(messages, app, null, null, 'en');

    assert.equal(out[0].role, 'system');
    assert.match(out[0].content, /You write to Ada\./);
    // The follow-up goes as typed: no template, no variables rendered into it.
    assert.equal(out[out.length - 1].content, 'Make it shorter');
  });
});
