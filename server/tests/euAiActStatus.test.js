// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * The status of the EU AI Act overview page (#3329): the pure checks (table
 * driven), the status document against a mock detector (up, wrong token, down),
 * the probe cache, no secret anywhere in the answer, auth on the route, and the
 * stored self-test result. The SSL whitelist of the detector call itself is
 * covered by `detectorClient.ssl-whitelist.test.js`; the probe only reuses that
 * call, and a source check below keeps a bare `fetch` out of this feature.
 */
import { jest, describe, test, expect, beforeAll, afterAll, beforeEach } from '@jest/globals';
import express from 'express';
import request from 'supertest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

process.env.TOKEN_ENCRYPTION_KEY = 'e'.repeat(64);

const { ServiceError } = await import('../utils/ServiceError.js');
jest.unstable_mockModule('../middleware/adminAuth.js', () => ({
  adminAuth: (req, res, next) =>
    req.headers['x-role'] === 'admin'
      ? ((req.user = { id: 'admin' }), next())
      : next(new ServiceError(req.headers['x-role'] ? 'FORBIDDEN' : 'AUTH_REQUIRED', 'no'))
}));
jest.unstable_mockModule('../services/AuditLogService.js', () => ({
  logAudit: () => ({ id: 'x' })
}));
jest.unstable_mockModule('../services/loop/LLMClient.js', () => ({
  default: { complete: jest.fn() }
}));
jest.unstable_mockModule('../utils/logger.js', () => ({
  default: { info() {}, warn() {}, error() {}, debug() {} }
}));

const { default: configCache } = await import('../configCache.js');
const { startTestStorage } = await import('./helpers/testStorage.js');
const { startMockDetector } = await import('./helpers/mockWatermarkDetector.js');
const { default: configStore } = await import('../services/config/ConfigStore.js');
const { getWatermarkKeyStore, resetWatermarkKeyStore } =
  await import('../services/provenance/watermark/WatermarkKeyStore.js');
const { setActiveKeyIdSnapshot } =
  await import('../services/provenance/watermark/activeKeySnapshot.js');
const { LEVEL, modelChecks, platformChecks, worstLevel } =
  await import('../services/euAiAct/checks.js');
const { clearProbeCache, probeDetector, PROBE_TIMEOUT_MS } =
  await import('../services/euAiAct/detectorProbe.js');
const { recordSelfTest, selfTestSummary, stateOfDiagnosis, readSelfTests } =
  await import('../services/euAiAct/selfTestStore.js');
const { default: registerRoutes } = await import('../routes/admin/euAiAct.js');
const { default: errorHandler } = await import('../middleware/errorHandler.js');

const TOKEN = 'status-token-98765432';
const KEY_VALUE = '7777777777';
let storage;
let mock;
let app;

const ihubModel = (extra = {}) => ({
  id: 'vl',
  enabled: true,
  provider: 'local',
  modelId: 'm',
  name: { en: 'Llama' },
  contentMarking: {
    text: {
      by: 'ihub',
      scheme: 'vllm-gumbel',
      detectorUrl: mock?.url || 'http://127.0.0.1:1',
      detectorCredentialRef: 'wm',
      ...extra
    }
  }
});

beforeAll(async () => {
  storage = await startTestStorage({ prefix: 'ihub-euaiact-' });
  mock = await startMockDetector({ token: TOKEN });
  app = express();
  app.use(express.json());
  registerRoutes(app);
  app.use(errorHandler);
});
afterAll(async () => {
  await mock.close();
  await storage.stop();
  configCache.setCacheEntry('config/platform.json', {});
});
beforeEach(async () => {
  mock.calls.length = 0;
  mock.setMode('ok');
  clearProbeCache();
  resetWatermarkKeyStore();
  await configStore.writeJson('config/watermark-keys.json', { version: 1, nextSeq: {}, keys: [] });
  await configStore.writeJson('config/eu-ai-act-self-tests.json', {});
  configCache.setCacheEntry('config/credentials.json', {
    credentials: { wm: { id: 'wm', type: 'bearer', token: TOKEN } }
  });
  configCache.setCacheEntry('config/platform.json', {});
  configCache.setCacheEntry('config/models.json', [ihubModel()]);
});

const ok = { enabled: true, enforce: true, requiredVersion: 3 };
const prov = { storeRecords: true, retentionDays: 365 };
const find = (checks, id) => checks.find(c => c.id === id);

describe('platform checks', () => {
  test.each([
    [
      'defaults',
      {},
      ok,
      prov,
      { 'notice.enabled': 'ok', 'ack.enforcement': 'ok', 'provenance.records': 'ok' }
    ],
    [
      'notice off',
      { aiDisclosure: { firstTurnNotice: { enabled: false } } },
      ok,
      prov,
      { 'notice.enabled': 'warn' }
    ],
    ['ack off', {}, { ...ok, enabled: false }, prov, { 'ack.enabled': 'warn' }],
    ['not enforced', {}, { ...ok, enforce: false }, prov, { 'ack.enforcement': 'warn' }],
    [
      'records not stored',
      {},
      ok,
      { ...prov, storeRecords: false },
      { 'provenance.records': 'warn' }
    ],
    [
      'retention 0 is forever, not a warning',
      {},
      ok,
      { ...prov, retentionDays: 0 },
      { 'provenance.records': 'ok' }
    ]
  ])('%s', (_name, platform, acknowledgements, provenance, expected) => {
    const checks = platformChecks({ platform, acknowledgements, provenance });
    for (const [id, level] of Object.entries(expected)) expect(find(checks, id).level).toBe(level);
    expect(find(checks, 'guardrail.active').level).toBe('ok');
  });

  test('a disabled acknowledgement has no enforcement row', () => {
    const checks = platformChecks({
      platform: {},
      acknowledgements: { ...ok, enabled: false },
      provenance: prov
    });
    expect(find(checks, 'ack.enforcement')).toBeUndefined();
  });
});

describe('model checks', () => {
  const context = (extra = {}) => ({
    activeKeyId: 'wm-2026-1',
    probe: { reachable: true, authenticated: true, contractValid: true, latencyMs: 12 },
    urlPolicy: { ok: true },
    selfTest: { state: 'passed' },
    ...extra
  });
  const level = (checks, id) => find(checks, id).level;

  test('marking hints are warnings, never errors', () => {
    const none = modelChecks({ id: 'a', provider: 'openai' }, context());
    expect(level(none, 'model.marking.text')).toBe('warn');
    const noStatement = modelChecks(
      { id: 'b', contentMarking: { text: { by: 'provider', scheme: 'synthid' } } },
      context()
    );
    expect(level(noStatement, 'model.marking.text')).toBe('warn');
    expect(find(noStatement, 'model.marking.text').fix.href).toBe('/admin/models/b');
    const withStatement = modelChecks(
      { id: 'c', contentMarking: { text: { by: 'provider', statementRef: 'doc' } } },
      context()
    );
    expect(level(withStatement, 'model.marking.text')).toBe('ok');
    expect(worstLevel(none.map(c => c.level))).toBe('warn');
  });

  test('image marking is checked where the model produces it; read-aloud audio is not marked', () => {
    const image = modelChecks({ id: 'i', supportsImageGeneration: true }, context());
    expect(level(image, 'model.marking.image')).toBe('warn');
    const tts = modelChecks(
      {
        id: 't',
        modelType: 'tts',
        contentMarking: { audio: { by: 'provider', statementRef: 's' } }
      },
      context()
    );
    expect(tts).toEqual([]);
    expect(modelChecks({ id: 's', modelType: 'transcription' }, context())).toEqual([]);
    // Only models marked "ihub" get the watermark chain.
    expect(find(image, 'model.watermark.key')).toBeUndefined();
  });

  test('the watermark chain: key, detector and self-test levels', () => {
    const model = ihubModel();
    const run = ctx => modelChecks(model, context(ctx));
    expect(level(run(), 'model.watermark.key')).toBe('ok');
    expect(level(run({ activeKeyId: null }), 'model.watermark.key')).toBe('error');
    expect(
      level(run({ probe: { reachable: false, error: 'network' } }), 'model.watermark.detector')
    ).toBe('error');
    expect(
      level(run({ probe: { reachable: true, authenticated: false } }), 'model.watermark.detector')
    ).toBe('error');
    expect(
      level(
        run({ probe: { reachable: true, authenticated: true, contractValid: false } }),
        'model.watermark.detector'
      )
    ).toBe('error');
    expect(
      level(run({ urlPolicy: { ok: false, reason: 'no http' } }), 'model.watermark.detector')
    ).toBe('error');
    expect(
      level(
        modelChecks(ihubModel({ detectorUrl: undefined }), context()),
        'model.watermark.detector'
      )
    ).toBe('error');
    for (const [state, expected] of [
      ['passed', 'ok'],
      ['failed', 'error'],
      ['inconclusive', 'warn'],
      ['stale', 'warn'],
      ['never', 'warn']
    ]) {
      expect(level(run({ selfTest: { state } }), 'model.watermark.selftest')).toBe(expected);
    }
  });

  test('every check has a stable id, a messageKey and an english message', () => {
    for (const check of modelChecks(ihubModel(), context())) {
      expect(check.id).toMatch(/^[a-z]+(\.[a-zA-Z]+)+$/);
      expect(check.messageKey).toMatch(/^admin\.euAiAct\.checks\./);
      expect(check.message.length).toBeGreaterThan(5);
      expect([LEVEL.OK, LEVEL.WARN, LEVEL.ERROR]).toContain(check.level);
    }
  });
});

describe('self-test store', () => {
  test('diagnoses map to states; a key change makes a pass stale, never a failure', async () => {
    expect(stateOfDiagnosis('keys_match')).toBe('passed');
    expect(stateOfDiagnosis('too_short')).toBe('inconclusive');
    for (const d of [
      'matches_retired_key',
      'no_watermark_found',
      'detector_unreachable',
      'not_applied',
      'no_keys'
    ]) {
      expect(stateOfDiagnosis(d)).toBe('failed');
    }
    await recordSelfTest('vl', { diagnosis: 'keys_match' }, { activeKeyId: 'wm-2026-1' });
    await recordSelfTest('x', { diagnosis: 'no_watermark_found' }, { activeKeyId: 'wm-2026-1' });
    const stored = await readSelfTests();
    expect(selfTestSummary(stored.vl, 'wm-2026-1').state).toBe('passed');
    expect(selfTestSummary(stored.vl, 'wm-2026-2').state).toBe('stale');
    expect(selfTestSummary(stored.x, 'wm-2026-2').state).toBe('failed');
    expect(selfTestSummary(undefined, 'wm-2026-2').state).toBe('never');
    expect(JSON.stringify(stored)).not.toMatch(/key"/);
  });
});

describe('detector probe', () => {
  test('answers from the cache for 30 s; refresh bypasses it but is rate limited', async () => {
    const model = ihubModel();
    let t = 1_000_000;
    const now = () => t;
    await probeDetector(model, { now });
    await probeDetector(model, { now });
    expect(mock.calls).toHaveLength(1);
    t += 6000;
    await probeDetector(model, { now, refresh: true });
    expect(mock.calls).toHaveLength(2);
    t += 1000;
    await probeDetector(model, { now, refresh: true });
    expect(mock.calls).toHaveLength(2);
    t += 31_000;
    await probeDetector(model, { now });
    expect(mock.calls).toHaveLength(3);
  });

  test('uses the short timeout and a throwaway key', async () => {
    const seen = [];
    await probeDetector(ihubModel(), {
      call: async args => {
        seen.push(args);
        return { latencyMs: 1 };
      }
    });
    expect(seen[0].timeoutMs).toBe(PROBE_TIMEOUT_MS);
    expect(seen[0].keys[0].keyId).toBe('probe');
  });

  test('no bare fetch in the feature (the SSL whitelist rule)', () => {
    const dir = path.join(path.dirname(fileURLToPath(import.meta.url)), '../services/euAiAct');
    for (const file of fs.readdirSync(dir)) {
      expect(fs.readFileSync(path.join(dir, file), 'utf8')).not.toMatch(
        /\bfetch\(|https?\.request\(/
      );
    }
  });
});

describe('GET /api/admin/eu-ai-act/status', () => {
  const get = (query = '') =>
    request(app).get(`/api/admin/eu-ai-act/status${query}`).set('x-role', 'admin');

  test('needs an admin', async () => {
    expect((await request(app).get('/api/admin/eu-ai-act/status')).status).toBe(401);
    expect(
      (await request(app).get('/api/admin/eu-ai-act/status').set('x-role', 'user')).status
    ).toBe(403);
  });

  test('no active key: error row and a problem in the summary', async () => {
    const res = await get();
    expect(res.status).toBe(200);
    expect(res.headers['cache-control']).toBe('no-store');
    expect(res.body.summary.level).toBe('error');
    expect(find(res.body.checks, 'model.watermark.key').level).toBe('error');
    expect(find(res.body.checks, 'model.watermark.detector').level).toBe('ok');
    expect(res.body.models[0]).toMatchObject({ modelId: 'vl', detector: { reachable: true } });
  });

  test('with a key and a passed self-test the model is green; a dead or rejecting detector is red', async () => {
    const created = await getWatermarkKeyStore().create({ key: KEY_VALUE }, 'a');
    await recordSelfTest('vl', { diagnosis: 'keys_match' }, { activeKeyId: created.item.keyId });
    const green = await get('?refresh=true');
    expect(
      green.body.checks
        .filter(c => c.modelId === 'vl' && c.id.startsWith('model.watermark'))
        .map(c => c.level)
    ).toEqual(['ok', 'ok', 'ok']);

    mock.setMode('401');
    const rejected = await get('?refresh=true');
    // within the 5 s refresh floor the cached answer is returned: wait it out by clearing.
    clearProbeCache();
    const rejected2 = await get('?refresh=true');
    expect(find(rejected2.body.checks, 'model.watermark.detector').level).toBe('error');
    expect(rejected.status).toBe(200);

    await mock.close();
    mock = await startMockDetector({ token: TOKEN });
    configCache.setCacheEntry('config/models.json', [
      ihubModel({ detectorUrl: 'http://127.0.0.1:1' })
    ]);
    clearProbeCache();
    const down = await get('?refresh=true');
    expect(find(down.body.checks, 'model.watermark.detector').level).toBe('error');
  });

  test('a refused URL is reported and never called', async () => {
    configCache.setCacheEntry('config/models.json', [
      ihubModel({ detectorUrl: 'http://169.254.169.254/x' })
    ]);
    const res = await get();
    expect(find(res.body.checks, 'model.watermark.detector').level).toBe('error');
    expect(mock.calls).toHaveLength(0);
  });

  test('disabled models are skipped and counted', async () => {
    configCache.setCacheEntry('config/models.json', [{ ...ihubModel(), enabled: false }]);
    const res = await get();
    expect(res.body.models).toEqual([]);
    expect(res.body.summary.skippedDisabledModels).toBe(1);
  });

  test('never contains a key value, a token or a credential', async () => {
    const created = await getWatermarkKeyStore().create({ key: KEY_VALUE }, 'a');
    setActiveKeyIdSnapshot(created.item.keyId);
    const res = await get('?refresh=true');
    const text = JSON.stringify(res.body);
    expect(text).not.toContain(KEY_VALUE);
    expect(text).not.toContain(TOKEN);
    expect(text).not.toMatch(/"(key|token|secret)"/);
  });

  test('acknowledgement counts and provenance settings are part of the answer', async () => {
    const res = await get();
    expect(res.body.acknowledgements).toMatchObject({ enabled: true, enforced: true });
    expect(res.body.acknowledgements.counts).toHaveProperty('total');
    expect(res.body.provenance.retentionDays).toBe(365);
    expect(
      res.body.summary.counts.error + res.body.summary.counts.warn + res.body.summary.counts.ok
    ).toBe(res.body.checks.length);
  });
});
