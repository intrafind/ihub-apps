// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * The watermark detector test and self-test (#3331): the probe uses a throwaway
 * key, the self-test samples at temperature 1 and diagnoses a key mismatch,
 * and the admin routes expose them. No key or token reaches a log line.
 */
import { jest, describe, test, expect, beforeAll, afterAll, beforeEach } from '@jest/globals';
import express from 'express';
import request from 'supertest';

process.env.TOKEN_ENCRYPTION_KEY = 'd'.repeat(64);

const { ServiceError } = await import('../utils/ServiceError.js');
jest.unstable_mockModule('../middleware/adminAuth.js', () => ({
  adminAuth: (req, res, next) =>
    req.headers['x-role'] === 'admin'
      ? ((req.user = { id: 'admin' }), next())
      : next(new ServiceError('AUTH_REQUIRED', 'no'))
}));
const audits = [];
jest.unstable_mockModule('../services/AuditLogService.js', () => ({
  logAudit: entry => {
    audits.push(JSON.parse(JSON.stringify({ ...entry, req: undefined })));
    return { id: 'x' };
  }
}));
const fake = { complete: jest.fn() };
jest.unstable_mockModule('../services/loop/LLMClient.js', () => ({ default: fake }));
const lines = [];
const capture = level => (message, meta) => lines.push(JSON.stringify({ level, message, meta }));
jest.unstable_mockModule('../utils/logger.js', () => ({
  default: { info: capture('i'), warn: capture('w'), error: capture('e'), debug: capture('d') }
}));

const { default: configCache } = await import('../configCache.js');
const { startTestStorage } = await import('./helpers/testStorage.js');
const { startMockDetector } = await import('./helpers/mockWatermarkDetector.js');
const { default: configStore } = await import('../services/config/ConfigStore.js');
const { getWatermarkKeyStore, resetWatermarkKeyStore } =
  await import('../services/provenance/watermark/WatermarkKeyStore.js');
const { runSelfTest, pingDetector } = await import('../services/provenance/watermark/selfTest.js');
const { default: registerRoutes } = await import('../routes/admin/watermarkDetectors.js');
const { default: errorHandler } = await import('../middleware/errorHandler.js');
const { setActiveKeyIdSnapshot } =
  await import('../services/provenance/watermark/activeKeySnapshot.js');

const TOKEN = 'selftest-token-123456';
const ANSWER = Array.from({ length: 300 }, (_, i) => `tok${i}`).join(' ');
let storage;
let mock;
let model;
let app;

beforeAll(async () => {
  storage = await startTestStorage({ prefix: 'ihub-wm-self-' });
  mock = await startMockDetector({ token: TOKEN });
  configCache.setCacheEntry('config/credentials.json', {
    credentials: { wm: { id: 'wm', type: 'bearer', token: TOKEN } }
  });
  model = {
    id: 'vl',
    provider: 'local',
    modelId: 'm',
    url: 'http://vllm/v1',
    sampling: { temperature: 0 },
    contentMarking: {
      text: {
        by: 'ihub',
        scheme: 'vllm-gumbel',
        detectorUrl: mock.url,
        detectorCredentialRef: 'wm'
      }
    }
  };
  configCache.setCacheEntry('config/models.json', [model, { id: 'plain', provider: 'local' }]);
  app = express();
  app.use(express.json());
  registerRoutes(app);
  app.use(errorHandler);
});
afterAll(async () => {
  await mock.close();
  await storage.stop();
});
beforeEach(async () => {
  mock.calls.length = 0;
  mock.setMode('ok');
  audits.length = 0;
  lines.length = 0;
  resetWatermarkKeyStore();
  await configStore.writeJson('config/watermark-keys.json', { version: 1, nextSeq: {}, keys: [] });
  fake.complete.mockReset();
  fake.complete.mockResolvedValue({
    content: ANSWER,
    marking: { text: { by: 'ihub', applied: true, keyId: 'wm-2026-2' } }
  });
});

describe('pingDetector', () => {
  test('uses a throwaway key, never a stored one', async () => {
    const store = getWatermarkKeyStore();
    const real = await store.create({ key: '8888888888' }, 'a');
    const result = await pingDetector(model);
    expect(result).toMatchObject({ reachable: true, authenticated: true, contractValid: true });
    expect(mock.calls[0].body.keys).toHaveLength(1);
    expect(mock.calls[0].body.keys[0].key).not.toBe(real.key);
    expect(JSON.stringify(mock.calls[0].body)).not.toContain('8888888888');
  });

  test('an unauthorised, broken or down detector is a result, not an error', async () => {
    mock.setMode('401');
    expect(await pingDetector(model)).toMatchObject({ reachable: true, authenticated: false });
    mock.setMode('badJson');
    expect(await pingDetector(model)).toMatchObject({ reachable: true, contractValid: false });
    mock.setMode('500');
    expect(await pingDetector(model)).toMatchObject({ reachable: true, contractValid: false });
  });

  test('a model without detector settings is WATERMARK_DETECTOR_NOT_CONFIGURED', async () => {
    const bare = { ...model, contentMarking: { text: { by: 'ihub', scheme: 'vllm-gumbel' } } };
    await expect(pingDetector(bare)).rejects.toMatchObject({
      code: 'WATERMARK_DETECTOR_NOT_CONFIGURED'
    });
  });
});

describe('runSelfTest', () => {
  test('samples at temperature 1 whatever the model sets and reports keys_match', async () => {
    const store = getWatermarkKeyStore();
    await store.create({ key: '1010101010' }, 'a');
    const active = await store.create({ key: '2020202020' }, 'a');
    mock.markText(ANSWER, active.key);
    const result = await runSelfTest(model, { llmClient: fake });
    expect(fake.complete.mock.calls[0][0].model.sampling).toEqual({ temperature: 1 });
    expect(model.sampling).toEqual({ temperature: 0 }); // the stored model is untouched
    expect(result).toMatchObject({
      ok: true,
      diagnosis: 'keys_match',
      status: 'detected',
      matchedKeyId: active.item.keyId
    });
  });

  test('matches_retired_key when vLLM still runs the old key', async () => {
    const store = getWatermarkKeyStore();
    const old = await store.create({ key: '1010101010' }, 'a');
    await store.create({ key: '2020202020' }, 'a');
    mock.markText(ANSWER, old.key);
    const result = await runSelfTest(model, { llmClient: fake });
    expect(result).toMatchObject({
      ok: false,
      diagnosis: 'matches_retired_key',
      matchedKeyId: old.item.keyId
    });
  });

  test('no_watermark_found, detector_unreachable, no_keys, not_applied', async () => {
    const store = getWatermarkKeyStore();
    expect((await runSelfTest(model, { llmClient: fake })).diagnosis).toBe('no_keys');
    await store.create({}, 'a');
    expect((await runSelfTest(model, { llmClient: fake })).diagnosis).toBe('no_watermark_found');
    mock.setMode('500');
    expect((await runSelfTest(model, { llmClient: fake })).diagnosis).toBe('detector_unreachable');
    mock.setMode('ok');
    fake.complete.mockResolvedValue({
      content: 'x',
      marking: { text: { by: 'ihub', applied: false, reason: 'no_active_key' } }
    });
    expect(await runSelfTest(model, { llmClient: fake })).toMatchObject({
      diagnosis: 'not_applied',
      reason: 'no_active_key'
    });
  });
});

describe('admin routes', () => {
  const admin = r => r.set('x-role', 'admin');

  test('need an admin', async () => {
    expect((await request(app).get('/api/admin/watermark-detectors')).status).toBe(401);
    expect((await request(app).post('/api/admin/watermark-detectors/vl/_test')).status).toBe(401);
    expect((await request(app).post('/api/admin/watermark-detectors/vl/_self-test')).status).toBe(
      401
    );
  });

  test('list shows the static configuration of marked models only, with no network call', async () => {
    setActiveKeyIdSnapshot('wm-2026-1');
    const res = await admin(request(app).get('/api/admin/watermark-detectors'));
    expect(res.status).toBe(200);
    expect(res.body.nextCursor).toBeNull();
    expect(res.body.items).toHaveLength(1);
    expect(res.body.items[0]).toMatchObject({
      modelId: 'vl',
      detectorUrl: mock.url,
      credentialRef: 'wm',
      algorithm: 'gumbel',
      prf: 'philox',
      contextWidth: 4,
      hasActiveKey: true,
      urlPolicyOk: true
    });
    expect(mock.calls).toHaveLength(0);
  });

  test('_test answers 200 with the result; an unmarked model is 404; no detector is 409', async () => {
    const ok = await admin(request(app).post('/api/admin/watermark-detectors/vl/_test'));
    expect(ok.status).toBe(200);
    expect(ok.body).toMatchObject({ reachable: true, authenticated: true, contractValid: true });
    mock.setMode('500');
    expect((await admin(request(app).post('/api/admin/watermark-detectors/vl/_test'))).status).toBe(
      200
    );
    expect(
      (await admin(request(app).post('/api/admin/watermark-detectors/plain/_test'))).status
    ).toBe(404);
    configCache.setCacheEntry('config/models.json', [
      { ...model, contentMarking: { text: { by: 'ihub', scheme: 'vllm-gumbel' } } }
    ]);
    const none = await admin(request(app).post('/api/admin/watermark-detectors/vl/_test'));
    expect(none.status).toBe(409);
    expect(none.body.code).toBe('WATERMARK_DETECTOR_NOT_CONFIGURED');
    configCache.setCacheEntry('config/models.json', [model, { id: 'plain', provider: 'local' }]);
  });

  test('_self-test is audited as execute, and no key or token reaches a log or the audit entry', async () => {
    const store = getWatermarkKeyStore();
    const created = await store.create({ key: '6060606060' }, 'a');
    mock.markText(ANSWER, created.key);
    const res = await admin(request(app).post('/api/admin/watermark-detectors/vl/_self-test'));
    expect(res.status).toBe(200);
    expect(res.body.diagnosis).toBe('keys_match');
    expect(audits).toHaveLength(1);
    expect(audits[0]).toMatchObject({
      action: 'execute',
      resource: 'watermarkDetector',
      resourceId: 'vl'
    });
    const everything = JSON.stringify([audits, lines, res.body]);
    expect(everything).not.toContain('6060606060');
    expect(everything).not.toContain(TOKEN);
  });
});
