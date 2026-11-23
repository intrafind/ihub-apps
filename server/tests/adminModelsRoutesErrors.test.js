// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * The model administration routes answer errors through the global error
 * middleware (`{ error, code, details? }`): a missing model, an unsafe id, a
 * the discovery failure of an endpoint and the failed connectivity
 * test of a model.
 *
 * Native ESM, so `jest.unstable_mockModule` + dynamic imports. Run with
 * `NODE_OPTIONS=--experimental-vm-modules`.
 */
import { jest } from '@jest/globals';
import request from 'supertest';
import express from 'express';

const state = { completeError: null };

jest.unstable_mockModule('../middleware/adminAuth.js', () => ({
  adminAuth: (req, res, next) => {
    req.user = { id: 'admin' };
    next();
  }
}));
jest.unstable_mockModule('../services/AuditLogService.js', () => ({ logAudit: async () => {} }));
const realLlm = await import('../services/loop/LLMClient.js');
jest.unstable_mockModule('../services/loop/LLMClient.js', () => ({
  ...realLlm,
  default: {
    complete: async () => {
      throw state.completeError;
    }
  }
}));

const { default: registerAdminModelsRoutes } = await import('../routes/admin/models.js');
const { default: errorHandler } = await import('../middleware/errorHandler.js');
const { default: configCache } = await import('../configCache.js');
const { LLMError } = await import('../services/loop/contracts/errors.js');

const chatModel = { id: 'gpt', modelId: 'gpt-x', provider: 'openai', enabled: true };
// A disabled vLLM server without a key (key status `keyless`).
const keylessModel = {
  id: 'local-vllm',
  modelId: 'qwen',
  provider: 'local',
  url: 'https://vllm.internal:8443/v1/chat/completions',
  enabled: false
};

beforeAll(() => {
  configCache.setCacheEntry('config/models.json', [chatModel, keylessModel]);
});

afterAll(() => {
  const timer = configCache.refreshTimers?.get('config/models.json');
  if (timer) clearTimeout(timer);
  configCache.refreshTimers?.delete('config/models.json');
});

const app = express();
app.use(express.json());
registerAdminModelsRoutes(app);
app.use(errorHandler);

describe('model administration routes: errors', () => {
  it('answers an unsafe model id with BAD_REQUEST and an unknown model with NOT_FOUND', async () => {
    const unsafe = await request(app).get('/api/admin/models/bad%20id').expect(400);
    expect(unsafe.body.code).toBe('BAD_REQUEST');
    const unknown = await request(app).get('/api/admin/models/nope').expect(404);
    expect(unknown.body).toMatchObject({ detail: 'Model not found', code: 'NOT_FOUND' });
  });

  it('answers a new model without the required fields with BAD_REQUEST', async () => {
    const res = await request(app).post('/api/admin/models').send({ id: 'x' }).expect(400);
    expect(res.body).toMatchObject({ detail: 'Missing required fields', code: 'BAD_REQUEST' });
  });

  it('answers a failed discovery with DISCOVERY_FAILED and the key in details', async () => {
    const res = await request(app)
      .post('/api/admin/models/_discover')
      .send({ url: 'ftp://example.com' })
      .expect(400);
    expect(res.body.code).toBe('DISCOVERY_FAILED');
    expect(res.body.details).toMatchObject({ messageKey: 'invalidUrl' });
    expect(typeof res.body.detail).toBe('string');
  });

  it('answers a failed model test with the LLM code, the headline and the remediation', async () => {
    state.completeError = new LLMError('Invalid API key', { code: 'AUTH_FAILED', status: 401 });
    const res = await request(app).post('/api/admin/models/gpt/_test').expect(502);
    expect(res.body.code).toBe('AUTH_FAILED');
    expect(res.body.details).toMatchObject({ messageKey: expect.any(String) });
    expect(typeof res.body.details.remediation).toBe('string');
    expect(typeof res.body.detail).toBe('string');
  });

  it('names the upstream status and host of a failed model test (AI-B10)', async () => {
    state.completeError = new LLMError('LLM API request failed with status 503', {
      code: 'PROVIDER_ERROR',
      status: 503
    });
    const res = await request(app).post('/api/admin/models/local-vllm/_test').expect(502);
    expect(res.body.details).toMatchObject({
      messageKey: 'serverError',
      upstreamStatus: 503,
      host: 'vllm.internal:8443'
    });
  });

  it('reports an untrusted certificate with its code (AI-B10)', async () => {
    state.completeError = new LLMError('fetch failed', {
      code: 'NETWORK',
      providerCode: 'SELF_SIGNED_CERT_IN_CHAIN'
    });
    const res = await request(app).post('/api/admin/models/local-vllm/_test').expect(502);
    expect(res.body.details).toMatchObject({
      messageKey: 'certificateUntrusted',
      errorCode: 'SELF_SIGNED_CERT_IN_CHAIN',
      host: 'vllm.internal:8443'
    });
  });

  it('never calls a 401 of a keyless model a rejected key (AI-B10)', async () => {
    state.completeError = new LLMError('Unauthorized', { code: 'AUTH_FAILED', status: 401 });
    const res = await request(app).post('/api/admin/models/local-vllm/_test').expect(502);
    expect(res.body.details.messageKey).toBe('apiKeyRequired');
    expect(res.body.details.upstreamStatus).toBe(401);
  });

  it('hides the reason of an unexpected failure of a model test', async () => {
    state.completeError = new Error('boom at /srv/secret/path');
    const res = await request(app).post('/api/admin/models/gpt/_test').expect(500);
    expect(res.body.code).toBe('INTERNAL_ERROR');
    expect(JSON.stringify(res.body)).not.toContain('/srv/secret');
  });
});
