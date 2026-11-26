// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * Watermark keys held by the model image (`keyHolder: "model"`, RAG-1183): iHub
 * claims the mark without a key of its own, detects at the detection endpoint
 * built into each if-vllm image (with the model's API key, deciding with
 * Bonferroni as the Model Gateway does), or, when `provenance.watermark.gatewayUrl`
 * is set, at the installation's Model Gateway (bearer or OAuth2 client
 * credentials). No key value and no token reaches a request body or a log line.
 */
import { jest, describe, test, expect, beforeAll, afterAll, beforeEach } from '@jest/globals';

process.env.TOKEN_ENCRYPTION_KEY = 'f'.repeat(64);

const lines = [];
// Every line of the whole file, for the final check; `lines` is per test.
const allLines = [];
const capture = level => (message, meta) => {
  const line = JSON.stringify({ level, message, meta });
  lines.push(line);
  allLines.push(line);
};
jest.unstable_mockModule('../utils/logger.js', () => ({
  default: { info: capture('i'), warn: capture('w'), error: capture('e'), debug: capture('d') }
}));

const { default: configCache } = await import('../configCache.js');
const { startTestStorage } = await import('./helpers/testStorage.js');
const { startMockModelGateway } = await import('./helpers/mockModelGateway.js');
const { startMockModelDetector } = await import('./helpers/mockModelDetector.js');
const { default: configStore } = await import('../services/config/ConfigStore.js');
const { resetWatermarkKeyStore } =
  await import('../services/provenance/watermark/WatermarkKeyStore.js');
const { callGatewayDetector, callModelDetector, clearDetectorTokens } =
  await import('../services/provenance/watermark/DetectorClient.js');
const { pinnedDetectorLookup } =
  await import('../services/provenance/watermark/detectorUrlPolicy.js');
const { ClientCredentialsTokenCache } =
  await import('../services/integrations/auth/ServiceAccountAuth.js');
const {
  combineVerdicts,
  decideFromGateway,
  detectorConfigOf,
  detectWatermark,
  evaluateChecks,
  modelDetectorUrl,
  WATERMARK_STATUS
} = await import('../services/provenance/watermark/detect.js');
const { planTextWatermark } = await import('../services/provenance/watermark/watermarkPlan.js');
const { runSelfTest, pingDetector } = await import('../services/provenance/watermark/selfTest.js');
const { modelConfigSchema } = await import('../validators/modelConfigSchema.js');

const MODEL_KEY = 'vllm-api-key-test-123456';
const TOKEN = 'gateway-bearer-123456';
const OAUTH = { clientId: 'ihub', clientSecret: 'client-secret-987654', accessToken: 'jwt-abc' };
const TEXT = Array.from({ length: 200 }, (_, i) => `word${i}`).join(' ');
const SHORT = 'only a few words here';
// Never marked in a mock: the mocks remember marked texts across tests.
const UNMARKED = Array.from({ length: 200 }, (_, i) => `plain${i}`).join(' ');

let storage;
let image;
let gateway;
let oauthGateway;

function modelHeld({ url = image.chatUrl, extra = {} } = {}) {
  return {
    id: 'gemma',
    provider: 'local',
    modelId: 'org/model',
    url,
    apiKey: MODEL_KEY,
    contentMarking: { text: { by: 'ihub', scheme: 'vllm-gumbel', keyHolder: 'model', ...extra } }
  };
}

function configure({ model = modelHeld(), watermark = {} } = {}) {
  configCache.setCacheEntry('config/platform.json', {
    provenance: { watermark: { detectorTimeoutMs: 1000, ...watermark } }
  });
  configCache.setCacheEntry('config/models.json', [model]);
  return model;
}

const viaGateway = { gatewayUrl: () => gateway.url, gatewayCredentialRef: 'gw' };
const gatewaySettings = () => ({
  gatewayUrl: viaGateway.gatewayUrl(),
  gatewayCredentialRef: viaGateway.gatewayCredentialRef
});

beforeAll(async () => {
  storage = await startTestStorage({ prefix: 'ihub-wm-service-' });
  image = await startMockModelDetector({ apiKey: MODEL_KEY, keys: ['key-2026-11', 'key-2027-03'] });
  gateway = await startMockModelGateway({ token: TOKEN });
  oauthGateway = await startMockModelGateway({ oauth: OAUTH });
});
afterAll(async () => {
  await image.close();
  await gateway.close();
  await oauthGateway.close();
  await storage.stop();
});
beforeEach(async () => {
  for (const mock of [image, gateway, oauthGateway]) {
    mock.calls.length = 0;
    mock.setMode('ok');
  }
  gateway.tokenCalls.length = 0;
  oauthGateway.tokenCalls.length = 0;
  clearDetectorTokens();
  lines.length = 0;
  configCache.setCacheEntry('config/credentials.json', {
    credentials: {
      gw: { id: 'gw', type: 'bearer', token: TOKEN },
      'gw-oauth': {
        id: 'gw-oauth',
        type: 'oauth2',
        tokenUrl: oauthGateway.tokenUrl,
        clientId: OAUTH.clientId,
        clientSecret: OAUTH.clientSecret,
        grantType: 'client_credentials'
      },
      'gw-basic': { id: 'gw-basic', type: 'basic', username: 'u', password: 'p' }
    }
  });
  resetWatermarkKeyStore();
  // No iHub key at all: the image holds them.
  await configStore.writeJson('config/watermark-keys.json', { version: 1, nextSeq: {}, keys: [] });
});

describe('configuration', () => {
  test('the detection endpoint is derived from the chat URL, keeping a proxy prefix', () => {
    expect(modelDetectorUrl({ url: 'https://gpu-02.example/v1/chat/completions' })).toBe(
      'https://gpu-02.example/watermark/v1/detect'
    );
    expect(modelDetectorUrl({ url: 'https://proxy.example/gemma/v1/chat/completions' })).toBe(
      'https://proxy.example/gemma/watermark/v1/detect'
    );
    expect(modelDetectorUrl({ url: 'http://10.0.0.5:8000/v1' })).toBe(
      'http://10.0.0.5:8000/watermark/v1/detect'
    );
    expect(modelDetectorUrl({ url: 'not a url' })).toBeNull();
  });

  test('a model-held key detects at the image, or at the gateway once one is set', () => {
    const model = modelHeld({ url: 'https://gpu-02.example/v1/chat/completions' });
    expect(detectorConfigOf(model, { gatewayUrl: null })).toMatchObject({
      api: 'model',
      keyHolder: 'model',
      detectorUrl: 'https://gpu-02.example/watermark/v1/detect',
      credentialRef: null
    });
    expect(
      detectorConfigOf(modelHeld({ extra: { detectorUrl: 'https://other.example/detect' } }), {
        gatewayUrl: null
      }).detectorUrl
    ).toBe('https://other.example/detect');
    expect(
      detectorConfigOf(model, { gatewayUrl: 'https://gw.example/d', gatewayCredentialRef: 'gw' })
    ).toMatchObject({ api: 'gateway', detectorUrl: 'https://gw.example/d', credentialRef: 'gw' });
  });

  test('the schema refuses the settings of iHub detectors with a model-held key', () => {
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
      ...base,
      contentMarking: { text: { by: 'ihub', scheme: 'vllm-gumbel', ...extra } }
    });
    const ok = model => modelConfigSchema.safeParse(model).success;
    expect(ok(text({ keyHolder: 'model' }))).toBe(true);
    expect(ok(text({ keyHolder: 'model', detectorUrl: 'https://x.example/detect' }))).toBe(true);
    for (const field of [
      { tokenizer: 'org/tok' },
      { contextWidth: 4 },
      { detectorCredentialRef: 'c' },
      { prf: 'philox' }
    ]) {
      expect(ok(text({ keyHolder: 'model', ...field }))).toBe(false);
    }
    expect(ok(text({ keyHolder: 'other' }))).toBe(false);
    expect(ok({ ...base, contentMarking: { text: { by: 'provider', keyHolder: 'model' } } })).toBe(
      false
    );
  });

  test('the mark is claimed without an iHub key, and no key id is named', () => {
    const plan = planTextWatermark(modelHeld(), { temperature: 0.7 }, {}, null);
    expect(plan).toEqual({ by: 'ihub', scheme: 'vllm-gumbel', applied: true });
    // Greedy still cannot be marked.
    expect(planTextWatermark(modelHeld(), { temperature: 0 }, {}, null).applied).toBe(false);
  });
});

describe('evaluateChecks (Bonferroni, as the Model Gateway decides)', () => {
  const detector = { scheme: 'vllm-gumbel' };
  const settings = { alpha: 1e-4, minScoredTokens: 200 };
  const check = (keyLabel, pValue, numScoredTokens = 300, algorithm = 'gumbel') => ({
    keyLabel,
    algorithm,
    parameters: { context_width: 4, prf: 'philox' },
    pValue,
    numScoredTokens
  });
  const outcome = checks => ({ detector, checks, tokenizer: 't', vllmVersion: '0.34.0' });

  test('the strongest check times the number of checks must be below alpha', () => {
    // 3e-5 x 2 = 6e-5 < 1e-4: detected, as with the text generated on gpu-02.
    expect(
      evaluateChecks([outcome([check('spike', 3e-5), check('spike', 0.7, 300, 'dual')])], settings)
    ).toMatchObject({
      status: WATERMARK_STATUS.DETECTED,
      keyLabel: 'spike',
      algorithm: 'gumbel',
      pValue: 6e-5,
      checksMade: 2,
      scoredTokens: 300
    });
    // 3e-5 x 4 = 1.2e-4: not below alpha any more.
    const four = [
      check('a', 3e-5),
      check('a', 0.7, 300, 'd'),
      check('b', 0.5),
      check('b', 0.6, 300, 'd')
    ];
    expect(evaluateChecks([outcome(four)], settings)).toMatchObject({
      status: WATERMARK_STATUS.NOT_DETECTED,
      checksMade: 4
    });
  });

  test('a check two images report identically counts once; another result twice', () => {
    const same = [check('k', 3e-5), check('k', 0.7, 300, 'd')];
    expect(evaluateChecks([outcome(same), outcome(same)], settings)).toMatchObject({
      status: WATERMARK_STATUS.DETECTED,
      checksMade: 2,
      detectorsChecked: 2
    });
    const other = [check('k', 0.4), check('k', 0.7, 300, 'd')];
    expect(evaluateChecks([outcome(same), outcome(other)], settings).checksMade).toBe(3);
  });

  test('as the gateway since RAG-1190: not the key label or vLLM version, p up to rounding', () => {
    // One key under two file names, from images of two vLLM versions: one check.
    const a = { ...outcome([check('key-2026-11', 3e-5)]), vllmVersion: '0.34.0' };
    const b = { ...outcome([check('current', 3e-5 * (1 + 1e-9))]), vllmVersion: '0.35.0' };
    expect(evaluateChecks([a, b], settings)).toMatchObject({
      checksMade: 1,
      keyLabel: 'key-2026-11'
    });
    // A detector that names no tokenizer shares no check with another one.
    const bare = url => ({
      detector: { ...detector, detectorUrl: url },
      checks: [check('k', 3e-5)]
    });
    expect(evaluateChecks([bare('https://a'), bare('https://b')], settings).checksMade).toBe(2);
  });

  test('checks in one bucket give the same verdict in any order', () => {
    // Both p-values round to the same ln p bucket but lie on either side of alpha.
    const below = check('k', 0.999999999e-4);
    const above = check('k', 1.000000001e-4);
    const verdicts = [
      [below, above],
      [above, below]
    ].map(pair => evaluateChecks([outcome([pair[0]]), outcome([pair[1]])], settings));
    expect(verdicts.map(verdict => verdict.checksMade)).toEqual([1, 1]);
    expect(verdicts.map(verdict => verdict.status)).toEqual(['detected', 'detected']);
    expect(verdicts[0].pValue).toBe(verdicts[1].pValue);
  });

  test('too short, a detector down, or not detected', () => {
    expect(evaluateChecks([outcome([check('k', 0.3, 50)])], settings).status).toBe('too_short');
    // An image that answers without results is down, as for the gateway.
    expect(evaluateChecks([outcome([check('k', 0.3)]), outcome([])], settings).status).toBe(
      'unavailable'
    );
    expect(
      evaluateChecks([outcome([check('k', 0.3)]), { detector, error: new Error('x') }], settings)
        .status
    ).toBe('unavailable');
    expect(evaluateChecks([outcome([check('k', 0.3)])], settings)).toMatchObject({
      status: 'not_detected',
      pValue: 0.3
    });
    // A detection holds even with a detector down.
    expect(
      evaluateChecks([outcome([check('k', 1e-9)]), { detector, error: new Error('x') }], settings)
        .status
    ).toBe('detected');
  });
});

describe('callModelDetector', () => {
  test('sends the text only, with the model API key, and reads one check per key and algorithm', async () => {
    image.markText(TEXT, 'key-2026-11');
    const answer = await callModelDetector({ url: image.detectUrl, apiKey: MODEL_KEY, text: TEXT });
    expect(image.calls[0].body).toEqual({ text: TEXT });
    expect(image.calls[0].headers.authorization).toBe(`Bearer ${MODEL_KEY}`);
    expect(answer.tokenizer).toBe('org/model@abc1234');
    expect(answer.checks).toHaveLength(4);
    expect(answer.checks[0]).toMatchObject({
      keyLabel: 'key-2026-11',
      algorithm: 'gumbel',
      pValue: 1e-9,
      numScoredTokens: 260
    });
  });

  test.each([
    ['401', 'unauthorized'],
    ['500', 'http_error'],
    ['badContract', 'bad_response']
  ])('mode %s is unreachable with reason %s', async (mode, reason) => {
    image.setMode(mode);
    await expect(
      callModelDetector({ url: image.detectUrl, apiKey: MODEL_KEY, text: TEXT })
    ).rejects.toMatchObject({ code: 'WATERMARK_DETECTOR_UNREACHABLE', details: { reason } });
  });
});

describe('callGatewayDetector', () => {
  test('sends the text only, with the bearer token, and reads the verdict', async () => {
    gateway.markText(TEXT, 'key-2026-11');
    const answer = await callGatewayDetector({ url: gateway.url, credentialRef: 'gw', text: TEXT });
    expect(gateway.calls[0].body).toEqual({ text: TEXT });
    expect(gateway.calls[0].headers.authorization).toBe(`Bearer ${TOKEN}`);
    expect(answer).toMatchObject({
      verdict: 'DETECTED',
      gatewayVersion: '6.9.0',
      schemes: [
        {
          verdict: 'DETECTED',
          // The first reporter names the key file; every reporter is kept.
          strongestResult: {
            detector: 'gemma',
            keyLabel: 'key-2026-11',
            reportedBy: [
              { detector: 'gemma', keyLabel: 'key-2026-11' },
              { detector: 'gemma-image', keyLabel: 'current' }
            ]
          },
          tests: 2
        }
      ]
    });
  });

  test('logs in with OAuth2 client credentials and reuses the token', async () => {
    await callGatewayDetector({ url: oauthGateway.url, credentialRef: 'gw-oauth', text: TEXT });
    await callGatewayDetector({ url: oauthGateway.url, credentialRef: 'gw-oauth', text: TEXT });
    expect(oauthGateway.tokenCalls).toHaveLength(1);
    expect(oauthGateway.calls.map(call => call.headers.authorization)).toEqual([
      'Bearer jwt-abc',
      'Bearer jwt-abc'
    ]);
  });

  const withOauthCredential = patch =>
    configCache.setCacheEntry('config/credentials.json', {
      credentials: {
        'gw-oauth': {
          id: 'gw-oauth',
          type: 'oauth2',
          tokenUrl: oauthGateway.tokenUrl,
          clientId: OAUTH.clientId,
          clientSecret: OAUTH.clientSecret,
          grantType: 'client_credentials',
          ...patch
        }
      }
    });

  test('the token request goes to the address the URL check accepted, not a new DNS answer', async () => {
    // "token.invalid" never resolves in DNS: the mock is reached only through the
    // address the URL check accepted (loopback, which the detector policy allows).
    const port = new URL(oauthGateway.tokenUrl).port;
    withOauthCredential({ tokenUrl: `http://token.invalid:${port}/oauth/token` });
    const resolve = async host => {
      if (host !== 'token.invalid') throw new Error(`unexpected lookup of ${host}`);
      return ['127.0.0.1'];
    };
    await callGatewayDetector({
      url: oauthGateway.url,
      credentialRef: 'gw-oauth',
      text: TEXT,
      resolve
    });
    expect(oauthGateway.tokenCalls).toHaveLength(1);
    expect(oauthGateway.calls).toHaveLength(1);
  });

  test('a token request pinned to another accepted address does not reach the server', async () => {
    // The check accepts 127.0.0.2; "localhost" would resolve to the mock on 127.0.0.1.
    const port = new URL(oauthGateway.tokenUrl).port;
    withOauthCredential({ tokenUrl: `http://localhost:${port}/oauth/token` });
    const error = await callGatewayDetector({
      url: oauthGateway.url,
      credentialRef: 'gw-oauth',
      text: TEXT,
      timeoutMs: 1000,
      resolve: async () => ['127.0.0.2']
    }).catch(caught => caught);
    // Refused by the connection, not by the URL check.
    expect(error).toMatchObject({ code: 'WATERMARK_DETECTOR_UNREACHABLE' });
    expect(['token', 'timeout']).toContain(error.details.reason);
    expect(oauthGateway.tokenCalls).toHaveLength(0);
    expect(oauthGateway.calls).toHaveLength(0);
  });

  test('the pinned lookup keeps loopback and drops forbidden addresses', async () => {
    const lookup = (addresses, options) =>
      new Promise((resolve, reject) =>
        pinnedDetectorLookup(addresses)('detector', options, (error, address) =>
          error ? reject(error) : resolve(address)
        )
      );
    await expect(lookup(['127.0.0.1'], {})).resolves.toBe('127.0.0.1');
    await expect(lookup(['169.254.169.254', '10.0.0.5'], {})).resolves.toBe('10.0.0.5');
    await expect(lookup(['169.254.169.254'], {})).rejects.toMatchObject({ code: 'ENOTFOUND' });
  });

  test('a token the detector rejects is dropped from the cache', async () => {
    await callGatewayDetector({ url: oauthGateway.url, credentialRef: 'gw-oauth', text: TEXT });
    oauthGateway.setMode('401');
    await expect(
      callGatewayDetector({ url: oauthGateway.url, credentialRef: 'gw-oauth', text: TEXT })
    ).rejects.toMatchObject({ details: { reason: 'unauthorized' } });
    oauthGateway.setMode('ok');
    await callGatewayDetector({ url: oauthGateway.url, credentialRef: 'gw-oauth', text: TEXT });
    expect(oauthGateway.tokenCalls).toHaveLength(2);
  });

  test('dropping a rejected token keeps a newer one', async () => {
    const cache = new ClientCredentialsTokenCache();
    await cache.getToken('k', async () => ({ access_token: 'old' }));
    cache.invalidate('k', 'old');
    await cache.getToken('k', async () => ({ access_token: 'new' }));
    // A late rejection of the old token must not evict the new one.
    cache.invalidate('k', 'old');
    await expect(cache.getToken('k', async () => ({ access_token: 'newer' }))).resolves.toBe('new');
  });

  test('a token request that hangs ends with the deadline of the detector call', async () => {
    const http = await import('node:http');
    const silent = http.createServer(() => {});
    await new Promise(resolve => silent.listen(0, '127.0.0.1', resolve));
    try {
      withOauthCredential({ tokenUrl: `http://127.0.0.1:${silent.address().port}/oauth/token` });
      const started = Date.now();
      await expect(
        callGatewayDetector({
          url: oauthGateway.url,
          credentialRef: 'gw-oauth',
          text: TEXT,
          timeoutMs: 300
        })
      ).rejects.toMatchObject({ details: { reason: 'timeout' } });
      expect(Date.now() - started).toBeLessThan(5000);
      expect(oauthGateway.calls).toHaveLength(0);
    } finally {
      silent.closeAllConnections?.();
      await new Promise(resolve => silent.close(resolve));
    }
  });

  test('a refused detector URL is reported as such, before any token request', async () => {
    await expect(
      callGatewayDetector({
        url: 'ftp://gateway.example/detect',
        credentialRef: 'gw-oauth',
        text: TEXT
      })
    ).rejects.toMatchObject({ details: { reason: 'url_refused' } });
    expect(oauthGateway.tokenCalls).toHaveLength(0);
  });

  test('a changed client secret fetches a new token instead of the cached one', async () => {
    await callGatewayDetector({ url: oauthGateway.url, credentialRef: 'gw-oauth', text: TEXT });
    withOauthCredential({ clientSecret: 'rotated-secret' });
    await expect(
      callGatewayDetector({ url: oauthGateway.url, credentialRef: 'gw-oauth', text: TEXT })
    ).rejects.toMatchObject({ details: { reason: 'token' } });
    expect(oauthGateway.tokenCalls).toHaveLength(2);
  });

  test('refuses a credential that is not a token or an OAuth2 client', async () => {
    await expect(
      callGatewayDetector({ url: gateway.url, credentialRef: 'gw-basic', text: TEXT })
    ).rejects.toMatchObject({ code: 'WATERMARK_DETECTOR_NOT_CONFIGURED' });
    expect(gateway.calls).toHaveLength(0);
  });

  test.each([
    ['unavailable', 'http_error'],
    ['badContract', 'bad_response']
  ])('mode %s is unreachable with reason %s', async (mode, reason) => {
    gateway.setMode(mode);
    await expect(
      callGatewayDetector({ url: gateway.url, credentialRef: 'gw', text: TEXT })
    ).rejects.toMatchObject({ details: { reason } });
  });

  test('the verdict maps onto iHub statuses', () => {
    const answer = (verdict, reasons = []) => ({
      verdict,
      alpha: 0.01,
      textSha256: 'a'.repeat(64),
      detectedAt: '2026-11-23T10:00:00Z',
      gatewayVersion: '6.9.0',
      schemes: [{ scheme: 'vllm', verdict, unclearReasons: reasons }]
    });
    const detector = { scheme: 'vllm-gumbel' };
    expect(decideFromGateway(answer('NOT_DETECTED'), { detector })).not.toHaveProperty(
      'checksMade'
    );
    expect(decideFromGateway(answer('NOT_DETECTED'), { detector }).status).toBe('not_detected');
    expect(
      decideFromGateway(answer('UNCLEAR', ['TOO_FEW_SCORED_TOKENS']), { detector }).status
    ).toBe('too_short');
    expect(
      decideFromGateway(answer('UNCLEAR', ['DETECTOR_UNAVAILABLE']), { detector }).status
    ).toBe('unavailable');
    expect(
      combineVerdicts([{ status: 'unavailable' }, { status: 'detected', pValue: 1e-9 }]).status
    ).toBe('detected');
    // A route that could not decide keeps a negative of another route open.
    expect(combineVerdicts([{ status: 'not_detected' }, { status: 'unavailable' }]).status).toBe(
      'unavailable'
    );
    // "Too short" outranks a route that could not answer.
    expect(combineVerdicts([{ status: 'too_short' }, { status: 'unavailable' }]).status).toBe(
      'too_short'
    );
  });

  test('a gateway detection names no key file of a scheme that did not detect', () => {
    const result = {
      keyLabel: 'other-key',
      algorithm: 'gumbel',
      pValue: 0.4,
      numScoredTokens: 300
    };
    const answer = {
      verdict: 'DETECTED',
      alpha: 0.01,
      textSha256: 'a'.repeat(64),
      detectedAt: '2026-11-23T10:00:00Z',
      gatewayVersion: '6.9.0',
      schemes: [
        { scheme: 'a', verdict: 'DETECTED', unclearReasons: [] },
        { scheme: 'b', verdict: 'NOT_DETECTED', unclearReasons: [], strongestResult: result }
      ]
    };
    const verdict = decideFromGateway(answer, { detector: { scheme: 'vllm-gumbel' } });
    expect(verdict.status).toBe('detected');
    expect(verdict).not.toHaveProperty('keyLabel');
    expect(verdict).not.toHaveProperty('pValue');
  });
});

describe('detectWatermark with a model-held key', () => {
  test('asks the image with the model API key and names the key file', async () => {
    configure();
    image.markText(TEXT, 'key-2027-03');
    const result = await detectWatermark(TEXT);
    expect(result).toMatchObject({
      status: 'detected',
      keyLabel: 'key-2027-03',
      pValue: 4e-9,
      checksMade: 4,
      source: 'model'
    });
    expect(result.keyId).toBeUndefined();
    expect(image.calls[0].headers.authorization).toBe(`Bearer ${MODEL_KEY}`);
  });

  test('a short text is too short; an image that does not answer is unavailable', async () => {
    configure();
    expect((await detectWatermark(SHORT)).status).toBe('too_short');
    image.setMode('500');
    expect((await detectWatermark(TEXT)).status).toBe('unavailable');
  });

  test('with a gateway set, the gateway decides and the image is not asked', async () => {
    configure({ watermark: gatewaySettings() });
    gateway.markText(TEXT, 'key-2026-11');
    expect(await detectWatermark(TEXT)).toMatchObject({
      status: 'detected',
      keyLabel: 'key-2026-11',
      checksMade: 2,
      source: 'gateway',
      gateway: { gatewayVersion: '6.9.0' }
    });
    expect(image.calls).toHaveLength(0);
  });
});

describe('ping and self-test with a model-held key', () => {
  const llmClient = text => ({
    complete: async () => ({ content: text, marking: { text: { by: 'ihub', applied: true } } })
  });

  test('the ping sends the sentence only to the image and checks the contract', async () => {
    const model = configure();
    expect(await pingDetector(model)).toMatchObject({
      reachable: true,
      authenticated: true,
      contractValid: true
    });
    expect(Object.keys(image.calls[0].body)).toEqual(['text']);
    image.setMode('401');
    expect(await pingDetector(model)).toMatchObject({ reachable: true, authenticated: false });
  });

  test('watermark_found with the key file, without any iHub key', async () => {
    const model = configure();
    image.markText(TEXT, 'key-2026-11');
    expect(await runSelfTest(model, { llmClient: llmClient(TEXT) })).toMatchObject({
      ok: true,
      diagnosis: 'watermark_found',
      matchedKeyLabel: 'key-2026-11'
    });
  });

  test('no_watermark_found, too_short and detector_unreachable', async () => {
    const model = configure();
    expect((await runSelfTest(model, { llmClient: llmClient(UNMARKED) })).diagnosis).toBe(
      'no_watermark_found'
    );
    expect((await runSelfTest(model, { llmClient: llmClient(SHORT) })).diagnosis).toBe('too_short');
    image.setMode('500');
    expect((await runSelfTest(model, { llmClient: llmClient(TEXT) })).diagnosis).toBe(
      'detector_unreachable'
    );
  });

  test('through the gateway: watermark_found', async () => {
    const model = configure({ watermark: gatewaySettings() });
    gateway.markText(TEXT, 'key-2026-11');
    expect(await runSelfTest(model, { llmClient: llmClient(TEXT) })).toMatchObject({
      ok: true,
      diagnosis: 'watermark_found',
      matchedKeyLabel: 'key-2026-11'
    });
  });

  test('no line logged in this file holds a key, a token or a client secret', () => {
    const logged = allLines.join('\n');
    expect(allLines.length).toBeGreaterThan(0);
    for (const secret of [MODEL_KEY, TOKEN, OAUTH.accessToken, OAUTH.clientSecret]) {
      expect(logged).not.toContain(secret);
    }
  });
});
