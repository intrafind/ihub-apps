// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * The model that writes a chat turn's findings digests (#3819): the chat's own
 * model unless an admin set one (`chats.compaction.modelId`), and that one only
 * for users whose groups may use it.
 */
import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import llmClient from '../services/loop/LLMClient.js';
import { chatCompactionModel } from '../services/chat/ChatService.js';
import { chatCompactionSettings } from '../services/chat/chatPersistence.js';

const CHAT_MODEL = { id: 'chat-model', modelType: 'chat', enabled: true };
const SMALL = { id: 'small', modelType: 'chat', enabled: true, contextWindow: 256_000 };
const CATALOG = [CHAT_MODEL, SMALL, { id: 'img', supportsImageGeneration: true }];
const userWith = (...models) => ({ id: 'u1', permissions: { models: new Set(models) } });
const platformWith = modelId => ({ chats: { compaction: { modelId } } });

let originalResolve;
beforeEach(() => {
  originalResolve = llmClient.resolveModel;
  llmClient.resolveModel = ({ modelId, requireTextCapable }) => {
    const pool = requireTextCapable ? CATALOG.filter(m => !m.supportsImageGeneration) : CATALOG;
    return pool.find(m => m.id === modelId) || null;
  };
});
afterEach(() => {
  llmClient.resolveModel = originalResolve;
});

describe('chatCompactionSettings', () => {
  it("is the chat's own model unless one is set", () => {
    assert.deepEqual(chatCompactionSettings({}), { modelId: '' });
    assert.deepEqual(chatCompactionSettings(platformWith(' small ')), { modelId: 'small' });
    assert.deepEqual(chatCompactionSettings(platformWith(42)), { modelId: '' });
  });
});

describe('chatCompactionModel', () => {
  it("uses the chat's own model by default", () => {
    const model = chatCompactionModel({
      model: CHAT_MODEL,
      user: userWith('chat-model', 'small'),
      platform: platformWith('')
    });
    assert.equal(model, CHAT_MODEL);
  });

  it('uses the configured model for a user who may use it', () => {
    const model = chatCompactionModel({
      model: CHAT_MODEL,
      user: userWith('chat-model', 'small'),
      platform: platformWith('small')
    });
    assert.equal(model.id, 'small');
  });

  it("falls back to the chat's own model when the configured one is not permitted, unknown or not text", () => {
    for (const modelId of ['small', 'gone', 'img']) {
      const model = chatCompactionModel({
        model: CHAT_MODEL,
        user: userWith('chat-model', 'img'),
        platform: platformWith(modelId)
      });
      assert.equal(model, CHAT_MODEL, modelId);
    }
  });
});
