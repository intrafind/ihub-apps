// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * The chat context tools: a later turn of a stored chat can look up the
 * sources earlier answers found, the files uploaded to the chat and the
 * files the turns created — offered only for the kinds the chat has, and
 * only to someone who may read the chat.
 *
 * Run: node --test server/tests/chat-persistence-context-tools.test.js
 */
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';

import configCache from '../configCache.js';
import { bootstrapStorage, shutdownStorageBootstrap } from '../storage/bootstrap.js';
import { getChatRepository } from '../services/chat/ChatRepository.js';
import { getArtifactRepository } from '../services/artifacts/ArtifactRepository.js';
import {
  chatContextInventory,
  chatContextToolsFor,
  isChatContextTool,
  pageOfText,
  runChatContextTool,
  turnsOf
} from '../services/chat/chatContextTools.js';
import { getToolsForApp } from '../toolLoader.js';
import { extractToolSources } from '../services/sources/index.js';
import { knowledgeSourceSeam } from '../services/loop/seams/knowledgeSourceSeam.js';
import RequestBuilder from '../services/chat/RequestBuilder.js';
import { renderUserMessage } from '../../shared/promptContext.js';

const ADA = { id: 'user-ada', name: 'Ada Lovelace', email: 'ada@example.com' };
const BOB = { id: 'user-bob', name: 'Bob', email: 'bob@example.com' };

let baseDir;
let chatCounter = 0;

const WEB_SOURCE = {
  id: 'url:example.com/rome',
  provider: 'web',
  kind: 'page',
  private: false,
  title: 'History of Rome',
  url: 'https://example.com/rome',
  site: 'example.com',
  snippet: 'Rome was founded in 753 BC.',
  passages: [{ text: 'Legend says Romulus founded Rome in 753 BC.' }],
  cited: true,
  markers: [1]
};

const OTHER_SOURCE = {
  id: 'url:example.org/carthage',
  provider: 'web',
  kind: 'page',
  private: false,
  title: 'Carthage',
  url: 'https://example.org/carthage',
  snippet: 'Carthage was a Phoenician city.'
};

/** A chat of Ada's: two answered turns, sources on both, a file and a created file. */
async function seedChat({ files = true, sources = true, artifacts = true } = {}) {
  chatCounter += 1;
  const chatId = `chat-context-${chatCounter}`;
  const repository = getChatRepository();
  await repository.ensureChat({ chatId, ownerId: ADA.id, appId: 'chat', title: 'Context' });
  let report = null;
  if (files) {
    report = await repository.fileStore().put(repository.fileScope(chatId), {
      ownerId: ADA.id,
      name: 'report.txt',
      mimeType: 'text/plain',
      text: 'Quarterly report. '.repeat(2000),
      storageMode: 'server_text_only'
    });
  }
  await repository.appendMessage(chatId, {
    role: 'user',
    content: 'Tell me about Rome',
    clientMessageId: 'u1',
    ...(report
      ? {
          attachments: [
            { id: report.id, type: report.mimeType, name: report.name, bytes: report.bytes }
          ]
        }
      : {})
  });
  await repository.appendMessage(chatId, {
    role: 'assistant',
    content: 'Rome was founded in 753 BC [1](https://example.com/rome).',
    runId: 'run-1',
    ...(sources ? { sources: { items: [WEB_SOURCE], queries: ['history of rome'] } } : {})
  });
  await repository.appendMessage(chatId, {
    role: 'user',
    content: 'And Carthage?',
    clientMessageId: 'u2'
  });
  await repository.appendMessage(chatId, {
    role: 'assistant',
    content: 'Carthage was Phoenician.',
    runId: 'run-2',
    ...(sources ? { sources: { items: [OTHER_SOURCE], queries: ['carthage'] } } : {})
  });
  if (artifacts) {
    await getArtifactRepository().put(repository.artifactScope(chatId), {
      kind: 'code',
      mimeType: 'text/markdown',
      name: 'summary.md',
      data: Buffer.from('# Summary\n\nRome and Carthage.', 'utf8'),
      runId: 'run-2'
    });
    await getArtifactRepository().put(repository.artifactScope(chatId), {
      kind: 'image',
      mimeType: 'image/png',
      name: 'map.png',
      data: Buffer.from([0x89, 0x50, 0x4e, 0x47]),
      runId: 'run-1'
    });
  }
  return { chatId, report };
}

function call(toolId, chatId, args = {}, user = ADA) {
  return runChatContextTool(toolId, { ...args, chatId, user, language: 'en' });
}

before(async () => {
  baseDir = await fs.mkdtemp(path.join(os.tmpdir(), 'ihub-chat-context-tools-'));
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

describe('which tools a turn gets', () => {
  it('offers the pair of every kind the chat has', async () => {
    const { chatId } = await seedChat();
    const inventory = await chatContextInventory({ chatId, user: ADA });
    assert.deepEqual(inventory, { sources: true, files: true, artifacts: true });
    const ids = chatContextToolsFor({ inventory, language: 'en' }).map(tool => tool.id);
    assert.deepEqual(ids, [
      'chat_sources_list',
      'chat_sources_read',
      'chat_files_list',
      'chat_files_read',
      'chat_artifacts_list',
      'chat_artifacts_read'
    ]);
    assert.ok(ids.every(isChatContextTool));
  });

  it('offers nothing for a kind the chat does not have', async () => {
    const { chatId } = await seedChat({ files: false, artifacts: false });
    const inventory = await chatContextInventory({ chatId, user: ADA });
    assert.deepEqual(inventory, { sources: true, files: false, artifacts: false });
    assert.deepEqual(
      chatContextToolsFor({ inventory }).map(tool => tool.id),
      ['chat_sources_list', 'chat_sources_read']
    );
  });

  it('offers nothing for a chat that is not stored, a headless chat or someone else', async () => {
    const { chatId } = await seedChat();
    assert.equal(await chatContextInventory({ chatId: 'chat-never-stored', user: ADA }), null);
    assert.equal(await chatContextInventory({ chatId: 'agent:run-1:abc', user: ADA }), null);
    assert.equal(await chatContextInventory({ chatId, user: BOB }), null);
    assert.equal(await chatContextInventory({ chatId, user: null }), null);
    assert.deepEqual(chatContextToolsFor({ inventory: null }), []);
  });

  it('reach the turn through the tool loader, read-only, localized', async () => {
    const { chatId } = await seedChat();
    const chatContext = await chatContextInventory({ chatId, user: ADA });
    const tools = await getToolsForApp({ id: 'chat', tools: [] }, 'de', {
      user: ADA,
      chatId,
      chatContext
    });
    const read = tools.find(tool => tool.id === 'chat_files_read');
    assert.ok(read, 'chat_files_read is offered');
    assert.equal(read.name, 'Chat-Datei lesen');
    assert.equal(read.sideEffect, 'read');
  });
});

describe('earlier sources', () => {
  it('lists the sources by turn, newest first, without what the answer made of them', async () => {
    const { chatId } = await seedChat();
    const result = await call('chat_sources_list', chatId);
    assert.deepEqual(
      result.turns.map(turn => [turn.turn, turn.sources.map(source => source.id)]),
      [
        [2, [OTHER_SOURCE.id]],
        [1, [WEB_SOURCE.id]]
      ]
    );
    assert.deepEqual(result.turns[1].queries, ['history of rome']);
    assert.equal(result.turns[1].sources[0].cited, true);
    assert.equal(result.total, 2);
  });

  it('filters by turn and by text', async () => {
    const { chatId } = await seedChat();
    const byTurn = await call('chat_sources_list', chatId, { turn: 2 });
    assert.deepEqual(
      byTurn.turns.map(turn => turn.turn),
      [2]
    );
    const byText = await call('chat_sources_list', chatId, { query: 'romulus' });
    assert.equal(byText.total, 0, 'passages are not searched, only title/link/site/snippet');
    const bySnippet = await call('chat_sources_list', chatId, { query: '753' });
    assert.deepEqual(
      bySnippet.turns.flatMap(turn => turn.sources.map(source => source.id)),
      [WEB_SOURCE.id]
    );
  });

  it('reads a source with its passages and reports it again for citation', async () => {
    const { chatId } = await seedChat();
    const result = await call('chat_sources_read', chatId, { id: WEB_SOURCE.id });
    assert.equal(result.turn, 1);
    assert.equal(result.source.url, WEB_SOURCE.url);
    assert.deepEqual(result.source.passages, WEB_SOURCE.passages);
    assert.equal(result.source.cited, undefined);
    assert.equal(result.source.markers, undefined);
    assert.match(result.note, /page reader/);
    // The envelope keeps the stored identity, provider and privacy, so the
    // new answer can cite the link.
    const frame = extractToolSources({ toolId: 'chat_sources_read', result });
    assert.equal(frame.items.length, 1);
    assert.equal(frame.items[0].id, WEB_SOURCE.id);
    assert.equal(frame.items[0].provider, 'web');
    assert.equal(frame.items[0].private, false);
    assert.equal(frame.items[0].url, WEB_SOURCE.url);
    // An answer that rests on it is badged as web search, as when it was found.
    const badges = [];
    knowledgeSourceSeam.postTool(
      { addKnowledgeSource: source => badges.push(source) },
      { toolId: 'chat_sources_read' },
      { sources: frame }
    );
    assert.deepEqual(badges, ['websearch']);
  });

  it('answers an unknown id with a pointer to the list', async () => {
    const { chatId } = await seedChat();
    const result = await call('chat_sources_read', chatId, { id: 'url:nowhere' });
    assert.equal(result.code, 'SOURCE_NOT_FOUND');
    assert.match(result.error, /chat_sources_list/);
  });

  it('refuses a chat the caller may not read', async () => {
    const { chatId } = await seedChat();
    const result = await call('chat_sources_list', chatId, {}, BOB);
    assert.equal(result.code, 'CHAT_NOT_FOUND');
  });
});

describe('uploaded files', () => {
  it('lists the files with the turn they came with', async () => {
    const { chatId, report } = await seedChat();
    const result = await call('chat_files_list', chatId);
    assert.equal(result.files.length, 1);
    assert.equal(result.files[0].fileId, report.id);
    assert.equal(result.files[0].name, 'report.txt');
    assert.equal(result.files[0].turn, 1);
  });

  it('reads a long file in pages', async () => {
    const { chatId, report } = await seedChat();
    const first = await call('chat_files_read', chatId, { fileId: report.id });
    assert.equal(first.offset, 0);
    assert.equal(first.totalChars, 'Quarterly report. '.length * 2000);
    assert.equal(first.text.length, first.nextOffset);
    assert.match(first.continue, /offset/);
    const second = await call('chat_files_read', chatId, {
      fileId: report.id,
      offset: first.nextOffset
    });
    assert.equal(second.offset, first.nextOffset);
    assert.equal(second.nextOffset, undefined);
    assert.equal(first.text.length + second.text.length, first.totalChars);
  });

  it('answers an unknown file id and refuses another user', async () => {
    const { chatId, report } = await seedChat();
    const missing = await call('chat_files_read', chatId, { fileId: 'file_000' });
    assert.equal(missing.code, 'FILE_NOT_FOUND');
    const denied = await call('chat_files_read', chatId, { fileId: report.id }, BOB);
    assert.equal(denied.code, 'CHAT_NOT_FOUND');
  });
});

describe('created files', () => {
  it('lists the created files with the turn that made them', async () => {
    const { chatId } = await seedChat();
    const result = await call('chat_artifacts_list', chatId);
    const byName = Object.fromEntries(result.files.map(file => [file.name, file]));
    assert.equal(byName['summary.md'].kind, 'code');
    assert.equal(byName['summary.md'].turn, 2);
    assert.equal(byName['map.png'].turn, 1);
    const images = await call('chat_artifacts_list', chatId, { kind: 'image' });
    assert.deepEqual(
      images.files.map(file => file.name),
      ['map.png']
    );
  });

  it('reads a text file by name or id, and says an image has no text', async () => {
    const { chatId } = await seedChat();
    const byName = await call('chat_artifacts_read', chatId, { artifact: 'summary.md' });
    assert.equal(byName.text, '# Summary\n\nRome and Carthage.');
    const byId = await call('chat_artifacts_read', chatId, { artifact: byName.id });
    assert.equal(byId.text, byName.text);
    const image = await call('chat_artifacts_read', chatId, { artifact: 'map.png' });
    assert.equal(image.text, '');
    assert.match(image.note, /image/);
  });

  it('names the available files when one is not found, and refuses another user', async () => {
    const { chatId } = await seedChat();
    const missing = await call('chat_artifacts_read', chatId, { artifact: 'nope.docx' });
    assert.equal(missing.code, 'ARTIFACT_NOT_FOUND');
    assert.match(missing.error, /summary\.md/);
    const denied = await call('chat_artifacts_list', chatId, {}, BOB);
    assert.equal(denied.code, 'CHAT_NOT_FOUND');
  });
});

describe('a turn of a stored chat', () => {
  /** Prepare a turn of `chatId` with the stored history as the route hands it over. */
  async function prepare(chatId, report, { contextWindow = 32000, sendChatHistory } = {}) {
    configCache.setCacheEntry('config/apps.json', [
      {
        id: 'chat',
        name: { en: 'Chat' },
        description: { en: 'Chat' },
        system: { en: 'You help.' },
        enabled: true,
        ...(sendChatHistory === false ? { sendChatHistory: false } : {})
      }
    ]);
    configCache.setCacheEntry('config/models.json', [
      { id: 'm', name: 'M', provider: 'openai', enabled: true, default: true, contextWindow }
    ]);
    const builder = new RequestBuilder();
    builder.apiKeyVerifier = { verifyApiKey: async () => ({ success: true, apiKey: 'k' }) };
    const big = { ...report, text: 'Quarterly report. '.repeat(2000) };
    const messages = [
      {
        role: 'user',
        content: 'Tell me about Rome',
        fileData: [
          {
            id: big.id,
            fileId: big.id,
            fileName: big.name,
            name: big.name,
            fileType: 'text/plain',
            type: 'document',
            origin: 'upload',
            content: big.text
          }
        ]
      },
      { role: 'assistant', content: 'Rome was founded in 753 BC.' },
      { role: 'user', content: 'What does the report say?' }
    ];
    const render = async list =>
      list.map(message =>
        message.role === 'user'
          ? {
              ...message,
              content: renderUserMessage({ content: message.content, files: message.fileData })
            }
          : message
      );
    const result = await builder.prepareChatRequest({
      appId: 'chat',
      modelId: 'm',
      messages,
      language: 'en',
      processMessageTemplates: render,
      user: ADA,
      chatId
    });
    assert.equal(result.success, true, result.error?.message);
    return result.data;
  }

  it('sends an earlier file over the budget as a stub and offers the tools to read it', async () => {
    const { chatId, report } = await seedChat();
    const data = await prepare(chatId, report, { contextWindow: 32000 });
    const first = data.llmMessages.find(message => message.role === 'user');
    assert.match(first.content, new RegExp(`id="${report.id}"[^>]*omitted="true"`));
    assert.ok(!first.content.includes('Quarterly report.'));
    const ids = data.tools.map(tool => tool.id);
    for (const id of ['chat_sources_read', 'chat_files_read', 'chat_artifacts_read']) {
      assert.ok(ids.includes(id), `${id} is offered`);
    }
  });

  it('keeps an earlier file inline while it fits', async () => {
    const { chatId, report } = await seedChat();
    const data = await prepare(chatId, report, { contextWindow: 1000000 });
    const first = data.llmMessages.find(message => message.role === 'user');
    assert.ok(first.content.includes('Quarterly report.'));
  });

  it('offers nothing to an app that sends no history', async () => {
    const { chatId, report } = await seedChat();
    const data = await prepare(chatId, report, { sendChatHistory: false });
    assert.ok(!data.tools.some(tool => isChatContextTool(tool.id)));
  });
});

describe('helpers', () => {
  it('numbers turns by user message', () => {
    assert.deepEqual(
      turnsOf([
        { role: 'assistant' },
        { role: 'user' },
        { role: 'assistant' },
        { role: 'user' },
        { role: 'assistant' }
      ]),
      [1, 1, 1, 2, 2]
    );
  });

  it('pages text within a byte budget', () => {
    const wide = '€'.repeat(30000);
    const page = pageOfText(wide, 0);
    assert.ok(Buffer.byteLength(page.text, 'utf8') <= 30000);
    assert.equal(page.nextOffset, page.text.length);
    assert.deepEqual(pageOfText('abc', 10), { text: '', offset: 3, totalChars: 3 });
  });
});
