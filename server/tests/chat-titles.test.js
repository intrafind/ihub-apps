// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * Background chat titles (#2314): the service half — which model may write a
 * title, what is sent to it, what is accepted back, and that no failure ever
 * escapes. The LLM client and the platform config are stubbed; the repository
 * is a recording fake because its own behaviour is covered by
 * `chat-title-repository.test.js`.
 */
import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import configCache from '../configCache.js';
import llmClient from '../services/loop/LLMClient.js';
import {
  TITLE_SOURCE_CHARS,
  buildTitleMessages,
  generateChatTitle,
  resolveTitleModel,
  sanitizeGeneratedTitle
} from '../services/chat/chatTitles.js';
import { chatTitleSettings } from '../services/chat/chatPersistence.js';

const CHAT_MODEL = { id: 'chat-model', modelType: 'chat', enabled: true };
const TITLE_MODEL = { id: 'small', modelType: 'chat', enabled: true };
const CATALOG = [CHAT_MODEL, TITLE_MODEL, { id: 'img', supportsImageGeneration: true }];

const userWith = (...models) => ({ id: 'u1', permissions: { models: new Set(models) } });

let platform;
let completeCalls;
let completeImpl;
const original = {};

function fakeRepository({
  claim = { title: 'Derived', userText: 'Hallo Welt', assistantText: 'Hi' }
} = {}) {
  const calls = { claim: 0, set: [] };
  return {
    calls,
    async claimGeneratedTitle() {
      calls.claim += 1;
      return claim;
    },
    async setGeneratedTitle(chatId, title, options) {
      calls.set.push({ chatId, title, options });
      return { applied: true, chat: { id: chatId, title } };
    }
  };
}

beforeEach(() => {
  platform = { chats: { titles: { enabled: true, modelId: '' } } };
  completeCalls = [];
  completeImpl = async () => ({ content: 'Heizung Besichtigung' });
  original.getPlatform = configCache.getPlatform;
  original.complete = llmClient.complete;
  original.resolveModel = llmClient.resolveModel;
  configCache.getPlatform = () => platform;
  llmClient.complete = async params => {
    completeCalls.push(params);
    return completeImpl(params);
  };
  llmClient.resolveModel = ({ modelId, requireTextCapable }) => {
    const pool = requireTextCapable ? CATALOG.filter(m => !m.supportsImageGeneration) : CATALOG;
    return pool.find(m => m.id === modelId) || null;
  };
});

afterEach(() => {
  configCache.getPlatform = original.getPlatform;
  llmClient.complete = original.complete;
  llmClient.resolveModel = original.resolveModel;
});

describe('chatTitleSettings', () => {
  it('is off unless explicitly enabled', () => {
    assert.deepEqual(chatTitleSettings({}), { enabled: false, modelId: '' });
    assert.deepEqual(chatTitleSettings({ chats: { titles: { enabled: 'yes' } } }).enabled, false);
    assert.deepEqual(chatTitleSettings({ chats: { titles: { enabled: true, modelId: ' m ' } } }), {
      enabled: true,
      modelId: 'm'
    });
  });
});

describe('sanitizeGeneratedTitle', () => {
  it('keeps one clean line', () => {
    assert.equal(sanitizeGeneratedTitle('Heizung Besichtigung'), 'Heizung Besichtigung');
    assert.equal(sanitizeGeneratedTitle('"Heating inspection."'), 'Heating inspection');
    assert.equal(sanitizeGeneratedTitle('Title: Heating inspection!'), 'Heating inspection');
    assert.equal(sanitizeGeneratedTitle('Titel: „Heizung“'), 'Heizung');
    assert.equal(sanitizeGeneratedTitle('\n  First line\nsecond line'), 'First line');
  });

  it('removes control and bidi characters', () => {
    assert.equal(sanitizeGeneratedTitle('A‮B\u0000C​D'), 'ABCD');
  });

  it('cuts at 60 characters on a word boundary', () => {
    const title = sanitizeGeneratedTitle(`${'word '.repeat(30)}`);
    assert.ok(title.length <= 60);
    assert.ok(!title.endsWith(' '));
    assert.match(title, /^(word )*word$/);
  });

  it('rejects what is not a title', () => {
    assert.equal(sanitizeGeneratedTitle(''), '');
    assert.equal(sanitizeGeneratedTitle('   \n  '), '');
    assert.equal(sanitizeGeneratedTitle('""'), '');
    assert.equal(sanitizeGeneratedTitle(null), '');
    assert.equal(sanitizeGeneratedTitle({ x: 1 }), '');
  });
});

describe('buildTitleMessages', () => {
  it('sends only the two texts, each cut and flattened', () => {
    const long = `line one\n${'x'.repeat(2000)}`;
    const [system, user] = buildTitleMessages({ userText: long, assistantText: long });
    assert.equal(system.role, 'system');
    assert.match(system.content, /untrusted/);
    assert.equal(user.role, 'user');
    assert.ok(!user.content.includes('\n\n\n'));
    const body = user.content.split('USER MESSAGE\n')[1].split('\nUSER MESSAGE')[0];
    assert.equal(body.length, TITLE_SOURCE_CHARS);
    assert.ok(!body.includes('\n'));
  });
});

describe('resolveTitleModel', () => {
  it('uses the configured model when this user may use it', () => {
    const model = resolveTitleModel({
      configuredId: 'small',
      chatModel: CHAT_MODEL,
      user: userWith('small', 'chat-model')
    });
    assert.equal(model.id, 'small');
  });

  it("falls back to the chat's own model when the configured one is not permitted", () => {
    const model = resolveTitleModel({
      configuredId: 'small',
      chatModel: CHAT_MODEL,
      user: userWith('chat-model')
    });
    assert.equal(model.id, 'chat-model');
  });

  it('never falls back to any other model', () => {
    // Configured model unknown, chat model not permitted: no model at all, even
    // though the catalog holds usable ones.
    assert.equal(
      resolveTitleModel({ configuredId: 'gone', chatModel: CHAT_MODEL, user: userWith('small') }),
      null
    );
    assert.equal(
      resolveTitleModel({ configuredId: '', chatModel: null, user: userWith('*') }),
      null
    );
  });

  it('fails closed without resolved permissions', () => {
    assert.equal(
      resolveTitleModel({ configuredId: 'small', chatModel: CHAT_MODEL, user: { id: 'u1' } }),
      null
    );
  });

  it('refuses a configured or chat model that cannot write text', () => {
    assert.equal(
      resolveTitleModel({ configuredId: 'img', chatModel: null, user: userWith('*') }),
      null
    );
    assert.equal(
      resolveTitleModel({
        configuredId: '',
        chatModel: { id: 'tts', modelType: 'tts' },
        user: userWith('*')
      }),
      null
    );
  });
});

describe('generateChatTitle', () => {
  const params = overrides => ({
    chatId: 'chat-1',
    user: userWith('chat-model', 'small'),
    chatModel: CHAT_MODEL,
    appId: 'chat',
    language: 'de',
    ...overrides
  });

  it('stores the generated title, against the derived title seen at the claim', async () => {
    const repository = fakeRepository();
    const result = await generateChatTitle(params({ repository }));
    assert.deepEqual(result, { status: 'done', title: 'Heizung Besichtigung' });
    assert.deepEqual(repository.calls.set, [
      { chatId: 'chat-1', title: 'Heizung Besichtigung', options: { expectedTitle: 'Derived' } }
    ]);
  });

  it('calls the model once, bounded, without a ledger run, as chat-title', async () => {
    await generateChatTitle(params({ repository: fakeRepository() }));
    assert.equal(completeCalls.length, 1);
    const call = completeCalls[0];
    assert.equal(call.model.id, 'chat-model');
    assert.ok(call.options.maxTokens <= 64);
    assert.equal(call.options.user.id, 'u1');
    assert.equal(call.timeoutMs, 10000);
    assert.equal(call.retries, 0);
    assert.equal(call.language, 'de');
    assert.equal(call.telemetry.purpose, 'chat-title');
    assert.equal(call.telemetry.autoRun, false);
  });

  it('uses the configured title model for a user who may use it', async () => {
    platform.chats.titles.modelId = 'small';
    await generateChatTitle(params({ repository: fakeRepository() }));
    assert.equal(completeCalls[0].model.id, 'small');
  });

  it('makes no call when the feature is off, the user is anonymous or no model is allowed', async () => {
    platform.chats.titles.enabled = false;
    const off = fakeRepository();
    assert.equal((await generateChatTitle(params({ repository: off }))).status, 'skipped');
    assert.equal(off.calls.claim, 0, 'off: not even a claim');

    platform.chats.titles.enabled = true;
    const anonymous = fakeRepository();
    await generateChatTitle(params({ repository: anonymous, user: { id: 'anonymous' } }));
    assert.equal(anonymous.calls.claim, 0);

    const noModel = fakeRepository();
    await generateChatTitle(params({ repository: noModel, user: userWith('other') }));
    assert.equal(noModel.calls.claim, 0, 'no model: the chat is not used up');
    assert.equal(completeCalls.length, 0);
  });

  it('makes no call when the claim is refused', async () => {
    const result = await generateChatTitle(params({ repository: fakeRepository({ claim: null }) }));
    assert.equal(result.status, 'skipped');
    assert.equal(completeCalls.length, 0);
  });

  it('keeps the derived title when the model fails, times out or answers nothing', async () => {
    for (const impl of [
      async () => {
        throw new Error('LLM request timed out');
      },
      async () => ({ content: '   ' }),
      async () => ({ content: '""' })
    ]) {
      completeImpl = impl;
      const repository = fakeRepository();
      const result = await generateChatTitle(params({ repository }));
      assert.equal(result.status, 'failed');
      assert.equal(repository.calls.set.length, 0);
    }
  });

  it('never throws, even when the repository does', async () => {
    const repository = {
      async claimGeneratedTitle() {
        throw new Error('lock timeout');
      }
    };
    assert.deepEqual(await generateChatTitle(params({ repository })), { status: 'failed' });
  });

  it('reports a title that lost to a rename as skipped', async () => {
    const repository = fakeRepository();
    repository.setGeneratedTitle = async () => ({ applied: false, chat: null });
    assert.deepEqual(await generateChatTitle(params({ repository })), { status: 'skipped' });
  });
});
