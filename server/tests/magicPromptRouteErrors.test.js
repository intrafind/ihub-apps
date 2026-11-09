// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * The magic-prompt route answers errors through the global error middleware:
 * validation and permission failures are ServiceErrors, provider failures
 * (LLMError) keep their mapped status.
 *
 * Run with `NODE_OPTIONS=--experimental-vm-modules`.
 */
import { jest } from '@jest/globals';
import request from 'supertest';
import express from 'express';
import { LLMError, LLM_ERROR_CODES } from '../services/loop/contracts/errors.js';

const state = { models: [], apps: [], allowed: () => true };

jest.unstable_mockModule('../configCache.js', () => ({
  default: {
    getModels: () => ({ data: state.models }),
    getApps: () => ({ data: state.apps }),
    getPlatform: () => ({})
  }
}));
jest.unstable_mockModule('../middleware/authRequired.js', () => ({
  authRequired: (req, res, next) => next()
}));
jest.unstable_mockModule('../validators/validate.js', () => ({
  default: () => (req, res, next) => next()
}));
const realAuthz = await import('../utils/authorization.js');
jest.unstable_mockModule('../utils/authorization.js', () => ({
  ...realAuthz,
  canUserAccessResource: (user, type, id) => state.allowed(type, id)
}));
const realMetrics = await import('../telemetry/metrics.js');
jest.unstable_mockModule('../telemetry/metrics.js', () => ({
  ...realMetrics,
  recordMagicPromptUsage: () => {}
}));
jest.unstable_mockModule('../utils/logger.js', () => ({
  default: { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} }
}));

const { default: registerMagicPromptRoutes } = await import('../routes/magicPromptRoutes.js');
const { default: errorHandler } = await import('../middleware/errorHandler.js');

let llm;
const app = express();
app.use(express.json());
app.use((req, res, next) => {
  req.user = { id: 'u1', groups: ['users'] };
  next();
});
registerMagicPromptRoutes(app, { llmClient: { complete: (...a) => llm(...a) } });
app.use(errorHandler);

beforeEach(() => {
  state.models = [{ id: 'm1', modelType: 'chat' }];
  state.apps = [];
  state.allowed = () => true;
  llm = async () => ({ content: 'better' });
});

describe('POST /api/magic-prompt errors', () => {
  it('answers a missing input with BAD_REQUEST', async () => {
    const res = await request(app).post('/api/magic-prompt').send({});
    expect(res.status).toBe(400);
    expect(res.headers['content-type']).toMatch(/application\/problem\+json/);
    expect(res.body.code).toBe('BAD_REQUEST');
  });

  it('answers an unknown app with NOT_FOUND', async () => {
    const res = await request(app).post('/api/magic-prompt').send({ input: 'x', appId: 'nope' });
    expect(res.status).toBe(404);
    expect(res.body.code).toBe('NOT_FOUND');
  });

  it('answers a platform without models with INTERNAL_ERROR', async () => {
    state.models = [];
    const res = await request(app).post('/api/magic-prompt').send({ input: 'x' });
    expect(res.status).toBe(500);
    expect(res.body.code).toBe('INTERNAL_ERROR');
  });

  it('keeps the mapped status and code of a provider failure with a known code', async () => {
    llm = async () => {
      throw new LLMError('slow', { code: LLM_ERROR_CODES.TIMEOUT });
    };
    const res = await request(app).post('/api/magic-prompt').send({ input: 'x' });
    expect(res.status).toBe(504);
    expect(res.headers['content-type']).toMatch(/application\/problem\+json/);
    expect(res.body.code).toBe('TIMEOUT');
  });

  it('answers a provider failure with an unknown code as a 502 PROVIDER_ERROR', async () => {
    llm = async () => {
      throw new LLMError('boom sk-secret', { code: 'SOMETHING_NEW', status: 500 });
    };
    const res = await request(app).post('/api/magic-prompt').send({ input: 'x' });
    expect(res.status).toBe(502);
    expect(res.body.code).toBe('PROVIDER_ERROR');
    expect(JSON.stringify(res.body)).not.toContain('sk-secret');
  });

  it('answers a model the caller may not use with FORBIDDEN', async () => {
    state.allowed = type => type !== 'models';
    const res = await request(app).post('/api/magic-prompt').send({ input: 'x', modelId: 'm1' });
    expect(res.status).toBe(403);
    expect(res.body.code).toBe('FORBIDDEN');
  });
});
