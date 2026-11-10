// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * Feedback on an iAssistant answer reaches iFinder with ids the server
 * resolves itself.
 *
 * The chat client sends the chat and the run of the rated answer — never the
 * iFinder conversation or message id, which it has no business knowing. The
 * conversation comes from the chat's stored state and the message id from the
 * run that produced the answer, so rating an older answer addresses that
 * answer rather than the latest one.
 */
import { describe, it, beforeEach, afterEach, mock } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

const contentsDir = await fs.mkdtemp(path.join(os.tmpdir(), 'feedback-routing-'));
process.env.CONTENTS_DIR = contentsDir;

const { default: registerFeedbackRoutes } = await import('../routes/chat/feedbackRoutes.js');
const { default: configCache } = await import('../configCache.js');
const { default: conversationStateManager } =
  await import('../services/integrations/ConversationStateManager.js');
const { default: conversationApiService } =
  await import('../services/integrations/ConversationApiService.js');
const { default: iAssistantService } =
  await import('../services/integrations/iAssistantService.js');

function handler() {
  let chain = null;
  registerFeedbackRoutes(
    {
      post: (routePath, ...handlers) => {
        if (routePath.endsWith('/api/feedback')) chain = handlers;
      }
    },
    { getLocalizedError: async () => 'missing fields' }
  );
  return chain.at(-1);
}

async function post(body, user = { id: 'user-1' }) {
  const res = { statusCode: null, status: c => ((res.statusCode = c), res), end: () => res };
  await handler()({ body, user, headers: {} }, res);
  return res;
}

const body = { messageId: 'msg-1', appId: 'chat', chatId: 'chat-1', rating: 5, runId: 'run-new' };

describe('feedback → iFinder routing', () => {
  let sent;

  beforeEach(() => {
    sent = [];
    mock.method(configCache, 'getPlatform', () => ({ defaultLanguage: 'en' }));
    mock.method(iAssistantService, 'getConfig', () => ({ baseUrl: 'https://default.example' }));
    mock.method(conversationApiService, 'sendFeedback', async (...args) => {
      sent.push(args);
    });
    mock.method(conversationStateManager, 'loadState', async () => ({
      ownerId: 'user-1',
      conversationId: 'conv-server',
      baseUrl: 'https://chat.example',
      lastParentId: 'resp-latest',
      responses: { 'run-old': 'resp-old', 'run-new': 'resp-new' }
    }));
  });

  afterEach(() => mock.restoreAll());

  it('forwards the rated answer using the conversation and message id the server holds', async () => {
    const res = await post({ ...body, runId: 'run-old' });

    assert.equal(res.statusCode, 204);
    assert.equal(sent.length, 1);
    const [conversationId, messageId, options] = sent[0];
    assert.equal(conversationId, 'conv-server');
    assert.equal(messageId, 'resp-old', 'the rated answer, not the latest one');
    assert.equal(options.baseUrl, 'https://chat.example');
    assert.equal(options.rating, 100);
  });

  it('ignores ids the client sends', async () => {
    await post({ ...body, conversationId: 'conv-evil', ifinderMessageId: 'msg-evil' });

    assert.equal(sent.length, 1);
    assert.equal(sent[0][0], 'conv-server');
    assert.equal(sent[0][1], 'resp-new');
  });

  it('keeps the feedback local when the run has no recorded iFinder answer', async () => {
    const res = await post({ ...body, runId: 'run-unknown' });

    assert.equal(res.statusCode, 204);
    assert.equal(sent.length, 0);
  });

  it('keeps the feedback local when the chat has no iAssistant conversation', async () => {
    conversationStateManager.loadState.mock.mockImplementation(async () => null);

    const res = await post(body);

    assert.equal(res.statusCode, 204);
    assert.equal(sent.length, 0);
  });

  it('keeps the feedback local for an anonymous user', async () => {
    const res = await post(body, { id: 'anonymous' });

    assert.equal(res.statusCode, 204);
    assert.equal(sent.length, 0);
  });
});

process.on('exit', () => {
  void fs.rm(contentsDir, { recursive: true, force: true });
});
