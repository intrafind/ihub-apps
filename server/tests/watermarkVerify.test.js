// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * `POST /api/eu-ai-act/provenance/_verify` with the watermark detector (#3331): hash first,
 * then the detector with the active and all retired keys; retired-key detection
 * after rotation; "too short to tell"; the multiplicity correction; a detector
 * that is down never turns the request into a 5xx.
 */
import { describe, test, expect, beforeAll, afterAll, beforeEach } from '@jest/globals';
import express from 'express';
import request from 'supertest';

process.env.TOKEN_ENCRYPTION_KEY = 'b'.repeat(64);

const { default: configCache } = await import('../configCache.js');
const { startTestStorage } = await import('./helpers/testStorage.js');
const { startMockDetector } = await import('./helpers/mockWatermarkDetector.js');
const { default: registerProvenanceRoutes } = await import('../routes/provenanceRoutes.js');
const { default: errorHandler } = await import('../middleware/errorHandler.js');
const { recordTextOutput } = await import('../services/provenance/turnProvenance.js');
const { default: configStore } = await import('../services/config/ConfigStore.js');
const { getWatermarkKeyStore, resetWatermarkKeyStore } =
  await import('../services/provenance/watermark/WatermarkKeyStore.js');
const { decide } = await import('../services/provenance/watermark/detect.js');

const TOKEN = 'verify-token-123456';
let counter = 0;
// A fresh text per use: the record store keeps what an earlier test recorded.
let LONG;
let SHORT;

let storage;
let mock;
let app;
let keys;

const verify = body =>
  request(app).post('/api/eu-ai-act/provenance/_verify').set('x-test-user', 'u1').send(body);

function configure({ detectorUrl = mock.url, extra = {}, platform = {} } = {}) {
  configCache.setCacheEntry('config/platform.json', {
    provenance: {
      verify: { access: 'public' },
      watermark: { detectorTimeoutMs: 1000 },
      ...platform
    },
    rateLimit: {}
  });
  configCache.setCacheEntry('config/models.json', [
    {
      id: 'vl',
      provider: 'local',
      modelId: 'm',
      url: 'http://vllm/v1',
      contentMarking: {
        text: {
          by: 'ihub',
          scheme: 'vllm-gumbel',
          detectorUrl,
          detectorCredentialRef: 'wm',
          tokenizer: 'org/tok',
          ...extra
        }
      }
    }
  ]);
}

beforeAll(async () => {
  storage = await startTestStorage({ prefix: 'ihub-wm-verify-' });
  mock = await startMockDetector({ token: TOKEN });
  configCache.setCacheEntry('config/credentials.json', {
    credentials: { wm: { id: 'wm', type: 'bearer', token: TOKEN } }
  });
  app = express();
  app.use(express.json({ limit: '2mb' }));
  // The route is public here; a signed-in caller is marked by a header.
  app.use((req, _res, next) => {
    if (req.headers['x-test-user']) req.user = { id: 'u1' };
    next();
  });
  registerProvenanceRoutes(app);
  app.use(errorHandler);
});
afterAll(async () => {
  await mock.close();
  await storage.stop();
});
beforeEach(async () => {
  counter += 1;
  LONG = Array.from({ length: 300 }, (_, i) => `word${i}x${counter}`).join(' ');
  SHORT = `just a few words here ${counter}`;
  mock.calls.length = 0;
  mock.setMode('ok');
  resetWatermarkKeyStore();
  await configStore.writeJson('config/watermark-keys.json', { version: 1, nextSeq: {}, keys: [] });
  configure();
  keys = getWatermarkKeyStore();
});

describe('verify with the watermark detector', () => {
  test('a hash hit makes zero detector calls', async () => {
    await keys.create({ key: '1111111111' }, 'a');
    await recordTextOutput({ text: LONG, model: { id: 'vl' }, modelConfig: {} });
    const res = await verify({ text: LONG });
    expect(res.body.found).toBe(true);
    expect(res.body.watermark).toBeUndefined();
    expect(mock.calls).toHaveLength(0);
  });

  test('a miss sends the active and the retired keys and detects the active one', async () => {
    const first = await keys.create({ key: '1111111111' }, 'a');
    const second = await keys.create({ key: '2222222222' }, 'a');
    mock.markText(LONG, second.key);
    const res = await verify({ text: LONG });
    expect(res.status).toBe(200);
    expect(res.body.found).toBe(false);
    expect(res.body.watermark).toMatchObject({
      status: 'detected',
      keyId: second.item.keyId,
      scheme: 'vllm-gumbel',
      technique: 'gumbel-max',
      keysChecked: 2,
      detectorsChecked: 1
    });
    expect(mock.calls[0].body.keys.map(k => k.key_id)).toEqual([
      second.item.keyId,
      first.item.keyId
    ]);
    expect(mock.calls[0].body.text).toBe(LONG); // as given, not normalised
    expect(JSON.stringify(res.body)).not.toMatch(/1111111111|2222222222/);
  });

  test('text made with a retired key is still detected and reports the old key id', async () => {
    const old = await keys.create({ key: '3333333333' }, 'a');
    await keys.create({ key: '4444444444' }, 'a'); // rotation
    mock.markText(LONG, old.key);
    const res = await verify({ text: LONG });
    expect(res.body.watermark).toMatchObject({ status: 'detected', keyId: old.item.keyId });
  });

  test('a short negative is "too short to tell"; a long one is "not detected"', async () => {
    await keys.create({}, 'a');
    expect((await verify({ text: SHORT })).body.watermark.status).toBe('too_short');
    expect((await verify({ text: LONG })).body.watermark.status).toBe('not_detected');
  });

  test('a short positive stays detected', async () => {
    const k = await keys.create({}, 'a');
    mock.markText(SHORT, k.key);
    expect((await verify({ text: SHORT })).body.watermark).toMatchObject({ status: 'detected' });
  });

  test('a detector that is down is "unavailable" with HTTP 200', async () => {
    await keys.create({}, 'a');
    mock.setMode('500');
    const res = await verify({ text: LONG });
    expect(res.status).toBe(200);
    expect(res.body.found).toBe(false);
    expect(res.body.watermark).toEqual({ status: 'unavailable' });
  });

  test('no keys or no detector is "not_configured"', async () => {
    expect((await verify({ text: LONG })).body.watermark).toEqual({ status: 'not_configured' });
    await keys.create({}, 'a');
    configure({ detectorUrl: null });
    expect((await verify({ text: LONG })).body.watermark).toEqual({ status: 'not_configured' });
    expect(mock.calls).toHaveLength(0);
  });

  test('a key id the detector invents is ignored', async () => {
    await keys.create({}, 'a');
    mock.setMode('unknownKey');
    expect((await verify({ text: LONG })).body.watermark.status).toBe('not_detected');
  });

  test('an anonymous caller gets the hash lookup only, and no keys leave iHub', async () => {
    await keys.create({}, 'a');
    const res = await request(app).post('/api/eu-ai-act/provenance/_verify').send({ text: LONG });
    expect(res.body).toEqual({ found: false, normalization: 'nfc-trim' });
    expect(mock.calls).toHaveLength(0);
  });

  test('modelId narrows the detectors; a contentHash lookup never runs the detector', async () => {
    await keys.create({}, 'a');
    expect((await verify({ text: LONG, modelId: 'other' })).body.watermark.status).toBe(
      'not_configured'
    );
    const hash = 'a'.repeat(64);
    expect((await verify({ contentHash: hash })).body.watermark).toBeUndefined();
  });
});

describe('decide (multiplicity)', () => {
  const detector = { scheme: 'vllm-gumbel' };
  const outcome = pValue => ({
    detector,
    keys: ['wm-1', 'wm-2'],
    numScoredTokens: 300,
    results: [
      { keyId: 'wm-1', pValue },
      { keyId: 'wm-2', pValue: 0.5 }
    ]
  });
  const settings = { alpha: 1e-4, minScoredTokens: 200 };

  test('with two keys a p-value between alpha/2 and alpha is not detected', () => {
    expect(decide([outcome(8e-5)], settings).status).toBe('not_detected');
    expect(decide([outcome(4e-5)], settings).status).toBe('detected');
  });
});
