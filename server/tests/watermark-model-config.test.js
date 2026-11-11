// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * `contentMarking.text` for iHub's own text watermark (#3331): which providers
 * may use `by: "ihub"`, what the detector fields must look like, and that the
 * public model routes never expose the detector address or credential.
 */
import { jest, describe, test, expect } from '@jest/globals';
import request from 'supertest';
import express from 'express';

const state = { models: { data: [] } };
const realCache = (await import('../configCache.js')).default;
jest.unstable_mockModule('../configCache.js', async () => ({
  default: Object.assign(Object.create(realCache), {
    getPlatform: () => ({ defaultLanguage: 'en' }),
    getModels: () => state.models,
    getModelsForUser: async () => ({ ...state.models, etag: 'e' })
  })
}));
const real0 = await import('../middleware/authRequired.js');
jest.unstable_mockModule('../middleware/authRequired.js', async () => ({
  ...real0,
  authRequired: (req, res, next) => next(),
  appAccessRequired: (req, res, next) => next()
}));

const { modelConfigSchema } = await import('../validators/modelConfigSchema.js');
const { default: registerModelRoutes } = await import('../routes/modelRoutes.js');
const { default: errorHandler } = await import('../middleware/errorHandler.js');

const base = {
  id: 'm',
  modelId: 'm',
  name: { en: 'M' },
  description: { en: 'M' },
  url: 'http://localhost/v1',
  provider: 'local',
  contextWindow: 1000,
  maxOutputTokens: 100
};
const text = extra => ({
  contentMarking: { text: { by: 'ihub', scheme: 'vllm-gumbel', ...extra } }
});
const ok = model => modelConfigSchema.safeParse(model).success;

describe('contentMarking by "ihub"', () => {
  test('is valid for local and openai (vLLM), with detector settings', () => {
    const detector = {
      detectorUrl: 'https://detector.internal:8443/detect',
      detectorCredentialRef: 'wm-detector',
      tokenizer: 'org/tok',
      algorithm: 'gumbel',
      prf: 'philox',
      contextWidth: 4
    };
    expect(ok({ ...base, ...text(detector) })).toBe(true);
    expect(ok({ ...base, provider: 'openai', ...text(detector) })).toBe(true);
  });

  test.each(['anthropic', 'google', 'mistral', 'bedrock'])('is rejected for %s', provider => {
    const result = modelConfigSchema.safeParse({ ...base, provider, ...text() });
    expect(result.success).toBe(false);
    expect(JSON.stringify(result.error.issues)).toContain('vLLM');
  });

  test('rejects keyId, another scheme, bad detector fields', () => {
    expect(ok({ ...base, ...text({ keyId: 'wm-2026-1' }) })).toBe(false);
    expect(
      modelConfigSchema.safeParse({
        ...base,
        contentMarking: { text: { by: 'ihub', scheme: 'synthid' } }
      }).success
    ).toBe(false);
    expect(ok({ ...base, ...text({ detectorUrl: 'ftp://x/detect' }) })).toBe(false);
    expect(ok({ ...base, ...text({ detectorUrl: 'not a url' }) })).toBe(false);
    expect(ok({ ...base, ...text({ contextWidth: 0 }) })).toBe(false);
    expect(ok({ ...base, ...text({ contextWidth: 17 }) })).toBe(false);
    expect(ok({ ...base, ...text({ contextWidth: 16 }) })).toBe(true);
    expect(ok({ ...base, ...text({ algorithm: 'dual_key_gumbel' }) })).toBe(false);
  });

  test('detector fields belong to by "ihub" only', () => {
    expect(
      ok({
        ...base,
        contentMarking: { text: { by: 'provider', detectorUrl: 'https://d.example/detect' } }
      })
    ).toBe(false);
  });
});

describe('public model routes', () => {
  const app = express();
  app.use((req, _res, next) => {
    req.user = { id: 'u', permissions: { apps: new Set(['*']), models: new Set(['*']) } };
    next();
  });
  registerModelRoutes(app, { getLocalizedError: async () => 'Not found' });
  app.use(errorHandler);

  test('the list and a single model hide detector address, credential, tokenizer and statement', async () => {
    state.models = {
      data: [
        {
          ...base,
          ...text({
            detectorUrl: 'https://detector.internal:8443/detect',
            detectorCredentialRef: 'wm-detector',
            tokenizer: 'org/tok',
            statementRef: 'internal-doc'
          })
        }
      ]
    };
    for (const url of ['/api/models', '/api/models/m']) {
      const res = await request(app).get(url);
      expect(res.status).toBe(200);
      const body = JSON.stringify(res.body);
      for (const secret of ['detector.internal', 'wm-detector', 'org/tok', 'internal-doc']) {
        expect(body).not.toContain(secret);
      }
      expect(body).toContain('"by":"ihub"');
      expect(body).toContain('vllm-gumbel');
    }
  });
});
