// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * `POST /api/completions` falls under the admin rate limit.
 *
 * The route calls a model on the server's credentials for a content admin. It
 * sits outside `/api/admin`, so no limiter covered it. It now shares the
 * admin budget: one counter per user for `/api/admin/...` and
 * `/api/completions` together. Its body and its answer are as they were.
 *
 * The app is built with the real `setupMiddleware` and the real route. Only
 * the first step of the authentication chain is replaced by a stub that signs
 * a request in from a test header, and the model client's `complete` answers
 * from the test.
 *
 * Native ESM: `jest.unstable_mockModule` + dynamic imports.
 */
import { jest } from '@jest/globals';
import request from 'supertest';
import express from 'express';

jest.unstable_mockModule('../middleware/proxyAuth.js', () => ({
  proxyAuth: (req, res, next) => {
    const userId = req.headers['x-test-user'];
    if (userId) {
      req.user = { id: userId, groups: ['builders'], permissions: {}, isContentAdmin: true };
    }
    next();
  }
}));

const { setupMiddleware } = await import('../middleware/setup.js');
const { default: registerAdminPromptsRoutes } = await import('../routes/admin/prompts.js');
const { default: errorHandler } = await import('../middleware/errorHandler.js');
const { default: configCache } = await import('../configCache.js');
const { default: llmClient } = await import('../services/loop/LLMClient.js');

const LIMIT = 3;
const MODEL = {
  id: 'stub-model',
  name: { en: 'Stub model' },
  provider: 'openai',
  modelId: 'stub-1',
  default: true,
  enabled: true
};

const calls = [];
const originalComplete = llmClient.complete;

beforeAll(() => {
  configCache.setCacheEntry('config/models.json', [MODEL]);
  llmClient.complete = async params => {
    calls.push(params);
    return {
      content: 'Hello from the model',
      finishReason: 'stop',
      usage: { promptTokens: 7, completionTokens: 5, totalTokens: 12 }
    };
  };
});

afterAll(() => {
  llmClient.complete = originalComplete;
});

beforeEach(() => {
  calls.length = 0;
});

/** A new app: its limiters start at zero. */
function createTestApp() {
  const app = express();
  setupMiddleware(app, { rateLimit: { adminApi: { limit: LIMIT, windowMs: 60_000 } } });
  registerAdminPromptsRoutes(app);
  app.get('/api/admin/ping', (req, res) => res.json({ user: req.user?.id ?? null }));
  app.use(errorHandler);
  return app;
}

const BODY = {
  messages: [{ role: 'user', content: 'Say hello' }],
  maxTokens: 64
};
const complete = (app, user = 'carol', body = BODY) =>
  request(app).post('/api/completions').set('x-test-user', user).send(body);

describe('POST /api/completions under the admin rate limit', () => {
  test('answers 429 above the admin budget', async () => {
    const app = createTestApp();

    for (let i = 0; i < LIMIT; i += 1) {
      expect((await complete(app)).status).toBe(200);
    }
    const blocked = await complete(app);

    expect(blocked.status).toBe(429);
    expect(blocked.headers['content-type']).toMatch(/application\/problem\+json/);
    expect(blocked.body.code).toBe('RATE_LIMITED');
    expect(blocked.headers['retry-after']).toBeDefined();
    // It is the admin budget, not the draft limit.
    expect(blocked.body.details).toBeUndefined();
    // The request over the budget never reached the model.
    expect(calls).toHaveLength(LIMIT);
  });

  test('shares one budget with /api/admin', async () => {
    const app = createTestApp();

    expect((await request(app).get('/api/admin/ping').set('x-test-user', 'carol')).status).toBe(
      200
    );
    for (let i = 0; i < LIMIT - 1; i += 1) {
      expect((await complete(app)).status).toBe(200);
    }
    expect((await complete(app)).status).toBe(429);
    expect((await request(app).get('/api/admin/ping').set('x-test-user', 'carol')).status).toBe(
      429
    );
  });

  test('counts per user', async () => {
    const app = createTestApp();

    for (let i = 0; i < LIMIT; i += 1) await complete(app, 'carol');
    expect((await complete(app, 'carol')).status).toBe(429);
    expect((await complete(app, 'dave')).status).toBe(200);
  });

  test('keeps its body and its answer', async () => {
    const app = createTestApp();

    const res = await complete(app, 'carol', {
      model: 'stub-model',
      messages: [{ role: 'user', content: 'Say hello' }],
      maxTokens: 64,
      responseFormat: 'json',
      responseSchema: { type: 'object' }
    });

    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      choices: [
        {
          message: { role: 'assistant', content: 'Hello from the model' },
          finish_reason: 'stop',
          index: 0
        }
      ],
      model: 'stub-model',
      usage: expect.objectContaining({ prompt_tokens: 7, completion_tokens: 5, total_tokens: 12 })
    });
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({
      modelId: 'stub-model',
      messages: [{ role: 'user', content: 'Say hello' }],
      options: { maxTokens: 64, responseFormat: 'json', responseSchema: { type: 'object' } },
      retries: 0
    });
  });

  test('still answers 400 for a body without messages and 401 without a sign-in', async () => {
    const app = createTestApp();

    const missing = await complete(app, 'carol', {});
    expect(missing.status).toBe(400);
    expect(missing.body.code).toBe('BAD_REQUEST');

    const anonymous = await request(app).post('/api/completions').send(BODY);
    expect(anonymous.status).toBe(401);
    expect(calls).toHaveLength(0);
  });
});
