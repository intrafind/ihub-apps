// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * The admin translate route answers errors through the global error
 * middleware: missing fields, no usable model, a failing model call (by its
 * LLM code) and an unexpected failure.
 *
 * Native ESM, so `jest.unstable_mockModule` + dynamic imports. Run with
 * `NODE_OPTIONS=--experimental-vm-modules`.
 */
import { jest } from '@jest/globals';
import request from 'supertest';
import express from 'express';

const state = { models: [{ id: 'm1', default: true }], completeError: null };

jest.unstable_mockModule('../middleware/adminAuth.js', () => ({
  adminAuth: (req, res, next) => {
    req.user = { id: 'admin' };
    next();
  }
}));
jest.unstable_mockModule('../configCache.js', () => ({
  default: { getModels: () => ({ data: state.models }) }
}));
const realLlm = await import('../services/loop/LLMClient.js');
jest.unstable_mockModule('../services/loop/LLMClient.js', () => ({
  ...realLlm,
  default: {
    complete: async () => {
      if (state.completeError) throw state.completeError;
      return { content: 'Hallo' };
    }
  }
}));

const { default: registerAdminTranslateRoute } = await import('../routes/admin/translate.js');
const { default: errorHandler } = await import('../middleware/errorHandler.js');
const { LLMError } = await import('../services/loop/contracts/errors.js');

const app = express();
app.use(express.json());
registerAdminTranslateRoute(app);
app.use(errorHandler);

beforeEach(() => {
  state.models = [{ id: 'm1', default: true }];
  state.completeError = null;
});

describe('admin translate route: errors', () => {
  it('answers missing fields with BAD_REQUEST', async () => {
    const res = await request(app).post('/api/admin/translate').send({ text: 'Hello' }).expect(400);
    expect(res.headers['content-type']).toMatch(/application\/problem\+json/);
    expect(res.body).toMatchObject({ code: 'BAD_REQUEST', detail: 'Missing required fields' });
  });

  it('translates when a model is available', async () => {
    const res = await request(app)
      .post('/api/admin/translate')
      .send({ text: 'Hello', to: 'de' })
      .expect(200);
    expect(res.body).toEqual({ translation: 'Hallo' });
  });

  it('answers a missing model with a 500 that does not leak the cause', async () => {
    state.models = [];
    const res = await request(app)
      .post('/api/admin/translate')
      .send({ text: 'Hello', to: 'de' })
      .expect(500);
    expect(res.body.code).toBe('INTERNAL_ERROR');
  });

  it('answers a failing model call with its LLM code', async () => {
    state.completeError = new LLMError('Invalid API key', { code: 'AUTH_FAILED', status: 401 });
    const res = await request(app)
      .post('/api/admin/translate')
      .send({ text: 'Hello', to: 'de' })
      .expect(502);
    expect(res.body.code).toBe('AUTH_FAILED');
  });

  it('hides the reason of an unexpected failure', async () => {
    state.completeError = new Error('boom at /srv/secret/path');
    const res = await request(app)
      .post('/api/admin/translate')
      .send({ text: 'Hello', to: 'de' })
      .expect(500);
    expect(JSON.stringify(res.body)).not.toContain('/srv/secret');
  });
});
