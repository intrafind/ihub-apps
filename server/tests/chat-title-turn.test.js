// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * A chat title never holds up the chat (#2314).
 *
 * The title is written by a model call after the answer has been stored. This
 * drives a real `ChatService.runTurn` with a title call that does not return
 * until the test lets it, and pins that the turn is over — answer stored, run
 * released, `runTurn` resolved — while the title is still being written, and
 * that the title lands afterwards.
 */
import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';

import ChatService from '../services/chat/ChatService.js';
import configCache from '../configCache.js';
import llmClient from '../services/loop/LLMClient.js';
import { activeRequests } from '../sse.js';

const CHAT_ID = 'chat-title-turn';
const MODEL = { id: 'test-model' };
const PREP = {
  app: { id: 'test-app' },
  model: MODEL,
  llmMessages: [{ role: 'user', content: 'hi' }],
  tools: [],
  maxTokens: 100,
  llmOptions: {}
};

const original = {};
let platform;
let titleCalls;
let releaseTitle;

const tick = () => new Promise(resolve => setImmediate(resolve));

function makeService() {
  return new ChatService({
    agentLoop: {
      // `completed` is what the real loop returns for an answer that ended normally.
      run: async () => ({
        status: 'completed',
        content: 'The landlord asks for an inspection.',
        finishReason: 'stop',
        messages: [],
        usage: null
      })
    },
    runLog: { startRun: async () => {}, append: () => {}, endRun: async () => {} },
    logInteraction: () => {},
    telemetry: { recordTurn: () => {}, recordError: () => {} }
  });
}

function makeRepository() {
  const calls = { exchange: [], titles: [], released: 0 };
  return {
    calls,
    isAvailable: () => true,
    ensureChat: async () => ({ id: CHAT_ID }),
    appendMessage: async () => ({ message: { id: 'm1' } }),
    releaseRun: async () => {
      calls.released += 1;
      return { chat: { id: CHAT_ID } };
    },
    getFirstExchangeForTitle: async (chatId, options) => {
      calls.exchange.push({ chatId, options });
      return {
        userText: 'Help with my landlord mail',
        assistantText: 'It asks for an inspection.'
      };
    },
    setGeneratedTitle: async (chatId, title) => {
      calls.titles.push({ chatId, title });
      return true;
    }
  };
}

async function runTurn(service, repository) {
  try {
    return await service.runTurn({
      prep: PREP,
      chatId: CHAT_ID,
      streaming: false,
      user: { id: 'user-1', permissions: { models: new Set(['test-model']) } },
      persistence: { repository, ownerId: 'user-1', content: 'Help with my landlord mail' }
    });
  } finally {
    activeRequests.delete(CHAT_ID);
  }
}

beforeEach(() => {
  platform = { chats: { titles: { enabled: true, modelId: '' } } };
  titleCalls = [];
  original.getPlatform = configCache.getPlatform;
  original.complete = llmClient.complete;
  configCache.getPlatform = () => platform;
  llmClient.complete = params => {
    titleCalls.push(params);
    // Does not answer until the test says so.
    return new Promise(resolve => {
      releaseTitle = () => resolve({ content: 'Landlord inspection request' });
    });
  };
});

afterEach(() => {
  configCache.getPlatform = original.getPlatform;
  llmClient.complete = original.complete;
});

describe('ChatService.runTurn and the chat title', () => {
  it('resolves while the title is still being written, and the title lands after', async () => {
    const repository = makeRepository();
    const outcome = await runTurn(makeService(), repository);

    // The turn is over: it resolved, the answer is stored and the run released.
    assert.equal(outcome.status, 'completed');
    assert.equal(repository.calls.released, 1);

    // The title call has started and is still pending — nothing waited for it.
    await tick();
    assert.equal(titleCalls.length, 1, 'the title model was called');
    assert.equal(repository.calls.titles.length, 0, 'no title yet');

    releaseTitle();
    await tick();
    await tick();
    assert.deepEqual(repository.calls.titles, [
      { chatId: CHAT_ID, title: 'Landlord inspection request' }
    ]);
  });

  it('asks for the title of the first answer only', async () => {
    const repository = makeRepository();
    await runTurn(makeService(), repository);
    await tick();
    assert.deepEqual(repository.calls.exchange, [
      { chatId: CHAT_ID, options: { firstAnswerOnly: true } }
    ]);
    releaseTitle();
  });

  it('does not even read the chat for a title when the feature is off', async () => {
    platform.chats.titles.enabled = false;
    const repository = makeRepository();
    const outcome = await runTurn(makeService(), repository);
    await tick();
    assert.equal(outcome.status, 'completed');
    assert.equal(titleCalls.length, 0);
    assert.equal(repository.calls.exchange.length, 0);
  });

  it('is not held up by a title call that never returns', async () => {
    const repository = makeRepository();
    llmClient.complete = () => new Promise(() => {});
    const outcome = await runTurn(makeService(), repository);
    assert.equal(outcome.status, 'completed');
    assert.equal(repository.calls.released, 1);
  });

  it('is not failed by a title call that throws', async () => {
    const repository = makeRepository();
    llmClient.complete = async () => {
      throw new Error('LLM request timed out');
    };
    const outcome = await runTurn(makeService(), repository);
    await tick();
    assert.equal(outcome.status, 'completed');
    assert.equal(repository.calls.titles.length, 0);
  });
});
