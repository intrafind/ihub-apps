// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * Error answers of the chat session routes. The handlers throw `ServiceError` (or let an
 * `LLMError` propagate) and the global error middleware answers with `application/problem+json`.
 *
 * Native ESM: `jest.unstable_mockModule` + dynamic imports.
 */
import { jest } from '@jest/globals';
import express from 'express';
import request from 'supertest';

import configCache from '../configCache.js';
import llmClient from '../services/loop/LLMClient.js';
import { LLMError, LLM_ERROR_CODES } from '../services/loop/contracts/errors.js';

// chatAccess.js exports only `authorizeChat`, so the mock needs no spread of the real module.
// The real auth middleware runs: the stub user below carries wildcard permissions.
const authorizeChat = jest.fn();
jest.unstable_mockModule('../services/chat/chatAccess.js', () => ({
  authorizeChat: (...args) => authorizeChat(...args)
}));

const { default: registerSessionRoutes } = await import('../routes/chat/sessionRoutes.js');
const { default: errorHandler } = await import('../middleware/errorHandler.js');

function buildApp() {
  const app = express();
  app.use(express.json());
  app.use((req, res, next) => {
    req.user = {
      id: 'user-1',
      groups: ['users'],
      permissions: { apps: new Set(['*']), models: new Set(['*']) }
    };
    next();
  });
  registerSessionRoutes(app, {
    getLocalizedError: async code => `localized:${code}`,
    DEFAULT_TIMEOUT: 5000
  });
  app.use(errorHandler);
  return app;
}

function expectProblem(res, status, code) {
  expect(res.status).toBe(status);
  expect(res.headers['content-type']).toMatch(/application\/problem\+json/);
  expect(res.body.code).toBe(code);
  expect(res.body.status).toBe(status);
}

describe('GET /api/models/:modelId/chat/test', () => {
  let app;
  let complete;

  beforeEach(() => {
    app = buildApp();
    jest.spyOn(configCache, 'getPlatform').mockReturnValue({
      defaultLanguage: 'en',
      anonymousAuth: { enabled: true },
      // These tests are about the error shape, not the AI-use acknowledgement (428).
      aiAcknowledgement: { enabled: false }
    });
    jest
      .spyOn(configCache, 'getModels')
      .mockReturnValue({ data: [{ id: 'gpt', provider: 'openai', modelId: 'x' }] });
    complete = jest.spyOn(llmClient, 'complete');
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  test('answers 500 INTERNAL_ERROR when the models cache is null', async () => {
    configCache.getModels.mockReturnValue({ data: null });
    const res = await request(app).get('/api/models/gpt/chat/test');
    expectProblem(res, 500, 'INTERNAL_ERROR');
    expect(complete).not.toHaveBeenCalled();
  });

  test('answers 404 NOT_FOUND for an unknown model', async () => {
    const res = await request(app).get('/api/models/nope/chat/test');
    expectProblem(res, 404, 'NOT_FOUND');
    expect(res.body.detail).toBe('Model not found');
    expect(complete).not.toHaveBeenCalled();
  });

  test('answers 200 with the model result on success', async () => {
    complete.mockResolvedValue({
      content: 'Hello',
      finishReason: 'stop',
      usage: { promptTokens: 1, completionTokens: 2 }
    });
    const res = await request(app).get('/api/models/GPT/chat/test');
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ model: 'gpt', content: 'Hello' });
  });

  test('maps an LLMError to its canonical status and code', async () => {
    complete.mockRejectedValue(
      new LLMError('provider said no sk-secret', {
        code: LLM_ERROR_CODES.RATE_LIMITED,
        retryAfterMs: 3000
      })
    );
    const res = await request(app).get('/api/models/gpt/chat/test');
    expectProblem(res, 429, 'RATE_LIMITED');
    expect(res.headers['retry-after']).toBe('3');
    expect(JSON.stringify(res.body)).not.toContain('sk-secret');
  });

  test('maps a provider failure to 502 PROVIDER_ERROR', async () => {
    complete.mockRejectedValue(
      new LLMError('boom', { code: LLM_ERROR_CODES.PROVIDER_ERROR, status: 500 })
    );
    const res = await request(app).get('/api/models/gpt/chat/test');
    expectProblem(res, 502, 'PROVIDER_ERROR');
  });

  test('answers 504 TIMEOUT for a timed-out model call', async () => {
    complete.mockRejectedValue(new LLMError('slow', { code: LLM_ERROR_CODES.TIMEOUT }));
    const res = await request(app).get('/api/models/gpt/chat/test');
    expectProblem(res, 504, 'TIMEOUT');
  });

  test('answers 500 INTERNAL_ERROR for an unexpected error without leaking its message', async () => {
    complete.mockRejectedValue(new Error('db password is hunter2'));
    const res = await request(app).get('/api/models/gpt/chat/test');
    expectProblem(res, 500, 'INTERNAL_ERROR');
    expect(JSON.stringify(res.body)).not.toContain('hunter2');
  });
});

describe('chat session lookups', () => {
  let app;

  beforeEach(() => {
    app = buildApp();
    authorizeChat.mockResolvedValue({ ok: false });
    jest.spyOn(configCache, 'getPlatform').mockReturnValue({
      defaultLanguage: 'en',
      anonymousAuth: { enabled: true },
      // The AI-use acknowledgement is off here; its own test below turns it on.
      aiAcknowledgement: { enabled: false }
    });
    jest.spyOn(configCache, 'getApps').mockReturnValue({ data: [] });
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  test('POST without the AI-use acknowledgement answers 428 before anything runs', async () => {
    configCache.getPlatform.mockReturnValue({
      defaultLanguage: 'en',
      anonymousAuth: { enabled: true },
      aiAcknowledgement: { enabled: true, enforce: true, requiredVersion: 1 }
    });
    const res = await request(app)
      .post('/api/apps/chat/chat/chat-unknown')
      .send({ messages: [{ role: 'user', content: 'hi' }] });
    expectProblem(res, 428, 'AI_ACKNOWLEDGEMENT_REQUIRED');
    expect(res.body.details).toMatchObject({ requiredVersion: 1 });
    // Refused before the chat was looked up or any side effect ran.
    expect(authorizeChat).not.toHaveBeenCalled();
  });

  test('POST answers 404 NOT_FOUND for an unknown chat, not the generic 500', async () => {
    const res = await request(app)
      .post('/api/apps/chat/chat/chat-unknown')
      .send({ messages: [{ role: 'user', content: 'hi' }] });
    expectProblem(res, 404, 'NOT_FOUND');
    expect(res.body.detail).toBe('Chat session not found');
    expect(authorizeChat).toHaveBeenCalledWith('chat-unknown', expect.any(Object), {
      intent: 'write'
    });
  });

  test('GET (SSE connect) answers 404 for an unknown chat before any SSE header', async () => {
    const res = await request(app).get('/api/apps/chat/chat/chat-unknown');
    expectProblem(res, 404, 'NOT_FOUND');
    expect(res.headers['content-type']).not.toMatch(/text\/event-stream/);
  });

  test('GET (SSE connect) refuses a project member, who may read the transcript only', async () => {
    authorizeChat.mockResolvedValue({ ok: true, viaProject: true });
    const res = await request(app).get('/api/apps/chat/chat/chat-unknown');
    expectProblem(res, 404, 'NOT_FOUND');
  });
});
